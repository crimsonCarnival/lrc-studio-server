import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import mongoose from 'mongoose'
import { MongoMemoryServer } from 'mongodb-memory-server'
import Project, { MAX_PROJECT_COLLABORATORS } from '../projects/project.model.js'
import User from '../users/user.model.js'
import { cleanGuestName, creditCollaborator, loadProjectCredits, transferGuestCredit } from './collab-credits.service.js'
import { removeProjectCollaborator } from './collab.service.js'
import { deriveErrorCode } from '../../graphql/error-code.js'
import { loaders } from '../../graphql/loaders.js'

const PUBLIC_ID = 'credproj01'
let mongo: MongoMemoryServer
let ownerId: string

type Loader = (q: Array<{ obj: Record<string, unknown> }>, ctx: { userId: string | null }) => Promise<Array<Array<Record<string, unknown>>>>
const collaboratorsField = (viewer: string | null, publicId = PUBLIC_ID) =>
  (loaders as unknown as { Project: { collaborators: { loader: Loader } } }).Project.collaborators
    .loader([{ obj: { publicId } }], { userId: viewer }).then((r) => r[0])

async function mkUser(extra: Record<string, unknown> = {}): Promise<string> {
  const n = new mongoose.Types.ObjectId().toString().slice(-6)
  const res = await User.collection.insertOne({
    accountName: `u${n}`, displayName: `User ${n}`, email: `${n}@x.test`, passwordHash: 'x',
    isDeleted: false, role: 'user', permissions: [], ban: { active: false }, ...extra,
  })
  return res.insertedId.toString()
}

const guestP = (id: string, name = id) => ({ subject: `guest:${id}`, name })
const credits = async () => ((await Project.findOne({ publicId: PUBLIC_ID }).lean())!.collaborators ?? [])

async function codeOf(p: Promise<unknown>): Promise<string | undefined> {
  try {
    await p
  } catch (err) {
    return deriveErrorCode(err)
  }
  throw new Error('expected a rejection')
}

beforeAll(async () => {
  mongo = await MongoMemoryServer.create()
  await mongoose.connect(mongo.getUri())
}, 120_000)
afterAll(async () => {
  await mongoose.disconnect()
  await mongo.stop()
})
beforeEach(async () => {
  await Promise.all([Project.deleteMany({}), User.deleteMany({})])
  ownerId = await mkUser()
  await Project.collection.insertOne({ publicId: PUBLIC_ID, userId: new mongoose.Types.ObjectId(ownerId), title: 'T', slug: 't', public: true })
})

describe('creditCollaborator', () => {
  it('records a subject once', async () => {
    await creditCollaborator(PUBLIC_ID, guestP('a'))
    await creditCollaborator(PUBLIC_ID, guestP('a'))
    expect(await credits()).toHaveLength(1)
  })

  it('stops at the cap', async () => {
    for (let i = 0; i < MAX_PROJECT_COLLABORATORS + 3; i++) await creditCollaborator(PUBLIC_ID, guestP(`g${i}`))
    expect(await credits()).toHaveLength(MAX_PROJECT_COLLABORATORS)
  })

  it('skips a removed subject', async () => {
    await Project.updateOne({ publicId: PUBLIC_ID }, { $set: { removedCollaborators: ['guest:gone'] } })
    await creditCollaborator(PUBLIC_ID, guestP('gone'))
    expect(await credits()).toHaveLength(0)
  })
})

describe('Project.collaborators', () => {
  it('resolves users by current name, guests by typed name, oldest first, and hides banned, shadow-banned and deleted users', async () => {
    const good = await mkUser({ displayName: 'Renamed Later' })
    const banned = await mkUser({ ban: { active: true } })
    const shadow = await mkUser({ shadowBan: { search: true } })
    const deleted = await mkUser({ isDeleted: true })
    await creditCollaborator(PUBLIC_ID, guestP('g1', 'Guesty'))
    for (const id of [banned, shadow, deleted, good]) {
      await new Promise((r) => setTimeout(r, 5))
      await creditCollaborator(PUBLIC_ID, { subject: `user:${id}`, name: 'stale name' })
    }
    const out = await collaboratorsField(null)
    expect(out.map((c) => [c.id, c.name, c.isGuest])).toEqual([
      ['guest:g1', 'Guesty', true],
      [`user:${good}`, 'Renamed Later', false],
    ])
    expect(out[0].user).toBeNull()
    expect((out[1].user as { _id: { toString(): string } })._id.toString()).toBe(good)
  })

  it('is empty for a viewer who cannot read a private project, but not for its owner', async () => {
    await creditCollaborator(PUBLIC_ID, guestP('a'))
    await Project.updateOne({ publicId: PUBLIC_ID }, { $set: { public: false } })
    expect(await collaboratorsField(null)).toEqual([])
    expect(await collaboratorsField(await mkUser())).toEqual([])
    expect(await collaboratorsField(ownerId)).toHaveLength(1)
  })

  it('loadProjectCredits returns nothing for an unknown project', async () => {
    expect((await loadProjectCredits(['nope'])).size).toBe(0)
  })
})

describe('removeProjectCollaborator', () => {
  it('lets the owner remove a credit, remembers it, and blocks re-adding', async () => {
    await creditCollaborator(PUBLIC_ID, guestP('a'))
    expect(await removeProjectCollaborator(PUBLIC_ID, 'guest:a', ownerId)).toBe(true)
    expect(await credits()).toHaveLength(0)
    await creditCollaborator(PUBLIC_ID, guestP('a'))
    expect(await credits()).toHaveLength(0)
    const p = await Project.findOne({ publicId: PUBLIC_ID }).lean()
    expect(p!.removedCollaborators).toEqual(['guest:a'])
  })

  it('removing twice succeeds both times and records the subject once', async () => {
    await creditCollaborator(PUBLIC_ID, guestP('a'))
    expect(await removeProjectCollaborator(PUBLIC_ID, 'guest:a', ownerId)).toBe(true)
    expect(await removeProjectCollaborator(PUBLIC_ID, 'guest:a', ownerId)).toBe(true)
    expect((await Project.findOne({ publicId: PUBLIC_ID }).lean())!.removedCollaborators ?? []).toEqual(['guest:a'])
  })

  it('refuses a subject that was never credited, and records nothing', async () => {
    expect(await codeOf(removeProjectCollaborator(PUBLIC_ID, 'guest:never', ownerId))).toBe('not_found')
    expect((await Project.findOne({ publicId: PUBLIC_ID }).lean())!.removedCollaborators ?? []).toEqual([])
  })

  it('refuses a non-owner, a signed-out caller, an unknown project and a malformed id', async () => {
    await creditCollaborator(PUBLIC_ID, guestP('a'))
    expect(await codeOf(removeProjectCollaborator(PUBLIC_ID, 'guest:a', await mkUser()))).toBe('forbidden')
    expect(await codeOf(removeProjectCollaborator(PUBLIC_ID, 'guest:a', null))).toBe('unauthorized')
    expect(await codeOf(removeProjectCollaborator('missing001', 'guest:a', ownerId))).toBe('not_found')
    expect(await codeOf(removeProjectCollaborator(PUBLIC_ID, 'whatever', ownerId))).toBe('not_found')
    expect(await credits()).toHaveLength(1)
  })
})

describe('guest names', () => {
  it('strips markup, control and bidi characters, and trims', () => {
    expect(cleanGuestName('  <b>Ann</b>\u202E\u0007 Lee\u2066 ')).toBe('Ann Lee')
    expect(cleanGuestName('\u202E\u0000 ')).toBeNull()
  })

  it('stores the cleaned name and omits a guest whose name cleans to nothing', async () => {
    await creditCollaborator(PUBLIC_ID, guestP('a', '<i>Zed</i>\u202E'))
    await creditCollaborator(PUBLIC_ID, guestP('b', '\u202E\u2066'))
    expect((await credits()).map((c) => c.guestName)).toEqual(['Zed', null])
    expect((await collaboratorsField(null)).map((c) => c.name)).toEqual(['Zed'])
  })
})

describe('transferGuestCredit', () => {
  const G = 'guest:g1'
  const removed = async () => (await Project.findOne({ publicId: PUBLIC_ID }).lean())!.removedCollaborators ?? []
  const seed = (set: Record<string, unknown>) => Project.collection.updateOne({ publicId: PUBLIC_ID }, { $set: set }, { upsert: true })

  beforeEach(async () => {
    await seed({ userId: new mongoose.Types.ObjectId(ownerId), collaborators: [], removedCollaborators: [] })
  })

  it('rewrites the credit to the account, keeping when it was first earned, without touching updatedAt', async () => {
    const u = await mkUser()
    const firstContributedAt = new Date('2026-01-02T00:00:00Z')
    const updatedAt = new Date('2026-01-03T00:00:00Z')
    await seed({ updatedAt, collaborators: [{ subject: G, userId: null, guestName: 'Ana', firstContributedAt }] })
    await transferGuestCredit(PUBLIC_ID, G, u, false)
    const [c, ...rest] = await credits()
    expect(rest).toEqual([])
    expect(c).toMatchObject({ subject: `user:${u}`, guestName: null, firstContributedAt })
    expect(c.userId!.toString()).toBe(u)
    expect((await Project.findOne({ publicId: PUBLIC_ID }).lean())!.updatedAt).toEqual(updatedAt)
  })

  it('an account already credited just loses the guest credit', async () => {
    const u = await mkUser()
    await seed({ collaborators: [
      { subject: G, userId: null, guestName: 'Ana', firstContributedAt: new Date() },
      { subject: `user:${u}`, userId: new mongoose.Types.ObjectId(u), guestName: null, firstContributedAt: new Date() },
    ] })
    await transferGuestCredit(PUBLIC_ID, G, u, false)
    expect((await credits()).map((c) => c.subject)).toEqual([`user:${u}`])
  })

  it('the owner just loses the guest credit, and is never credited', async () => {
    await seed({ collaborators: [{ subject: G, userId: null, guestName: 'Ana', firstContributedAt: new Date() }] })
    await transferGuestCredit(PUBLIC_ID, G, ownerId, true)
    expect(await credits()).toEqual([])
  })

  it("the owner's removal of the guest follows the account: it can never be credited", async () => {
    const u = await mkUser()
    await seed({ removedCollaborators: [G] })
    await transferGuestCredit(PUBLIC_ID, G, u, false)
    expect(await removed()).toEqual([G, `user:${u}`])
    await creditCollaborator(PUBLIC_ID, { subject: `user:${u}`, name: 'x' })
    expect(await credits()).toEqual([])
  })

  it("a guest credit earned by an account the owner already removed does not bring that account back", async () => {
    const u = await mkUser()
    await seed({ removedCollaborators: [`user:${u}`], collaborators: [{ subject: G, userId: null, guestName: 'Ana', firstContributedAt: new Date() }] })
    await transferGuestCredit(PUBLIC_ID, G, u, false)
    expect(await credits()).toEqual([])
    expect(await removed()).toEqual([`user:${u}`])
  })

  it('the owner signing in is not added to the removed list', async () => {
    await seed({ removedCollaborators: [G] })
    await transferGuestCredit(PUBLIC_ID, G, ownerId, true)
    expect(await removed()).toEqual([G])
  })

  it('a guest with no credit leaves the project alone', async () => {
    const u = await mkUser()
    await transferGuestCredit(PUBLIC_ID, G, u, false)
    expect(await credits()).toEqual([])
    expect(await removed()).toEqual([])
  })
})
