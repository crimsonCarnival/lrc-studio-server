import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import mongoose from 'mongoose';
import { MongoMemoryReplSet } from 'mongodb-memory-server';
import { Server } from 'socket.io';
import { createAdapter } from '@socket.io/mongo-adapter';

// Proves the Mongo adapter actually carries messages between two separate
// Socket.IO server instances — the whole point of adding it. Two things
// here are worth verifying rather than assuming:
//
//  1. @socket.io/mongo-adapter declares `"mongodb": "*"` as a plain
//     dependency, so pnpm first gave it its own mongodb@7 copy while
//     mongoose uses ~6.20. package.json now pins that nested dep to match
//     mongoose, so one driver instance serves both — but the collection
//     handed to the adapter still comes from mongoose, so the pairing is
//     worth exercising for real.
//  2. The adapter needs change streams (replica set). MongoMemoryReplSet
//     provides them; a standalone mongod does not, which is why
//     setupSocketAdapter in socket.ts fails soft.
//
// serverSideEmit travels the same adapter path as a room broadcast, so it
// is a valid proof of cross-instance delivery without needing a client.

const COLLECTION = 'socket_io_adapter_events';

let repl: MongoMemoryReplSet;
let ioA: Server;
let ioB: Server;

beforeAll(async () => {
  repl = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  await mongoose.connect(repl.getUri());
  const db = mongoose.connection.db!;
  const collection = db.collection(COLLECTION);
  await collection.createIndex({ createdAt: 1 }, { expireAfterSeconds: 3600 });

  // Two independent Server instances sharing one collection — what two app
  // instances behind a load balancer look like to the adapter.
  ioA = new Server();
  ioB = new Server();
  ioA.adapter(createAdapter(collection, { addCreatedAtField: true }));
  ioB.adapter(createAdapter(collection, { addCreatedAtField: true }));
}, 90000);

afterAll(async () => {
  // Not io.close(): these Servers were constructed without an http server,
  // so socket.io's close() dereferences an undefined httpServer. What
  // actually needs releasing is each adapter's change stream and heartbeat
  // timer — left running, they keep the event loop alive and the run hangs
  // until vitest force-exits.
  for (const io of [ioA, ioB]) {
    await io.of('/').adapter.close();
  }
  await mongoose.disconnect();
  await repl.stop();
});

describe('Socket.IO mongo adapter', () => {
  it('delivers a server-to-server message from one instance to the other', async () => {
    const received = new Promise<unknown>((resolve) => {
      ioB.on('cross-instance-probe', (payload: unknown) => resolve(payload));
    });

    // Small delay so B's change stream is watching before A writes.
    await new Promise((r) => setTimeout(r, 300));
    ioA.serverSideEmit('cross-instance-probe', { hello: 'from-A' });

    const payload = await Promise.race([
      received,
      new Promise((_, reject) => setTimeout(() => reject(new Error('timed out — adapter did not deliver across instances')), 10000)),
    ]);
    expect(payload).toEqual({ hello: 'from-A' });
  }, 20000);

  it('writes its traffic to the expected collection', async () => {
    const count = await mongoose.connection.db!.collection(COLLECTION).countDocuments();
    // Heartbeats plus the probe above — the point is that the adapter is
    // genuinely using this collection, not that the count is a specific
    // number.
    expect(count).toBeGreaterThan(0);
  });
});
