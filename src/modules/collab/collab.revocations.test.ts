import { describe, it, expect } from 'vitest'
import { createRevocationLog } from './collab.revocations.js'

function setup(maxEntries = 100) {
  let t = 1000
  const log = createRevocationLog({ ttlMs: 60_000, maxEntries, now: () => t })
  return { log, advance: (ms: number) => { t += ms } }
}

describe('revocation log', () => {
  it('a revocation after the capture counts, for that key only', () => {
    const { log } = setup()
    const capture = log.capture()
    log.revoke('user:a')
    expect(log.revokedSince(capture, ['user:a'])).toBe(true)
    expect(log.revokedSince(capture, ['user:b', 'ip:1'])).toBe(false)
  })

  it('a revocation before the capture does not count: that auth read the new state', () => {
    const { log } = setup()
    log.revoke('user:a')
    expect(log.revokedSince(log.capture(), ['user:a'])).toBe(false)
  })

  it('a capture older than the TTL fails safe, since its entries may be gone', () => {
    const { log, advance } = setup()
    const capture = log.capture()
    advance(60_000)
    expect(log.revokedSince(capture, ['user:a'])).toBe(true)
  })

  it('stays within its bound, and a capture older than an evicted entry fails safe', () => {
    const { log } = setup(3)
    const before = log.capture()
    for (const k of ['a', 'b', 'c', 'd', 'e']) log.revoke(k)
    expect(log.size()).toBe(3)
    expect(log.revokedSince(before, ['unrelated'])).toBe(true)
    expect(log.revokedSince(log.capture(), ['unrelated'])).toBe(false)
  })

  it('expired entries are pruned as new ones arrive', () => {
    const { log, advance } = setup()
    log.revoke('a')
    log.revoke('b')
    advance(60_000)
    log.revoke('c')
    expect(log.size()).toBe(1)
  })
})
