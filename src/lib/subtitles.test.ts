/** @jest-environment node */
import {
  applySubtitleTiming,
  clampSubtitleOffset,
  decodeSubtitleBytes,
  findActiveSubtitleCue,
  formatSubtitleOffset,
  normalizeSubtitleTiming,
  parseSubtitleText,
  subtitleLanguageFromLocale,
} from '@/lib/subtitles';

const SAMPLE_SRT = [
  '1',
  '00:00:01,000 --> 00:00:03,500',
  '<i>Hello</i> there',
  '',
  '2',
  '00:00:05,000 --> 00:00:07,000',
  '{\\an8}Second &amp; line\\Nnext line',
  '',
].join('\r\n');

describe('parseSubtitleText', () => {
  it('parses SRT cues, strips tags and decodes entities', () => {
    const cues = parseSubtitleText(SAMPLE_SRT);
    expect(cues).toEqual([
      { start: 1, end: 3.5, text: 'Hello there' },
      { start: 5, end: 7, text: 'Second & line\nnext line' },
    ]);
  });

  it('parses WebVTT timestamps and cue settings', () => {
    const cues = parseSubtitleText(
      'WEBVTT\n\n00:00:02.250 --> 00:00:04.000 align:middle\nHi\n',
    );
    expect(cues).toEqual([{ start: 2.25, end: 4, text: 'Hi' }]);
  });

  it('skips malformed blocks rather than failing the whole file', () => {
    const cues = parseSubtitleText(
      'not a cue\n\n00:00:01,000 --> 00:00:02,000\nGood\n',
    );
    expect(cues).toHaveLength(1);
    expect(cues[0].text).toBe('Good');
  });

  it('returns an empty list for empty input', () => {
    expect(parseSubtitleText('')).toEqual([]);
  });
});

describe('subtitle timing', () => {
  const cues = [
    { start: 1, end: 2, text: 'one' },
    { start: 10, end: 12, text: 'two' },
  ];

  it('shifts cues by the given offset', () => {
    const shifted = applySubtitleTiming(cues, { offsetMs: 1500, scale: 1 });
    expect(shifted.map((cue) => [cue.start, cue.end])).toEqual([
      [2.5, 3.5],
      [11.5, 13.5],
    ]);
  });

  it('scales cues to correct drifting subtitles', () => {
    const scaled = applySubtitleTiming(cues, { offsetMs: 0, scale: 1.5 });
    expect(scaled.map((cue) => [cue.start, cue.end])).toEqual([
      [1.5, 3],
      [15, 18],
    ]);
  });

  it('clamps cues that fall before the start of the movie', () => {
    const shifted = applySubtitleTiming(cues, { offsetMs: -1000, scale: 1 });
    expect(shifted.map((cue) => [cue.start, cue.end])).toEqual([
      [0, 1],
      [9, 11],
    ]);
  });

  it('normalizes out-of-range timing settings', () => {
    expect(normalizeSubtitleTiming({ offsetMs: 999_999, scale: 0 })).toEqual({
      offsetMs: 600_000,
      scale: 1,
    });
    expect(clampSubtitleOffset(-999_999)).toBe(-600_000);
  });
});

describe('findActiveSubtitleCue', () => {
  const cues = [
    { start: 0, end: 2, text: 'a' },
    { start: 3, end: 5, text: 'b' },
  ];

  it('finds the cue covering the current time', () => {
    expect(findActiveSubtitleCue(cues, 3.5)?.text).toBe('b');
  });

  it('returns null in gaps and before the first cue', () => {
    expect(findActiveSubtitleCue(cues, 2.5)).toBeNull();
    expect(findActiveSubtitleCue([], 1)).toBeNull();
  });

  it('keeps long overlapping cues visible', () => {
    const overlapping = [
      { start: 0, end: 10, text: 'long' },
      { start: 4, end: 5, text: 'short' },
    ];
    expect(findActiveSubtitleCue(overlapping, 6)?.text).toBe('long');
  });
});

describe('subtitle helpers', () => {
  it('decodes UTF-8 and falls back to Windows-1256 for Arabic', () => {
    const utf8 = new TextEncoder().encode('مرحبا');
    expect(decodeSubtitleBytes(utf8, 'ar')).toBe('مرحبا');
    const cp1256 = Uint8Array.from([0xe3, 0xd1, 0xcd, 0xc8, 0xc7]);
    expect(decodeSubtitleBytes(cp1256, 'ar')).toBe('مرحبا');
  });

  it('formats offsets for the UI', () => {
    expect(formatSubtitleOffset(0)).toBe('0.0');
    expect(formatSubtitleOffset(1500)).toBe('+1.5');
    expect(formatSubtitleOffset(-500)).toBe('-0.5');
  });

  it('maps locales to subtitle languages', () => {
    expect(subtitleLanguageFromLocale('ar-SA')).toBe('ar');
    expect(subtitleLanguageFromLocale('en-US')).toBe('en');
    expect(subtitleLanguageFromLocale(null)).toBe('en');
  });
});
