import { describe, it, expect } from 'vitest';
import { buildSchema, getVariableValues, parse, validate, type OperationDefinitionNode } from 'graphql';
import { flattenSettingsUpdate } from './settings.update.js';
import { schemaString } from '../../graphql/schema/index.js';
import Settings from './settings.model.js';

describe('flattenSettingsUpdate', () => {
  it('turns nested groups into dotted per-field paths', () => {
    expect(flattenSettingsUpdate({ export: { includeFeaturedInTitle: true }, playback: { autoRewindOnPause: { enabled: false } } }))
      .toEqual({ 'export.includeFeaturedInTitle': true, 'playback.autoRewindOnPause.enabled': false });
  });

  it('keeps arrays and null as whole values and drops undefined', () => {
    expect(flattenSettingsUpdate({ playback: { speedPresets: [1, 1.5], muted: null, volume: undefined } }))
      .toEqual({ 'playback.speedPresets': [1, 1.5], 'playback.muted': null });
  });

  it('an empty input sets nothing, and omitted siblings are not mentioned', () => {
    expect(flattenSettingsUpdate({})).toEqual({});
    expect(Object.keys(flattenSettingsUpdate({ export: { stripEmptyLines: true } }))).toEqual(['export.stripEmptyLines']);
  });
});

describe('settings GraphQL schema: includeFeaturedInTitle', () => {
  const schema = buildSchema(schemaString);
  const errors = (source: string) => validate(schema, parse(source)).map((e) => e.message);

  it('is selectable on the export settings type', () => {
    expect(errors('{ settings { export { includeFeaturedInTitle } } }')).toEqual([]);
  });

  it('is accepted as a boolean in the input and rejects anything else', () => {
    expect(errors('mutation { updateSettings(input: { export: { includeFeaturedInTitle: true } }) { export { includeFeaturedInTitle } } }')).toEqual([]);
    expect(errors('mutation { updateSettings(input: { export: { includeFeaturedInTitle: "yes" } }) { export { includeFeaturedInTitle } } }').join(' '))
      .toMatch(/Boolean/);
    expect(errors('mutation { updateSettings(input: { export: { includeFeaturedInTitle: 1 } }) { export { includeFeaturedInTitle } } }').join(' '))
      .toMatch(/Boolean/);
  });
});

// Mirrors client/src/features/settings/settings-defaults.ts (DEFAULT_SETTINGS) plus
// `interface.theme`, which the header switcher writes. The client diffs this whole object and
// sends every changed leaf to `updateSettings`; one key the input type does not know makes
// graphql-js reject the entire variable, so no setting syncs. Keep in step with the client file.
const CLIENT_SETTINGS = {
  playback: {
    volume: 1, muted: false,
    autoRewindOnPause: { enabled: false, seconds: 2 },
    speedBounds: { min: 0.25, max: 3 },
    showWaveform: true, waveformSnap: false, loopCurrentLine: false,
    speedPresets: [0.5, 0.75, 1, 1.25, 1.5, 2],
    seekTime: 5, seekPlays: false,
  },
  editor: {
    autoPauseOnMark: false,
    nudge: { fine: 0.01, coarse: 0.1, default: 0.1 },
    autoAdvance: { enabled: true, skipBlank: false, mode: 'next' },
    preserveEmptyLines: false, showShiftAll: true, shiftAllAmount: 0.5,
    playerPosition: 'bottom', showLineNumbers: true, timestampPrecision: 'thousandths',
    syncFlashDuration: 'normal', lyricsSearchSpeed: 'normal', overlapThreshold: 0.05,
    srt: { defaultSubtitleDuration: 5, minSubtitleGap: 0, snapToNextLine: false },
    history: { limit: 250, groupingThresholdMs: 1000 },
    display: {
      activeHighlight: 'glow', showNextLine: true, dualLine: false, languageLayout: 'stacked',
      translationLayout: 'side-by-side', readingFormat: 'hiragana', karaokeFillTrack: 'main',
      karaokeFillEasing: 'linear',
    },
    scroll: { mode: 'smooth', alignment: 'center' },
  },
  export: {
    lineEndings: 'lf', copyFormat: 'lrc', downloadFormat: 'lrc', wordTimestampPrecision: 'hundredths',
    defaultFilenamePattern: 'fixed', includeMetadata: true, stripEmptyLines: false, normalizeTimestamps: false,
  },
  interface: {
    theme: 'dark', defaultLanguage: 'en', fontSize: 'normal', fontWeight: 'normal', spacing: 'normal',
    previewAlignment: 'left', focusContrast: 'medium', focusMode: 'default', layoutSwap: false,
    playerTop: false, editorWidth: 50, lockLayout: false, autoHideHeader: false, mobileTab: 'editor', toastPosition: 'bottom-right',
    editorTourShown: 1, editorTourEnabled: true,
  },
  shortcuts: {
    mark: ['Enter'], nudgeLeft: ['Alt+ArrowLeft'], nudgeRight: ['Alt+ArrowRight'],
    nudgeLeftFine: ['Shift+ArrowLeft'], nudgeRightFine: ['Shift+ArrowRight'], addLine: ['Ctrl+Enter'],
    deleteLine: ['Delete'], clearTimestamp: ['Backspace'], captureAdLib: ['a'], switchMode: ['Ctrl+m'],
    deselect: ['Escape'], showHelp: ['?'], rangeSelect: ['Shift'], toggleSelect: ['Ctrl'], loopClick: ['Shift'],
    playPause: ['Space'], seekForward: ['ArrowRight'], seekBackward: ['ArrowLeft'], mute: ['m'],
    speedUp: ['+'], speedDown: ['-'], addSecondary: ['Shift+H'], addTranslation: ['Shift+T'],
    toggleTranslation: ['t'], focusSync: ['Ctrl+1'], focusPreview: ['Ctrl+2'], focusPlayback: ['Ctrl+3'],
    alignLeft: ['Shift+L'], alignCenter: ['Shift+C'], alignRight: ['Shift+R'],
    toggleVisualizer: ['v'], openVisualizer: ['Shift+V'], toggleFullLyrics: ['l'], togglePlayer: ['p'],
    searchLyrics: ['/'], loopLine: ['l'], prevLine: ['ArrowUp'], nextLine: ['ArrowDown'], duplicateLine: ['Ctrl+D'],
  },
  advanced: {
    autoSave: { enabled: true, timeInterval: 60 }, autoSaveIndicator: 'normal',
    confirmDestructive: true, timezone: 'auto',
  },
  autoStamp: { confidenceThreshold: 0.8, fuzzyTolerance: 0.75, applyMode: 'empty-only' },
};

function leafPaths(value: Record<string, unknown>, prefix = ''): string[] {
  return Object.entries(value).flatMap(([key, v]) => {
    const path = prefix ? `${prefix}.${key}` : key;
    return v !== null && typeof v === 'object' && !Array.isArray(v) ? leafPaths(v as Record<string, unknown>, path) : [path];
  });
}

describe('UpdateSettingsInput accepts every setting the client syncs', () => {
  const schema = buildSchema(schemaString);
  const operation = parse('mutation ($input: UpdateSettingsInput!) { updateSettings(input: $input) { interface { theme } } }')
    .definitions[0] as OperationDefinitionNode;
  const coerce = (input: unknown) => getVariableValues(schema, operation.variableDefinitions ?? [], { input });

  it('coerces the full client settings object', () => {
    const result = coerce(CLIENT_SETTINGS);
    expect('errors' in result ? result.errors.map((e) => e.message) : []).toEqual([]);
  });

  it('coerces each leaf on its own, so a single changed key never fails', () => {
    for (const path of leafPaths(CLIENT_SETTINGS)) {
      const input = path.split('.').reduceRight<unknown>(
        (acc, key) => ({ [key]: acc }),
        path.split('.').reduce<unknown>((o, k) => (o as Record<string, unknown>)[k], CLIENT_SETTINGS)
      );
      const result = coerce(input);
      expect({ path, errors: 'errors' in result ? result.errors.map((e) => e.message) : [] }).toEqual({ path, errors: [] });
    }
  });

  it('still rejects a key the schema does not know (guards the guard)', () => {
    expect('errors' in coerce({ interface: { notARealSetting: 1 } })).toBe(true);
  });

  it('every synced leaf is a path of the Mongoose model, so it is stored rather than dropped', () => {
    const missing = leafPaths(CLIENT_SETTINGS).filter((p) => !Settings.schema.path(p));
    expect(missing).toEqual([]);
  });

  it('exposes every synced leaf for reading', () => {
    const selection = (value: Record<string, unknown>): string =>
      Object.entries(value).map(([k, v]) => (v !== null && typeof v === 'object' && !Array.isArray(v) ? `${k} { ${selection(v as Record<string, unknown>)} }` : k)).join(' ');
    expect(validate(schema, parse(`{ settings { ${selection(CLIENT_SETTINGS)} } }`)).map((e) => e.message)).toEqual([]);
  });
});
