import type { LineEntry } from './lrc.js';

export interface SrtConfig {
  minSubtitleGap?: number;
  defaultSubtitleDuration?: number;
}

export function formatSrtTimestamp(seconds: number | null | undefined): string {
  if (seconds == null || isNaN(seconds) || seconds < 0) return '00:00:00,000';
  const hrs = Math.floor(seconds / 3600);
  const mins = Math.floor((seconds % 3600) / 60);
  const secs = Math.floor(seconds % 60);
  const ms = Math.floor((seconds % 1) * 1000);
  return `${String(hrs).padStart(2, '0')}:${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')},${String(ms).padStart(3, '0')}`;
}

export function compileSRT(
  lines: LineEntry[],
  duration?: number | null,
  includeTranslations = false,
  lineEndings = 'lf',
  srtConfig: SrtConfig = {},
  includeSecondary = false,
  exportTranslationIndex = 0
): string {
  const minGap = srtConfig.minSubtitleGap || 0.05;
  const defaultDur = srtConfig.defaultSubtitleDuration || 5;

  const synced = lines.filter((l) => l.timestamp != null);
  if (synced.length === 0) return '';

  const body = synced.map((line, i) => {
    const start = line.timestamp!;
    let end: number;
    if (line.endTime != null) {
      end = line.endTime;
    } else {
      const nextLine = synced[i + 1];
      if (nextLine && nextLine.timestamp != null) {
        end = Math.max(start + minGap, nextLine.timestamp - minGap);
      } else if (duration) {
        end = Math.min(start + defaultDur, duration);
      } else {
        end = start + defaultDur;
      }
    }

    const parts: string[] = [line.text];

    if (includeSecondary && line.secondary) {
      parts.push(line.secondary);
    }

    if (includeTranslations) {
      const translationText =
        line.translations?.[exportTranslationIndex]?.text ?? line.translation ?? null;
      if (translationText) parts.push(translationText);
    }

    return `${i + 1}\n${formatSrtTimestamp(start)} --> ${formatSrtTimestamp(end)}\n${parts.join('\n')}\n`;
  }).join('\n');

  return lineEndings === 'crlf' ? body.replace(/\n/g, '\r\n') : body;
}
