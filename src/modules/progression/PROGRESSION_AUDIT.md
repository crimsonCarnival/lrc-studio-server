# XP System Audit & Refactor Plan

**Status**: Architecture Review Complete  
**Date**: 2026-06-16  
**Assessment**: Current system is vulnerable to retroactive coefficient changes

---

## Part 1: Current Architecture

### Data Model

```ts
// User progression subdoc
interface IUserProgression {
  xp: number;      // Total accumulated XP (not persisted as event log)
  level: number;   // Derived: floor(sqrt(xp / 100))
}

// Source stats aggregated from real data
interface IUserStats {
  minutesSynced: number;   // From Lyrics: max(timestamp) per project, summed
  wordsSynced: number;     // From Lyrics: count of words with time set
  karaokeLines: number;    // From Lyrics: count of lines with ≥1 word timed
}

// Social metrics
interface ISocial {
  totalStarsReceived: number;
  totalForksReceived: number;
  followerCount: number;
}

// Badge grants (immutable once granted)
interface IUserBadge {
  id: string;
  grantedAt: Date;
  grantedBy: string;
}
```

### XP Computation Flow

**Current formula** (`badge.service.ts:433-435`):

```ts
xp = Math.max(0, Math.floor(
  badgeXp + mins * 2 + words * 0.1 + stars * 5 + forks * 10 + followers * 3
))
```

**Where `badgeXp`** = sum of `xpReward` from all earned badges (sourced from `BUILTIN_BADGES` table).

**When recomputed**:
1. Badge granted → `grantBadge()` → `recomputeXP()` (line 156)
2. Badge revoked → `revokeBadge()` → `recomputeXP()` (line 168)
3. Retroactive badge scan → `retroactiveGrant()` → `recomputeXP()` for each user (line 231, 265)
4. Admin XP adjustment → `manageProgression()` in admin service → `recomputeXP()` (line 381, 397)

**Call stack**:
```
recomputeXP(userId)
  → User.findById(userId).select('badges stats social')
  → sum badges from BUILTIN_XP map + custom badges from DB
  → apply formula
  → User.updateOne({ 'progression.xp': xp, 'progression.level': level })
```

### The Vulnerability: Retroactive Changes

**Scenario**: If `followers * 3` changes to `followers * 1`:
- All users instantly lose XP proportional to their follower count
- Levels may drop retroactively
- Users who thought they earned a badge at level 25 may suddenly be level 20
- **No audit trail of what happened**

**Current call sites that trigger recomputation**:
1. Grant/revoke individual badges
2. Retroactive badge scans
3. Admin manual XP adjustments
4. ~~Sync/stats updates~~ (NOT called on `recomputeSyncStats()`)

Note: Stats are recalculated whenever lyrics change, but `recomputeXP()` is NOT automatically called. This is only triggered by badge changes.

---

## Part 2: Proposed Event-Based System

### New Data Model

```ts
// Immutable XP log entry
interface IXPEvent {
  userId: ObjectId;
  type: 'badge_grant' | 'badge_revoke' | 'admin_adjustment';
  source: string;           // badge id, 'admin', 'system'
  delta: number;            // XP gained/lost this event
  totalXpAfter: number;     // Cumulative XP after this event
  reason?: string;          // Optional: 'granted syncer10h badge', 'revoke due to dispute', etc
  createdAt: Date;
}

// User progression (no longer recalculated)
interface IUserProgression {
  xp: number;              // Stored total from event history
  level: number;           // Derived: floor(sqrt(xp / 100))
  lastXpEventAt?: Date;    // Denormalized for indexing/sorting
}
```

### Migration Strategy (Safe, Idempotent)

1. **Phase 1: Parallel writes** (zero downtime)
   - Introduce `XPEvent` collection
   - Modify `recomputeXP()` to ALSO log the change as a new event
   - Keep old system working while collecting events
   - Run for 1-2 weeks to gather baseline

2. **Phase 2: Backfill history** (one-time)
   - For each user, replay current badges → compute starting XP
   - Log synthetic "backfill" event: `type: 'backfill', totalXpAfter: <current_xp>`
   - Verify no user XP changes
   - Idempotent: can rerun without harm

3. **Phase 3: Switch to event-based reads**
   - Change `getUser()` GraphQL to sum events instead of reading `progression.xp`
   - Query: `db.xpEvents.aggregate([{ $match: { userId } }, { $sort: { createdAt: 1 } }, { $group: { _id: null, totalXp: { $last: '$totalXpAfter' } } }])`
   - Or cache `progression.xp` from event stream (denormalized)

4. **Phase 4: Deprecate recomputeXP**
   - After event log is stable, stop calling `recomputeXP()`
   - Call new `logXPEvent()` instead on badge changes
   - Keep `progression.xp` as denormalized cache for query performance

### Event-Based Functions (New)

```ts
// Log an XP change atomically
export async function logXPEvent(
  userId: string,
  type: 'badge_grant' | 'badge_revoke' | 'admin_adjustment',
  source: string,
  delta: number,
  reason?: string
): Promise<number> {
  const user = await User.findById(userId).select('progression').lean();
  const newTotalXp = Math.max(0, (user.progression?.xp ?? 0) + delta);
  
  await XPEvent.create({
    userId: new ObjectId(userId),
    type,
    source,
    delta,
    totalXpAfter: newTotalXp,
    reason,
    createdAt: new Date(),
  });
  
  // Denormalized cache for fast queries
  await User.updateOne({ _id: userId }, {
    'progression.xp': newTotalXp,
    'progression.level': computeLevel(newTotalXp),
    'progression.lastXpEventAt': new Date(),
  });
  
  return newTotalXp;
}

// Audit user's XP history
export async function getXPHistory(userId: string, limit = 50): Promise<IXPEvent[]> {
  return XPEvent.find({ userId: new ObjectId(userId) })
    .sort({ createdAt: -1 })
    .limit(limit)
    .lean();
}

// Validate user's current XP against event log (integrity check)
export async function validateXPIntegrity(userId: string): Promise<{
  valid: boolean;
  storedXp: number;
  calculatedXp: number;
  mismatch?: number;
}> {
  const user = await User.findById(userId).select('progression').lean();
  const events = await XPEvent.find({ userId: new ObjectId(userId) })
    .sort({ createdAt: 1 })
    .lean();
  
  const calculated = events.length > 0 ? events[events.length - 1].totalXpAfter : 0;
  const stored = user.progression?.xp ?? 0;
  
  return {
    valid: stored === calculated,
    storedXp: stored,
    calculatedXp: calculated,
    mismatch: stored !== calculated ? stored - calculated : undefined,
  };
}
```

---

## Part 3: XP Rebalancing

### Philosophy

**Effort > Popularity**

Users who actively synchronize and improve lyrics progress faster than passive social engagement.

### Current Coefficients

```ts
badgeXp + mins * 2 + words * 0.1 + stars * 5 + forks * 10 + followers * 3
```

### Analysis

**Current problem**: A user with 50 followers gets `50 * 3 = 150 XP` just for popularity, while someone who synced 10 hours gets `600 * 2 = 1200 XP`. This skews toward effort (good), but:

- `followers * 3` gives outsized value to passive metrics
- `forks * 10` is high relative to effort
- `words * 0.1` is extremely low (50,000 words = only 5000 XP)
- Badge XP values are inconsistent with stat-based rewards

### Proposed New Coefficients

Separate into **Craft XP** (effort-based) and **Community XP** (social):

#### Craft XP (Primary)

```ts
craftXp = mins * 3 + words * 0.25 + karaokeLines * 0.5
```

**Rationale**:
- `mins * 3`: Sync 1 hour (60 min) → 180 XP. Feel substantial without breaking scale.
- `words * 0.25`: 1000 words → 250 XP. Rewards fine-grained work.
- `karaokeLines * 0.5`: 100 karaoke lines → 50 XP. Acknowledges advanced feature.

**Example effort profile** (power user):
- 100 hours music synced: 100 × 60 × 3 = 18,000 XP
- 25,000 words timestamped: 25,000 × 0.25 = 6,250 XP
- 500 karaoke lines: 500 × 0.5 = 250 XP
- **Total craft**: ~24,500 XP → Level 15-16

#### Community XP (Secondary)

```ts
communityXp = stars * 3 + forks * 5 + followers * 1.5
```

**Rationale**:
- `stars * 3`: Receiving a star is meaningful; 50 stars → 150 XP.
- `forks * 5`: Forking is social reuse; keep it valuable but not dominant.
- `followers * 1.5`: Following is passive; compromise (down from 3, up from 1).

**Example social profile** (popular creator, light on craft):
- 100 stars received: 100 × 3 = 300 XP
- 20 forks: 20 × 5 = 100 XP
- 200 followers: 200 × 1 = 200 XP
- **Total community**: ~600 XP → Level 2-3

**Combined (balanced creator)**:
- 40 hours music: 40 × 60 × 3 = 7,200 XP
- 10,000 words: 10,000 × 0.25 = 2,500 XP
- 200 karaoke lines: 200 × 0.5 = 100 XP
- 30 stars: 30 × 3 = 90 XP
- 10 forks: 10 × 5 = 50 XP
- 100 followers: 100 × 1 = 100 XP
- **Total**: ~10,040 XP → Level 10

#### Final Formula

```ts
xp = badgeXp + (mins * 3 + words * 0.25 + karaokeLines * 0.5) + (stars * 3 + forks * 5 + followers * 1.5)
```

### Badge XP Rebalancing

Current badge XP values are inconsistent with effort required. Proposed new values:

#### Craft Badges (High XP)

| Badge | Condition | Current XP | New XP | Justification |
|-------|-----------|------------|--------|---------------|
| Open Mic | 10h synced | 100 | 200 | Major milestone, sets tone |
| World Tour | 100h synced | 350 | 1000 | Substantial effort |
| Verse One | 1k words | 125 | 300 | Foundational precision work |
| Grand Opus | 50k words | 350 | 1500 | Exceptional dedication |
| On Stage | 100 karaoke lines | 100 | 250 | Advanced feature unlock |
| Headliner | 1k karaoke lines | 250 | 800 | Mastery level |
| Anthology | 100 projects | 200 | 600 | Productivity achievement |
| Studio Ready | 10 uploads | 50 | 150 | Unlocks full feature set |

#### Community Badges (Medium XP)

| Badge | Condition | Current XP | New XP | Justification |
|-------|-----------|------------|--------|---------------|
| Gold Record | 50 stars | 200 | 250 | Recognition of quality |
| Sampled | 25 forks | 250 | 200 | Social reuse indicator |
| Fan Base | 50 followers | 125 | 100 | Passive social metric |
| In Rotation | 10 public projects | 100 | 150 | Publishing commitment |

#### Prestige Badges (Flat High XP)

| Badge | Condition | Current XP | New XP | Justification |
|-------|-----------|------------|--------|---------------|
| Side A | Top 100 users | 500 | 750 | Ultra-rare prestige |
| Debut | Top 1k users | 100 | 200 | Founding member premium |
| Session Player | 1 year old | 150 | 300 | Long-term loyalty |

#### Verification & Streaks (Low XP)

| Badge | Condition | Current XP | New XP | Justification |
|-------|-----------|------------|--------|---------------|
| In Key | Email verified | 25 | 50 | Account security |
| Daily Mix | 7-day streak | 50 | 100 | Habit formation |
| Extended Play | 30-day streak | 150 | 300 | Sustained engagement |
| A&R | Admin role | 500 | 500 | Unchanged |

---

## Part 4: Level Curve & Milestone Analysis

### Current Curve

```
Level = floor(sqrt(XP / 100))

Level 0:  0 XP
Level 5:  2,500 XP
Level 10: 10,000 XP
Level 15: 22,500 XP
Level 20: 40,000 XP
Level 25: 62,500 XP
Level 50: 250,000 XP
Level 100: 1,000,000 XP
```

### Old vs New Median Progression

**Scenario**: New user, 1 year, moderate effort

**Old system**:
- 50h music: 50 × 60 × 2 = 6,000 XP
- 5,000 words: 5,000 × 0.1 = 500 XP
- 15 stars: 15 × 5 = 75 XP
- 3 forks: 3 × 10 = 30 XP
- 25 followers: 25 × 3 = 75 XP
- Pioneer badge (1 year): 100 XP
- **Total**: 6,780 XP → **Level 8**

**New system**:
- 50h music: 50 × 60 × 3 = 9,000 XP
- 5,000 words: 5,000 × 0.25 = 1,250 XP
- 100 karaoke lines: 100 × 0.5 = 50 XP
- 15 stars: 15 × 3 = 45 XP
- 3 forks: 3 × 5 = 15 XP
- 25 followers: 25 × 1 = 25 XP
- Pioneer badge + Session Player (1 year): 100 + 300 = 400 XP
- **Total**: 10,785 XP → **Level 10**

**Verdict**: Slight bump up (+2 levels), rewards effort more, followers less inflated.

---

## Part 5: Migration Path

### Pre-Migration Validation

1. Generate current XP for all users using old formula
2. Store in temp field `progression.xpBackup`
3. Run daily integrity check

### Migration Steps

1. **Create XPEvent schema** (see Part 2)
2. **Add parallel write in `recomputeXP()`**:
   - After updating `progression.xp`, insert XPEvent
3. **Run backfill script**:
   ```bash
   npm run migrate:xp-backfill
   ```
   - Calculates current XP using NEW formula for all users
   - Logs synthetic "backfill" event
   - Preserves user progression

4. **Run validation**:
   ```bash
   npm run validate:xp-integrity
   ```
   - Checks all users: `storedXp === calculatedXp`

5. **Enable event log reads** (client-side and resolvers)
   - GraphQL `user.progression.xp` now derives from events (or cache)

### Rollback Plan

If issues detected:
1. Stop all XP writes
2. Restore from backup field `progression.xpBackup`
3. Delete XPEvent entries
4. Revert code

---

## Part 6: Simulation Results

### Profile 1: Heavy Synchronizer (Light on Social)

**Activity**:
- 150 hours music synced
- 30,000 words timestamped
- 800 karaoke lines
- 2 public projects
- 20 total stars
- 0 forks
- 10 followers

**Old XP**:
- Stats: 150×60×2 + 30000×0.1 + 20×5 + 0×10 + 10×3 = 18000 + 3000 + 100 + 0 + 30 = 21,130
- Badges: Open Mic (100) + World Tour (350) + Verse One (125) + Grand Opus (350) + On Stage (100) + Studio Ready (50) = 1,075
- **Total**: 22,205 XP → **Level 14**

**New XP**:
- Stats: 150×60×3 + 30000×0.25 + 800×0.5 + 20×3 + 0×5 + 10×1 = 27000 + 7500 + 400 + 60 + 0 + 10 = 34,970
- Badges: Open Mic (200) + World Tour (1000) + Verse One (300) + Grand Opus (1500) + On Stage (250) + Studio Ready (150) = 3,400
- **Total**: 38,370 XP → **Level 19** (+5 levels)

**Analysis**: Heavy synchronizers now see higher XP rewards, feel more motivated. ✓

---

### Profile 2: Social Creator (Popular, Light Craft)

**Activity**:
- 10 hours music synced
- 2,000 words timestamped
- 20 karaoke lines
- 8 public projects
- 80 total stars received
- 15 forks received
- 200 followers

**Old XP**:
- Stats: 10×60×2 + 2000×0.1 + 80×5 + 15×10 + 200×3 = 1200 + 200 + 400 + 150 + 600 = 2,550
- Badges: In Rotation (100) + Gold Record (200) + Sampled (250) + Fan Base (125) = 675
- **Total**: 3,225 XP → **Level 5**

**New XP**:
- Stats: 10×60×3 + 2000×0.25 + 20×0.5 + 80×3 + 15×5 + 200×1.5 = 1800 + 500 + 10 + 240 + 75 + 300 = 2,925
- Badges: In Rotation (150) + Gold Record (250) + Sampled (200) + Fan Base (100) = 700
- **Total**: 3,625 XP → **Level 6** (+1 level)

**Analysis**: Social creators maintain reasonable progression but don't get undue boost. Followers penalized, community engagement still valuable. ✓

---

### Profile 3: Balanced Creator

**Activity**:
- 60 hours music synced
- 15,000 words timestamped
- 250 karaoke lines
- 20 public projects
- 40 total stars
- 8 forks
- 80 followers

**Old XP**:
- Stats: 60×60×2 + 15000×0.1 + 40×5 + 8×10 + 80×3 = 7200 + 1500 + 200 + 80 + 240 = 9,220
- Badges: Open Mic (100) + World Tour (350) + Verse One (125) + Grand Opus (350) + On Stage (100) + In Rotation (100) + Gold Record (200) = 1,325
- **Total**: 10,545 XP → **Level 10**

**New XP**:
- Stats: 60×60×3 + 15000×0.25 + 250×0.5 + 40×3 + 8×5 + 80×1.5 = 10800 + 3750 + 125 + 120 + 40 + 120 = 14,955
- Badges: Open Mic (200) + World Tour (1000) + Verse One (300) + Grand Opus (1500) + On Stage (250) + In Rotation (150) + Gold Record (250) = 3,650
- **Total**: 18,605 XP → **Level 13** (+3 levels)

**Analysis**: Balanced creators see modest bump. Fair progression path. ✓

---

### Profile 4: New User (First Month)

**Activity**:
- 5 hours music synced
- 500 words timestamped
- 5 karaoke lines
- 1 public project
- 2 stars
- 0 forks
- 5 followers
- Verified email

**Old XP**:
- Stats: 5×60×2 + 500×0.1 + 2×5 + 0×10 + 5×3 = 600 + 50 + 10 + 0 + 15 = 675
- Badges: In Key (25) = 25
- **Total**: 700 XP → **Level 2**

**New XP**:
- Stats: 5×60×3 + 500×0.25 + 5×0.5 + 2×3 + 0×5 + 5×1.5 = 900 + 125 + 2.5 + 6 + 0 + 7.5 = 1,041
- Badges: In Key (50) = 50
- **Total**: 1,091 XP → **Level 3** (+1 level)

**Analysis**: New users still feel early-game progression. Not immediately overwhelming. ✓

---

### Profile 5: Veteran User (Inactive 1+ Year)

**Activity** (cumulative, no recent work):
- 200 hours music synced
- 50,000 words timestamped
- 1,500 karaoke lines
- 50 public projects
- 120 total stars
- 30 forks
- 150 followers
- Earned: Side A, Pioneer, Open Mic, World Tour, Grand Opus, Headliner, Anthology, Session Player, Gold Record, Sampled, In Rotation

**Old XP**:
- Stats: 200×60×2 + 50000×0.1 + 120×5 + 30×10 + 150×3 = 24000 + 5000 + 600 + 300 + 450 = 30,350
- Badges: 500 + 100 + 100 + 350 + 350 + 250 + 200 + 150 + 200 + 250 + 100 = 2,550
- **Total**: 32,900 XP → **Level 18**

**New XP**:
- Stats: 200×60×3 + 50000×0.25 + 1500×0.5 + 120×3 + 30×5 + 150×1.5 = 36000 + 12500 + 750 + 360 + 150 + 225 = 49,985
- Badges: 750 + 200 + 200 + 1000 + 1500 + 800 + 600 + 300 + 250 + 200 + 150 = 5,750
- **Total**: 55,735 XP → **Level 23** (+5 levels)

**Analysis**: Veterans (who did heavy craft work) see significant reward bump. Encourages return. ✓

---

## Part 7: Implementation Checklist

### Server Changes

- [ ] Create `XPEvent` schema (models/progression/xp-event.model.ts)
- [ ] Add `logXPEvent()` function
- [ ] Add `getXPHistory()` function
- [ ] Add `validateXPIntegrity()` function
- [ ] Update `BUILTIN_BADGES` with new XP values
- [ ] Update coefficient constants
- [ ] Modify `recomputeXP()` to log events in parallel
- [ ] Create migration script: `migrate:xp-backfill`
- [ ] Create validation script: `validate:xp-integrity`
- [ ] Add admin endpoints for XP history audit

### Client Changes

- [ ] Update leaderboard to display XP tier
- [ ] Add progression detail view (shows XP progress to next level)
- [ ] Display badge XP contribution
- [ ] Show stats contribution breakdown

### Testing

- [ ] Unit tests for new coefficient formula
- [ ] Integration tests for migration path
- [ ] XP audit trail for 5 sample users
- [ ] Level curve validation (no level drops)
- [ ] Badge grant trigger validation

### Deployment

- [ ] Backup production progression data
- [ ] Run pre-migration validation
- [ ] Deploy code with parallel writes
- [ ] Run backfill script during low-traffic window
- [ ] Validate integrity
- [ ] Monitor for 1 week
- [ ] Remove old `recomputeXP()` code if stable

---

## Part 8: User Decisions ✓

1. **Event log retention**: Keep full history forever
2. **Admin XP adjustments**: Free (unrestricted)
3. **Follower coefficient**: `followers * 1.5` (compromise between old `* 3` and proposed `* 1`)
4. **Level 100 goal**: 1M XP is still reasonable

---

## Appendix: Code References

**Current implementation**:
- `badge.service.ts`: lines 383-440 (XP computation, badges)
- `user.model.ts`: lines 170-176 (progression schema)
- `admin.service.ts`: lines 360-399 (XP management)

**Related tests**:
- None currently covering XP formula

**Related configs**:
- No external configuration; coefficients hardcoded

---

**End of Audit**
