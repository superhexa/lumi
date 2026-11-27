/**
 * Subtitle toolkit shared by the subtitle API route and the direct player.
 *
 * The player fetches subtitle cues once and then renders them itself, which
 * lets us shift (constant delay) and stretch (drift) the timing live without
 * re-downloading anything. Everything here is runtime-agnostic so it works
 * both on the server (Node/Workers) and in the browser.
 */

export interface SubtitleLanguageInfo {
  /** BCP-47-ish code used by Luma and the browser. */
  code: string;
  /** English label. */
  label: string;
  /** Native label, shown in the language picker. */
  native: string;
  /** ISO 639-2/B code used by the legacy OpenSubtitles REST API. */
  opensubtitles: string;
  /** Prefix used by the Stremio OpenSubtitles v3 addon. */
  stremio: string;
  rtl?: boolean;
}

/**
 * Languages offered in the picker. The list is intentionally broad so a title
 * can be watched in its original language instead of being limited to
 * English/Arabic. Unknown codes still work through `resolveSubtitleLanguage`.
 */
export const SUBTITLE_LANGUAGES: SubtitleLanguageInfo[] = [
  {
    code: 'en',
    label: 'English',
    native: 'English',
    opensubtitles: 'eng',
    stremio: 'en',
  },
  {
    code: 'ar',
    label: 'Arabic',
    native: 'العربية',
    opensubtitles: 'ara',
    stremio: 'ar',
    rtl: true,
  },
  {
    code: 'fr',
    label: 'French',
    native: 'Français',
    opensubtitles: 'fre',
    stremio: 'fr',
  },
  {
    code: 'es',
    label: 'Spanish',
    native: 'Español',
    opensubtitles: 'spa',
    stremio: 'es',
  },
  {
    code: 'de',
    label: 'German',
    native: 'Deutsch',
    opensubtitles: 'ger',
    stremio: 'de',
  },
  {
    code: 'it',
    label: 'Italian',
    native: 'Italiano',
    opensubtitles: 'ita',
    stremio: 'it',
  },
  {
    code: 'pt',
    label: 'Portuguese',
    native: 'Português',
    opensubtitles: 'por',
    stremio: 'pt',
  },
  {
    code: 'ru',
    label: 'Russian',
    native: 'Русский',
    opensubtitles: 'rus',
    stremio: 'ru',
  },
  {
    code: 'tr',
    label: 'Turkish',
    native: 'Türkçe',
    opensubtitles: 'tur',
    stremio: 'tr',
  },
  {
    code: 'hi',
    label: 'Hindi',
    native: 'हिन्दी',
    opensubtitles: 'hin',
    stremio: 'hi',
  },
  {
    code: 'ur',
    label: 'Urdu',
    native: 'اردو',
    opensubtitles: 'urd',
    stremio: 'ur',
    rtl: true,
  },
  {
    code: 'fa',
    label: 'Persian',
    native: 'فارسی',
    opensubtitles: 'per',
    stremio: 'fa',
    rtl: true,
  },
  {
    code: 'ja',
    label: 'Japanese',
    native: '日本語',
    opensubtitles: 'jpn',
    stremio: 'ja',
  },
  {
    code: 'ko',
    label: 'Korean',
    native: '한국어',
    opensubtitles: 'kor',
    stremio: 'ko',
  },
  {
    code: 'zh',
    label: 'Chinese',
    native: '中文',
    opensubtitles: 'chi',
    stremio: 'zh',
  },
  {
    code: 'id',
    label: 'Indonesian',
    native: 'Bahasa Indonesia',
    opensubtitles: 'ind',
    stremio: 'id',
  },
  {
    code: 'ms',
    label: 'Malay',
    native: 'Bahasa Melayu',
    opensubtitles: 'may',
    stremio: 'ms',
  },
  {
    code: 'th',
    label: 'Thai',
    native: 'ไทย',
    opensubtitles: 'tha',
    stremio: 'th',
  },
  {
    code: 'vi',
    label: 'Vietnamese',
    native: 'Tiếng Việt',
    opensubtitles: 'vie',
    stremio: 'vi',
  },
  {
    code: 'pl',
    label: 'Polish',
    native: 'Polski',
    opensubtitles: 'pol',
    stremio: 'pl',
  },
  {
    code: 'nl',
    label: 'Dutch',
    native: 'Nederlands',
    opensubtitles: 'dut',
    stremio: 'nl',
  },
  {
    code: 'sv',
    label: 'Swedish',
    native: 'Svenska',
    opensubtitles: 'swe',
    stremio: 'sv',
  },
  {
    code: 'da',
    label: 'Danish',
    native: 'Dansk',
    opensubtitles: 'dan',
    stremio: 'da',
  },
  {
    code: 'no',
    label: 'Norwegian',
    native: 'Norsk',
    opensubtitles: 'nor',
    stremio: 'no',
  },
  {
    code: 'fi',
    label: 'Finnish',
    native: 'Suomi',
    opensubtitles: 'fin',
    stremio: 'fi',
  },
  {
    code: 'el',
    label: 'Greek',
    native: 'Ελληνικά',
    opensubtitles: 'gre',
    stremio: 'el',
  },
  {
    code: 'he',
    label: 'Hebrew',
    native: 'עברית',
    opensubtitles: 'heb',
    stremio: 'he',
    rtl: true,
  },
  {
    code: 'cs',
    label: 'Czech',
    native: 'Čeština',
    opensubtitles: 'cze',
    stremio: 'cs',
  },
  {
    code: 'hu',
    label: 'Hungarian',
    native: 'Magyar',
    opensubtitles: 'hun',
    stremio: 'hu',
  },
  {
    code: 'ro',
    label: 'Romanian',
    native: 'Română',
    opensubtitles: 'rum',
    stremio: 'ro',
  },
  {
    code: 'uk',
    label: 'Ukrainian',
    native: 'Українська',
    opensubtitles: 'ukr',
    stremio: 'uk',
  },
  {
    code: 'bg',
    label: 'Bulgarian',
    native: 'Български',
    opensubtitles: 'bul',
    stremio: 'bg',
  },
  {
    code: 'hr',
    label: 'Croatian',
    native: 'Hrvatski',
    opensubtitles: 'hrv',
    stremio: 'hr',
  },
  {
    code: 'sr',
    label: 'Serbian',
    native: 'Српски',
    opensubtitles: 'scc',
    stremio: 'sr',
  },
  {
    code: 'sk',
    label: 'Slovak',
    native: 'Slovenčina',
    opensubtitles: 'slo',
    stremio: 'sk',
  },
  {
    code: 'sl',
    label: 'Slovenian',
    native: 'Slovenščina',
    opensubtitles: 'slv',
    stremio: 'sl',
  },
  {
    code: 'bn',
    label: 'Bengali',
    native: 'বাংলা',
    opensubtitles: 'ben',
    stremio: 'bn',
  },
  {
    code: 'ta',
    label: 'Tamil',
    native: 'தமிழ்',
    opensubtitles: 'tam',
    stremio: 'ta',
  },
  {
    code: 'te',
    label: 'Telugu',
    native: 'తెలుగు',
    opensubtitles: 'tel',
    stremio: 'te',
  },
  {
    code: 'fil',
    label: 'Filipino',
    native: 'Filipino',
    opensubtitles: 'fil',
    stremio: 'tl',
  },
  {
    code: 'sw',
    label: 'Swahili',
    native: 'Kiswahili',
    opensubtitles: 'swa',
    stremio: 'sw',
  },
  {
    code: 'af',
    label: 'Afrikaans',
    native: 'Afrikaans',
    opensubtitles: 'afr',
    stremio: 'af',
  },
  {
    code: 'sq',
    label: 'Albanian',
    native: 'Shqip',
    opensubtitles: 'alb',
    stremio: 'sq',
  },
  {
    code: 'am',
    label: 'Amharic',
    native: 'አማርኛ',
    opensubtitles: 'amh',
    stremio: 'am',
  },
  {
    code: 'hy',
    label: 'Armenian',
    native: 'Հայերեն',
    opensubtitles: 'arm',
    stremio: 'hy',
  },
  {
    code: 'az',
    label: 'Azerbaijani',
    native: 'Azərbaycanca',
    opensubtitles: 'aze',
    stremio: 'az',
  },
  {
    code: 'eu',
    label: 'Basque',
    native: 'Euskara',
    opensubtitles: 'baq',
    stremio: 'eu',
  },
  {
    code: 'be',
    label: 'Belarusian',
    native: 'Беларуская',
    opensubtitles: 'bel',
    stremio: 'be',
  },
  {
    code: 'bs',
    label: 'Bosnian',
    native: 'Bosanski',
    opensubtitles: 'bos',
    stremio: 'bs',
  },
  {
    code: 'ca',
    label: 'Catalan',
    native: 'Català',
    opensubtitles: 'cat',
    stremio: 'ca',
  },
  {
    code: 'ceb',
    label: 'Cebuano',
    native: 'Cebuano',
    opensubtitles: 'ceb',
    stremio: 'ceb',
  },
  {
    code: 'et',
    label: 'Estonian',
    native: 'Eesti',
    opensubtitles: 'est',
    stremio: 'et',
  },
  {
    code: 'gl',
    label: 'Galician',
    native: 'Galego',
    opensubtitles: 'glg',
    stremio: 'gl',
  },
  {
    code: 'ka',
    label: 'Georgian',
    native: 'ქართული',
    opensubtitles: 'geo',
    stremio: 'ka',
  },
  {
    code: 'gu',
    label: 'Gujarati',
    native: 'ગુજરાતી',
    opensubtitles: 'guj',
    stremio: 'gu',
  },
  {
    code: 'ha',
    label: 'Hausa',
    native: 'Hausa',
    opensubtitles: 'hau',
    stremio: 'ha',
  },
  {
    code: 'is',
    label: 'Icelandic',
    native: 'Íslenska',
    opensubtitles: 'ice',
    stremio: 'is',
  },
  {
    code: 'ig',
    label: 'Igbo',
    native: 'Igbo',
    opensubtitles: 'ibo',
    stremio: 'ig',
  },
  {
    code: 'jv',
    label: 'Javanese',
    native: 'Basa Jawa',
    opensubtitles: 'jav',
    stremio: 'jv',
  },
  {
    code: 'kn',
    label: 'Kannada',
    native: 'ಕನ್ನಡ',
    opensubtitles: 'kan',
    stremio: 'kn',
  },
  {
    code: 'kk',
    label: 'Kazakh',
    native: 'Қазақша',
    opensubtitles: 'kaz',
    stremio: 'kk',
  },
  {
    code: 'km',
    label: 'Khmer',
    native: 'ខ្មែរ',
    opensubtitles: 'khm',
    stremio: 'km',
  },
  {
    code: 'ku',
    label: 'Kurdish',
    native: 'Kurdî',
    opensubtitles: 'kur',
    stremio: 'ku',
  },
  {
    code: 'ky',
    label: 'Kyrgyz',
    native: 'Кыргызча',
    opensubtitles: 'kir',
    stremio: 'ky',
  },
  {
    code: 'lo',
    label: 'Lao',
    native: 'ລາວ',
    opensubtitles: 'lao',
    stremio: 'lo',
  },
  {
    code: 'lv',
    label: 'Latvian',
    native: 'Latviešu',
    opensubtitles: 'lav',
    stremio: 'lv',
  },
  {
    code: 'lt',
    label: 'Lithuanian',
    native: 'Lietuvių',
    opensubtitles: 'lit',
    stremio: 'lt',
  },
  {
    code: 'mk',
    label: 'Macedonian',
    native: 'Македонски',
    opensubtitles: 'mac',
    stremio: 'mk',
  },
  {
    code: 'ml',
    label: 'Malayalam',
    native: 'മലയാളം',
    opensubtitles: 'mal',
    stremio: 'ml',
  },
  {
    code: 'mt',
    label: 'Maltese',
    native: 'Malti',
    opensubtitles: 'mlt',
    stremio: 'mt',
  },
  {
    code: 'mr',
    label: 'Marathi',
    native: 'मराठी',
    opensubtitles: 'mar',
    stremio: 'mr',
  },
  {
    code: 'mn',
    label: 'Mongolian',
    native: 'Монгол',
    opensubtitles: 'mon',
    stremio: 'mn',
  },
  {
    code: 'my',
    label: 'Burmese',
    native: 'မြန်မာ',
    opensubtitles: 'bur',
    stremio: 'my',
  },
  {
    code: 'ne',
    label: 'Nepali',
    native: 'नेपाली',
    opensubtitles: 'nep',
    stremio: 'ne',
  },
  {
    code: 'pa',
    label: 'Punjabi',
    native: 'ਪੰਜਾਬੀ',
    opensubtitles: 'pan',
    stremio: 'pa',
  },
  {
    code: 'ps',
    label: 'Pashto',
    native: 'پښتو',
    opensubtitles: 'pus',
    stremio: 'ps',
    rtl: true,
  },
  {
    code: 'sd',
    label: 'Sindhi',
    native: 'سنڌي',
    opensubtitles: 'snd',
    stremio: 'sd',
    rtl: true,
  },
  {
    code: 'si',
    label: 'Sinhala',
    native: 'සිංහල',
    opensubtitles: 'sin',
    stremio: 'si',
  },
  {
    code: 'so',
    label: 'Somali',
    native: 'Soomaali',
    opensubtitles: 'som',
    stremio: 'so',
  },
  {
    code: 'st',
    label: 'Sotho',
    native: 'Sesotho',
    opensubtitles: 'sot',
    stremio: 'st',
  },
  {
    code: 'tg',
    label: 'Tajik',
    native: 'Тоҷикӣ',
    opensubtitles: 'tgk',
    stremio: 'tg',
  },
  {
    code: 'tt',
    label: 'Tatar',
    native: 'Татарча',
    opensubtitles: 'tat',
    stremio: 'tt',
  },
  {
    code: 'ug',
    label: 'Uyghur',
    native: 'ئۇيغۇرچە',
    opensubtitles: 'uig',
    stremio: 'ug',
    rtl: true,
  },
  {
    code: 'uz',
    label: 'Uzbek',
    native: 'Oʻzbekcha',
    opensubtitles: 'uzb',
    stremio: 'uz',
  },
  {
    code: 'cy',
    label: 'Welsh',
    native: 'Cymraeg',
    opensubtitles: 'wel',
    stremio: 'cy',
  },
  {
    code: 'xh',
    label: 'Xhosa',
    native: 'isiXhosa',
    opensubtitles: 'xho',
    stremio: 'xh',
  },
  {
    code: 'yi',
    label: 'Yiddish',
    native: 'ייִדיש',
    opensubtitles: 'yid',
    stremio: 'yi',
    rtl: true,
  },
  {
    code: 'yo',
    label: 'Yoruba',
    native: 'Yorùbá',
    opensubtitles: 'yor',
    stremio: 'yo',
  },
  {
    code: 'zu',
    label: 'Zulu',
    native: 'isiZulu',
    opensubtitles: 'zul',
    stremio: 'zu',
  },
];

const LANGUAGE_BY_CODE = new Map(
  SUBTITLE_LANGUAGES.map((language) => [language.code, language]),
);

export function resolveSubtitleLanguage(
  code?: string | null,
): SubtitleLanguageInfo {
  const normalized = (code || '').trim().toLowerCase().split(/[-_]/)[0];
  const known = LANGUAGE_BY_CODE.get(normalized);
  if (known) return known;
  return {
    code: normalized || 'en',
    label: (normalized || 'en').toUpperCase(),
    native: (normalized || 'en').toUpperCase(),
    opensubtitles: normalized || 'eng',
    stremio: normalized || 'en',
  };
}

export function isRtlSubtitleLanguage(code?: string | null): boolean {
  return Boolean(resolveSubtitleLanguage(code).rtl);
}

export type SubtitleLanguage = string;

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
  return (
    value
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
      .trim()
  );
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

  const code = (language || 'en').toLowerCase().split(/[-_]/)[0];
  const arabicScript = ['ar', 'fa', 'ur', 'ps', 'sd', 'ug'].includes(code);
  const cyrillic = [
    'ru',
    'uk',
    'bg',
    'sr',
    'mk',
    'be',
    'kk',
    'ky',
    'uz',
    'mn',
    'tg',
    'tt',
  ].includes(code);
  const centralEuropean = [
    'pl',
    'cs',
    'sk',
    'hu',
    'ro',
    'hr',
    'sl',
    'bs',
  ].includes(code);
  const baltic = ['et', 'lv', 'lt'].includes(code);
  const fallback = arabicScript
    ? 'windows-1256'
    : cyrillic
      ? 'windows-1251'
      : code === 'el'
        ? 'windows-1253'
        : code === 'he' || code === 'yi'
          ? 'windows-1255'
          : code === 'tr' || code === 'az'
            ? 'windows-1254'
            : centralEuropean
              ? 'windows-1250'
              : baltic
                ? 'windows-1257'
                : code === 'th'
                  ? 'windows-874'
                  : code === 'vi'
                    ? 'windows-1258'
                    : code === 'ja'
                      ? 'shift_jis'
                      : code === 'ko'
                        ? 'euc-kr'
                        : code === 'zh'
                          ? 'gb18030'
                          : 'windows-1252';

  return (
    decode('utf-8', true) ??
    decode(fallback, false) ??
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
  const normalized = (locale || '').trim().toLowerCase().split(/[-_]/)[0];
  return LANGUAGE_BY_CODE.has(normalized) ? normalized : 'en';
}

/** Human-readable offset, e.g. "-1.5" or "+0.5". */
export function formatSubtitleOffset(offsetMs: number): string {
  const seconds = normalizeSubtitleTiming({ offsetMs }).offsetMs / 1000;
  if (Math.abs(seconds) < 0.05) return '0.0';
  return `${seconds > 0 ? '+' : ''}${seconds.toFixed(1)}`;
}
