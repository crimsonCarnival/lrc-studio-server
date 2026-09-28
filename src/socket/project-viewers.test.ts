import { describe, it, expect, beforeEach } from 'vitest';
import {
  isValidPublicId,
  addViewer,
  removeViewer,
  removeSocket,
  getViewerSummary,
  resetViewers,
  MAX_PROJECTS_PER_SOCKET,
} from './project-viewers.js';

beforeEach(() => resetViewers());

describe('isValidPublicId', () => {
  // Review Focus 5
  it('accepts a nanoid-shaped id and rejects junk', () => {
    expect(isValidPublicId('aBcDeF1234')).toBe(true);
    expect(isValidPublicId('')).toBe(false);
    expect(isValidPublicId('   ')).toBe(false);
    expect(isValidPublicId('x'.repeat(33))).toBe(false);
    expect(isValidPublicId(42)).toBe(false);
    expect(isValidPublicId(null)).toBe(false);
    expect(isValidPublicId(undefined)).toBe(false);
    expect(isValidPublicId({ toString: () => 'abc' })).toBe(false);
    expect(isValidPublicId('has space')).toBe(false);
    expect(isValidPublicId('has/slash')).toBe(false);
  });
});

describe('viewer registry', () => {
  it('summarises signed-in and anonymous viewers separately', () => {
    addViewer('proj-aaaaa', 's1', 'user-1');
    addViewer('proj-aaaaa', 's2');
    addViewer('proj-aaaaa', 's3');

    const summary = getViewerSummary('proj-aaaaa');
    expect(summary.userIds).toEqual(['user-1']);
    expect(summary.anonymousCount).toBe(2);
  });

  // Review Focus 2
  it('counts one person once across multiple tabs', () => {
    addViewer('proj-aaaaa', 's1', 'user-1');
    addViewer('proj-aaaaa', 's2', 'user-1');
    addViewer('proj-aaaaa', 's3', 'user-1');

    expect(getViewerSummary('proj-aaaaa')).toEqual({ userIds: ['user-1'], anonymousCount: 0 });

    // Closing two of the three tabs must NOT remove the person.
    removeViewer('proj-aaaaa', 's1');
    removeViewer('proj-aaaaa', 's2');
    expect(getViewerSummary('proj-aaaaa').userIds).toEqual(['user-1']);

    removeViewer('proj-aaaaa', 's3');
    expect(getViewerSummary('proj-aaaaa')).toEqual({ userIds: [], anonymousCount: 0 });
  });

  it('keeps projects isolated from one another', () => {
    addViewer('proj-aaaaa', 's1', 'user-1');
    addViewer('proj-bbbbb', 's2', 'user-2');

    expect(getViewerSummary('proj-aaaaa').userIds).toEqual(['user-1']);
    expect(getViewerSummary('proj-bbbbb').userIds).toEqual(['user-2']);
  });

  it('reports an empty summary for a project nobody is viewing', () => {
    expect(getViewerSummary('proj-zzzzz')).toEqual({ userIds: [], anonymousCount: 0 });
  });

  // Review Focus 4
  it('evicts a socket from every project it was viewing and names them', () => {
    addViewer('proj-aaaaa', 's1', 'user-1');
    addViewer('proj-bbbbb', 's1', 'user-1');
    addViewer('proj-bbbbb', 's2', 'user-2');

    const affected = removeSocket('s1').sort();
    expect(affected).toEqual(['proj-aaaaa', 'proj-bbbbb']);
    expect(getViewerSummary('proj-aaaaa')).toEqual({ userIds: [], anonymousCount: 0 });
    expect(getViewerSummary('proj-bbbbb').userIds).toEqual(['user-2']);
  });

  it('is idempotent on removal of an unknown socket', () => {
    expect(removeSocket('never-seen')).toEqual([]);
    expect(() => removeViewer('proj-aaaaa', 'never-seen')).not.toThrow();
  });

  it('treats a re-join after full teardown as fresh', () => {
    addViewer('proj-aaaaa', 's1', 'user-1');
    removeViewer('proj-aaaaa', 's1');
    // Whether the empty Map entry was pruned or left in place is not observable
    // through this public API — both produce the same output here. That pruning
    // itself is verified by inspection, not by this test.
    addViewer('proj-aaaaa', 's2');
    expect(getViewerSummary('proj-aaaaa')).toEqual({ userIds: [], anonymousCount: 1 });
  });

  it('caps distinct projects per socket without affecting other sockets', () => {
    for (let i = 0; i < MAX_PROJECTS_PER_SOCKET + 1; i++) {
      addViewer(`proj-${i}`, 's1');
    }
    // A different socket is unaffected by s1's cap.
    addViewer('proj-other', 's2');

    let tracked = 0;
    for (let i = 0; i < MAX_PROJECTS_PER_SOCKET + 1; i++) {
      if (getViewerSummary(`proj-${i}`).anonymousCount === 1) tracked++;
    }
    expect(tracked).toBe(MAX_PROJECTS_PER_SOCKET);
    // The 21st project was refused, so its socket was never registered.
    expect(getViewerSummary(`proj-${MAX_PROJECTS_PER_SOCKET}`)).toEqual({ userIds: [], anonymousCount: 0 });
    expect(getViewerSummary('proj-other')).toEqual({ userIds: [], anonymousCount: 1 });
  });
});
