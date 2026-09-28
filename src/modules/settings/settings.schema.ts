export const settingsBodySchema = {
  type: 'object',
  properties: {
    playback: { type: 'object' },
    editor: { type: 'object' },
    export: { type: 'object' },
    interface: { type: 'object' },
    shortcuts: { type: 'object' },
    advanced: { type: 'object' },
  },
  additionalProperties: false,
};