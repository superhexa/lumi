/**
 * Subtitle toolkit shared by the subtitle API route and the direct player.
 *
 * The player fetches subtitle cues once and then renders them itself, which
 * lets us shift (constant delay) and stretch (drift) the timing live without
 * re-downloading anything. Everything here is runtime-agnostic so it works
 * both on the server (Node/Workers) and in the browser.
 */

export type SubtitleLanguage = 'ar' | 'en';

export interface SubtitleCue {
  start: number;
  end: number;
  text: string;
}

export interface SubtitleTiming {
  /** Positive values delay the subtitles, negative values show them earlier. */
  offsetMs: number;
  /** 1 = original timing; values stretch the cue timestamps from time zero. */
  scale: number;
}

export const DEFAULT_SUBTITLE_TIMING: SubtitleTiming = {
  offsetMs: 0,
  scale: 1,
};

const MIN_TIMING_SCALE = 0.25;
const MAX_TIMING_SCALE = 4;
const MAX_OFFSET_MS = 10 * 60_000;

function parseTimestamp(value: string): number {
  const parts = value.trim().replace(',', '.').split(':');
  if (parts.length < 2 || parts.length > 3) return NaN;
  const seconds = Number(parts.pop());
  const minutes = Number(parts.pop());
  const hours = parts.length > 0 ? Number(parts.pop()) : 0;
  if (![seconds, minutes, hours].every(Number.isFinite)) return NaN;
  return hours * 3600 + minutes * 60 + seconds;
}

function cleanCueText(value: string): string {
  return value
    // ASS/SSA override tags such as {\an8}.
    .replace(/\{\\[^}]*\}/g, '')
    // Inline HTML tags (<i>, <font ...>, <v Speaker>) are not needed.
    .replace(/<[^>]*>/g, '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/g, "'")
    // ASS line breaks.
    .replace(/\\N/gi, '\n')
    .replace(/\\n/gi, '\n')
    .replace(/[ \t]+\n/g, '\n')
    .trim();
}

/**
 * Parses SRT/VTT text into clean, sorted cues. Unknown blocks are skipped, so
 * a partially malformed file still yields everything that could be read.
 */
export function parseSubtitleText(raw: string): SubtitleCue[] {
  if (!raw) return [];
  const normalized = raw
    .replace(/^\uFEFF/, '')
    .replace(/\r\n?/g, '\n')
    .split('\u0000')
    .join('');

  const blocks = normalized.split(/\n{2,}/);
  const cues: SubtitleCue[] = [];

  for (const block of blocks) {
    const lines = block.split('\n');
    const timingIndex = lines.findIndex((line) => line.includes('-->'));
    if (timingIndex === -1) continue;

    const timestamps = Array.from(
      lines[timingIndex].matchAll(/(\d{1,3}:\d{2}:\d{2}[,.]\d{1,3})/g),
    ).map((match) => match[1]);
    if (timestamps.length < 2) continue;

    const start = parseTimestamp(timestamps[0]);
    const end = parseTimestamp(timestamps[1]);
    const text = cleanCueText(lines.slice(timingIndex + 1).join('\n'));

    if (
      !text ||
      !Number.isFinite(start) ||
      !Number.isFinite(end) ||
      end <= start
    ) {
      continue;
    }

    cues.push({ start, end, text: text.slice(0, 2_000) });
  }

  return cues.sort((a, b) => a.start - b.start);
}

/** Decodes UTF-8, falling back to the legacy Windows code page per language. */
export function decodeSubtitleBytes(
  bytes: Uint8Array,
  language: SubtitleLanguage,
): string {
  const decode = (label: string, fatal: boolean): string | null => {
    try {
      return new TextDecoder(label, { fatal }).decode(bytes);
    } catch {
      return null;
    }
  };

  return (
    decode('utf-8', true) ??
    decode(language === 'ar' ? 'windows-1256' : 'windows-1252', false) ??
    new TextDecoder().decode(bytes)
  );
}

export function normalizeSubtitleTiming(
  timing?: Partial<SubtitleTiming> | null,
): SubtitleTiming {
  const offset = Number(timing?.offsetMs);
  const scale = Number(timing?.scale);
  return {
    offsetMs: Number.isFinite(offset)
      ? Math.max(-MAX_OFFSET_MS, Math.min(MAX_OFFSET_MS, Math.round(offset)))
      : 0,
    scale:
      Number.isFinite(scale) &&
      scale >= MIN_TIMING_SCALE &&
      scale <= MAX_TIMING_SCALE
        ? scale
        : 1,
  };
}

export function clampSubtitleOffset(offsetMs: number): number {
  return normalizeSubtitleTiming({ offsetMs }).offsetMs;
}

/** Applies the delay + stretch transform and drops cues that fall away. */
export function applySubtitleTiming(
  cues: SubtitleCue[],
  timing: SubtitleTiming,
): SubtitleCue[] {
  const { offsetMs, scale } = normalizeSubtitleTiming(timing);
  if (offsetMs === 0 && scale === 1) return cues;
  const offset = offsetMs / 1000;
  const shifted: SubtitleCue[] = [];
  for (const cue of cues) {
    const start = cue.start * scale + offset;
    const end = cue.end * scale + offset;
    if (end <= 0 || end <= start) continue;
    shifted.push({
      start: Math.max(0, start),
      end,
      text: cue.text,
    });
  }
  return shifted;
}

/** Binary search for the cue visible at the given playback time. */
export function findActiveSubtitleCue(
  cues: SubtitleCue[],
  time: number,
): SubtitleCue | null {
  if (!cues.length || !Number.isFinite(time)) return null;
  let low = 0;
  let high = cues.length - 1;
  let candidate = -1;
  while (low <= high) {
    const middle = (low + high) >> 1;
    if (cues[middle].start <= time) {
      candidate = middle;
      low = middle + 1;
    } else {
      high = middle - 1;
    }
  }
  // Subtitle files occasionally overlap; look back a few cues so a long cue
  // that started earlier still wins over a shorter subsequent one.
  for (let index = candidate; index >= Math.max(0, candidate - 4); index -= 1) {
    const cue = cues[index];
    if (cue.start <= time && cue.end >= time) return cue;
  }
  return null;
}

export function subtitleLanguageFromLocale(
  locale?: string | null,
): SubtitleLanguage {
  return (locale || '').trim().toLowerCase().startsWith('ar') ? 'ar' : 'en';
}

/** Human-readable offset, e.g. "-1.5" or "+0.5". */
export function formatSubtitleOffset(offsetMs: number): string {
  const seconds = normalizeSubtitleTiming({ offsetMs }).offsetMs / 1000;
  if (Math.abs(seconds) < 0.05) return '0.0';
  return `${seconds > 0 ? '+' : ''}${seconds.toFixed(1)}`;
}
