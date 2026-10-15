import { describe, it, expect } from 'vitest';
import { buildSchema, parse, validate } from 'graphql';
import { flattenSettingsUpdate } from './settings.update.js';
import { schemaString } from '../../graphql/schema/index.js';

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
