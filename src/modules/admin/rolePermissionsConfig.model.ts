import mongoose from 'mongoose';

// Singleton document holding admin-edited overrides of ROLE_PRESETS
// (server/src/shared/permissions.ts). Only 'mod' and 'admin' are editable —
// 'user' is always empty and 'superadmin' always holds every permission by
// design, so neither is stored here. Read at authorization time via
// getEffectiveRolePresets(); when this document doesn't exist (or a field is
// unset), the code-defined ROLE_PRESETS value is the fallback — the code
// constants remain the seed/source of truth, this collection only overrides.
const rolePermissionsConfigSchema = new mongoose.Schema(
  {
    _id: { type: String, default: 'singleton' },
    mod: { type: [String], default: undefined },
    admin: { type: [String], default: undefined },
  },
  { timestamps: true, collection: 'role_permissions_configs', _id: false }
);

export default mongoose.model('RolePermissionsConfig', rolePermissionsConfigSchema);
