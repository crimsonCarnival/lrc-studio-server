import { describe, it, expect } from 'vitest';
import { ROLE_PRESETS } from './permissions.js';

describe('catalog permissions in role presets', () => {
  it('admin preset has catalog.review and catalog.manage', () => {
    expect(ROLE_PRESETS.admin).toContain('catalog.review');
    expect(ROLE_PRESETS.admin).toContain('catalog.manage');
  });

  it('mod preset has neither', () => {
    expect(ROLE_PRESETS.mod).not.toContain('catalog.review');
    expect(ROLE_PRESETS.mod).not.toContain('catalog.manage');
    expect(ROLE_PRESETS.user).toEqual([]);
  });

  it('superadmin has both', () => {
    expect(ROLE_PRESETS.superadmin).toContain('catalog.review');
    expect(ROLE_PRESETS.superadmin).toContain('catalog.manage');
  });
});
