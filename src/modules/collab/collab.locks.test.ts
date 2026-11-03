import { describe, expect, it } from 'vitest'
import { createLockTable, type LockHolder } from './collab.locks.js'

const alice: LockHolder = { conn: 'c1', subject: 'u1', name: 'Alice', colorIndex: 1 }
const bob: LockHolder = { conn: 'c2', subject: 'u2', name: 'Bob', colorIndex: 2 }
const aliceTab2: LockHolder = { conn: 'c3', subject: 'u1', name: 'Alice', colorIndex: 1 }

function setup() {
  let t = 1000
  const table = createLockTable({ idleMs: 30_000, now: () => t })
  return { table, advance: (ms: number) => (t += ms) }
}

describe('lock table', () => {
  it('first acquire wins', () => {
    const { table } = setup()
    expect(table.acquire('d', 'l1', alice)).toEqual({ ok: true })
  })

  it('second conn gets {ok:false, holder}', () => {
    const { table } = setup()
    table.acquire('d', 'l1', alice)
    expect(table.acquire('d', 'l1', bob)).toEqual({ ok: false, holder: alice })
  })

  it('same conn re-acquire is ok and extends expiry', () => {
    const { table, advance } = setup()
    table.acquire('d', 'l1', alice)
    advance(20_000)
    expect(table.acquire('d', 'l1', alice)).toEqual({ ok: true })
    advance(20_000) // 40s after first acquire, 20s after re-acquire
    expect(table.acquire('d', 'l1', bob).ok).toBe(false)
  })

  it('same subject different conn is denied', () => {
    const { table } = setup()
    table.acquire('d', 'l1', alice)
    expect(table.acquire('d', 'l1', aliceTab2)).toEqual({ ok: false, holder: alice })
  })

  it('expired lock is acquirable by another conn', () => {
    const { table, advance } = setup()
    table.acquire('d', 'l1', alice)
    advance(30_000)
    expect(table.acquire('d', 'l1', bob)).toEqual({ ok: true })
    expect(table.snapshot('d')).toEqual({ l1: bob })
  })

  it('release by non-holder returns false and keeps lock', () => {
    const { table } = setup()
    table.acquire('d', 'l1', alice)
    expect(table.release('d', 'l1', 'c2')).toBe(false)
    expect(table.snapshot('d')).toEqual({ l1: alice })
    expect(table.release('d', 'l1', 'c1')).toBe(true)
    expect(table.snapshot('d')).toEqual({})
  })

  it('refresh extends only the conn\'s own locks', () => {
    const { table, advance } = setup()
    table.acquire('d', 'l1', alice)
    table.acquire('d', 'l2', bob)
    advance(20_000)
    table.refresh('d', ['l1', 'l2'], 'c1')
    advance(15_000)
    expect(Object.keys(table.snapshot('d'))).toEqual(['l1'])
  })

  it('releaseAllFor frees only that conn\'s lines', () => {
    const { table } = setup()
    table.acquire('d', 'l1', alice)
    table.acquire('d', 'l2', alice)
    table.acquire('d', 'l3', bob)
    expect(table.releaseAllFor('d', 'c1').sort()).toEqual(['l1', 'l2'])
    expect(table.snapshot('d')).toEqual({ l3: bob })
  })

  it('releaseSubject frees every conn of the subject', () => {
    const { table } = setup()
    table.acquire('d', 'l1', alice)
    table.acquire('d', 'l2', aliceTab2)
    table.acquire('d', 'l3', bob)
    expect(table.releaseSubject('d', 'u1').sort()).toEqual(['l1', 'l2'])
    expect(table.snapshot('d')).toEqual({ l3: bob })
  })

  it('forceRelease frees a line regardless of holder', () => {
    const { table } = setup()
    table.acquire('d', 'l1', alice)
    expect(table.forceRelease('d', 'l1')).toBe(true)
    expect(table.forceRelease('d', 'l1')).toBe(false)
  })

  it('sweep removes expired and reports the doc', () => {
    const { table, advance } = setup()
    table.acquire('d1', 'l1', alice)
    advance(15_000)
    table.acquire('d2', 'l1', bob)
    advance(15_000)
    expect(table.sweep()).toEqual(['d1'])
    expect(table.snapshot('d1')).toEqual({})
    expect(table.snapshot('d2')).toEqual({ l1: bob })
    expect(table.sweep()).toEqual([])
  })

  it('snapshot omits expiresAt', () => {
    const { table } = setup()
    table.acquire('d', 'l1', alice)
    expect(table.snapshot('d').l1).not.toHaveProperty('expiresAt')
  })

  it('clearDoc drops all locks for the doc', () => {
    const { table } = setup()
    table.acquire('d', 'l1', alice)
    table.clearDoc('d')
    expect(table.snapshot('d')).toEqual({})
  })
})
