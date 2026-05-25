import { describe, it, expect, beforeEach } from 'vitest';
import { setIO, getIO } from './socket.manager.js';

describe('socket.manager', () => {
  beforeEach(() => setIO(null as any));

  it('getIO throws before setIO', () => {
    expect(() => getIO()).toThrow('Socket.io not initialized');
  });

  it('getIO returns the instance after setIO', () => {
    const fake = { emit: () => {} } as any;
    setIO(fake);
    expect(getIO()).toBe(fake);
  });
});
