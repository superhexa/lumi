import { NextResponse } from 'next/server';

import {
  type SubtitleCue,
  type SubtitleLanguage,
  decodeSubtitleBytes,
  parseSubtitleText,
  resolveSubtitleLanguage,
  subtitleLanguageFromLocale,
} from '@/lib/subtitles';

/**
 * GET /api/player/subtitles
 *
 * Resolves a readable, language-matched subtitle track for a TMDB title.
 * Two free catalogs are tried: the OpenSubtitles REST search (better release
 * matches, sorted by download count) and the OpenSubtitles v3 Stremio addon
 * as a fallback. The response contains parsed cues, so the player can apply
 * delay/drift corrections live without fetching again.
 *
 * Nothing is persisted: results are cached in memory for a short time only.
 */

const TMDB_API_BASE_URL = 'https://api.themoviedb.org/3';
const OPEN_SUBTITLES_SEARCH_URL = 'https://rest.opensubtitles.org/search';
const STREMIO_SUBTITLES_URL = 'https://opensubtitles-v3.strem.io/subtitles';
const SUBTITLE_USER_AGENT = 'TemporaryUserAgent';
const BROWSER_USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const REQUEST_TIMEOUT_MS = 15_000;
const MAX_COMPRESSED_BYTES = 4 * 1024 * 1024;
const MAX_DECOMPRESSED_BYTES = 8 * 1024 * 1024;
const MAX_CUES = 10_000;
const CACHE_TTL_MS = 30 * 60_000;

type SubtitleSource = 'opensubtitles' | 'stremio' | 'yifysubtitles';

interface SubtitleCandidate {
  url: string;
  fileName: string;
  downloadCount: number;
  fps?: number;
  source: SubtitleSource;
}

interface SubtitleCacheEntry {
  expiresAt: number;
  payload: SubtitlesPayload;
}

export interface SubtitlesPayload {
  ok: true;
  language: SubtitleLanguage;
  cues: SubtitleCue[];
  meta: {
    fileName: string;
    source: SubtitleSource;
    downloadCount: number;
    fps?: number;
    cueCount: number;
  };
}

const subtitleCache = new Map<string, SubtitleCacheEntry>();

function noStoreJson(
  payload: unknown,
  status: number,
  cacheControl = 'no-store, max-age=0',
): NextResponse {
  const response = NextResponse.json(payload, { status });
  response.headers.set('Cache-Control', cacheControl);
  return response;
}

function normalizeImdbId(value?: string | null): string | null {
  const trimmed = (value || '').trim();
  const withPrefix = /^\d{5,10}$/.test(trimmed) ? `tt${trimmed}` : trimmed;
  return /^tt\d{5,10}$/i.test(withPrefix) ? withPrefix.toLowerCase() : null;
}

function normalizeLanguage(value?: string | null): SubtitleLanguage {
  return subtitleLanguageFromLocale(value) || 'en';
}

async function lookupImdbId(
  tmdbId: string,
  mediaType: string,
): Promise<string | null> {
  const apiKey =
    process.env.TMDB_API_KEY || process.env.NEXT_PUBLIC_TMDB_API_KEY;
  if (!apiKey) return null;

  const url = new URL(TMDB_API_BASE_URL);
  url.pathname = `/3/${mediaType === 'tv' ? 'tv' : 'movie'}/${tmdbId}/external_ids`;
  url.searchParams.set('api_key', apiKey);

  try {
    const response = await fetch(url, {
      cache: 'no-store',
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      headers: { Accept: 'application/json' },
    });
    if (!response.ok) return null;
    const payload = (await response.json()) as { imdb_id?: string | null };
    return normalizeImdbId(payload.imdb_id);
  } catch {
    return null;
  }
}

interface RestSubtitleRecord {
  SubFileName?: string;
  SubFormat?: string;
  SubDownloadLink?: string;
  SubDownloadsCnt?: string | number;
  SubLanguageID?: string;
  SubBad?: string;
  SubHearingImpaired?: string;
  MovieFPS?: string;
}

const LOW_QUALITY_SUBTITLE =
  /\b(?:cam|hdcam|hdts|ts|telesync|tc|hdtc|scr|screener|dvdscr)\b/i;
const HIGH_QUALITY_SUBTITLE =
  /\b(?:bluray|blu-ray|bdrip|brrip|web-?dl|webrip|remux)\b/i;

/**
 * Ranks subtitle files so retail/web releases beat cam and telesync rips, even
 * when the latter have more downloads.
 */
function subtitleCandidateScore(fileName: string, downloads: number): number {
  const name = fileName.replace(/[._-]+/g, ' ');
  const base = LOW_QUALITY_SUBTITLE.test(name)
    ? Math.floor(downloads * 0.06)
    : downloads;
  let bonus = 0;
  if (HIGH_QUALITY_SUBTITLE.test(name)) bonus += 40;
  if (/\b(?:2160p|4k)\b/i.test(name)) bonus += 14;
  else if (/\b1080p\b/i.test(name)) bonus += 10;
  else if (/\b720p\b/i.test(name)) bonus += 5;
  if (/\b(?:proper|repack|remastered)\b/i.test(name)) bonus += 3;
  return base + bonus;
}

async function searchOpenSubtitles(
  imdbId: string,
  language: SubtitleLanguage,
  mediaType: string,
  season: number,
  episode: number,
): Promise<SubtitleCandidate[]> {
  const numericImdb = imdbId.replace(/^tt/i, '');
  const languageId = resolveSubtitleLanguage(language).opensubtitles;
  const parts =
    mediaType === 'tv'
      ? [`imdbid-${numericImdb}`, `season-${season}`, `episode-${episode}`]
      : [`imdbid-${numericImdb}`];
  parts.push(`sublanguageid-${languageId}`);
  const url = `${OPEN_SUBTITLES_SEARCH_URL}/${parts.join('/')}`;

  try {
    const response = await fetch(url, {
      cache: 'no-store',
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      headers: {
        Accept: 'application/json',
        'User-Agent': SUBTITLE_USER_AGENT,
      },
    });
    if (!response.ok) return [];
    const payload = (await response.json()) as unknown;
    if (!Array.isArray(payload)) return [];

    return (payload as RestSubtitleRecord[])
      .filter((record) => Boolean(record?.SubDownloadLink))
      .filter((record) => {
        const format = (record.SubFormat || '').toLowerCase();
        return !format || format === 'srt' || format === 'vtt';
      })
      .filter((record) => !record.SubBad || record.SubBad !== '1')
      .map((record) => {
        const downloads = Number(record.SubDownloadsCnt) || 0;
        const hearingImpaired =
          Boolean(record.SubHearingImpaired) &&
          record.SubHearingImpaired !== '0';
        const fps = Number(record.MovieFPS);
        const fileName = record.SubFileName || 'subtitles.srt';
        const adjustedDownloads = hearingImpaired
          ? Math.floor(downloads / 4)
          : downloads;
        return {
          url: record.SubDownloadLink || '',
          fileName,
          downloadCount: subtitleCandidateScore(fileName, adjustedDownloads),
          fps: Number.isFinite(fps) && fps > 0 ? fps : undefined,
          source: 'opensubtitles' as const,
        };
      })
      .filter((candidate) => candidate.url.startsWith('https://'))
      .sort((a, b) => b.downloadCount - a.downloadCount);
  } catch {
    return [];
  }
}

interface StremioSubtitleRecord {
  id?: string;
  url?: string;
  lang?: string;
  SubEncoding?: string;
  subtitleFileName?: string;
  movieReleaseName?: string;
  fpsMilli?: number;
  g?: string;
}

async function searchStremio(
  imdbId: string,
  language: SubtitleLanguage,
  mediaType: string,
  season: number,
  episode: number,
): Promise<SubtitleCandidate[]> {
  const suffix = mediaType === 'tv' ? `${imdbId}:${season}:${episode}` : imdbId;
  const url = `${STREMIO_SUBTITLES_URL}/${mediaType === 'tv' ? 'series' : 'movie'}/${suffix}.json`;

  try {
    const response = await fetch(url, {
      cache: 'no-store',
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      headers: { Accept: 'application/json' },
    });
    if (!response.ok) return [];
    const payload = (await response.json()) as {
      subtitles?: StremioSubtitleRecord[];
    };
    const records = Array.isArray(payload?.subtitles) ? payload.subtitles : [];
    const info = resolveSubtitleLanguage(language);
    const matchesLanguage = (value?: string) => {
      const lang = (value || '').toLowerCase();
      return (
        lang === info.stremio ||
        lang === info.opensubtitles ||
        lang.startsWith(`${info.stremio}-`) ||
        lang.startsWith(`${info.code}-`) ||
        lang.startsWith(info.stremio)
      );
    };

    return records
      .filter((record) => Boolean(record?.url))
      .filter((record) => matchesLanguage(record.lang))
      .filter(
        (record) =>
          !/(?:^|[.\s_-])(hi|sdh)(?:[.\s_-]|$)/i.test(
            record.subtitleFileName || '',
          ),
      )
      .map((record) => {
        const downloads = Number(record.g) || 0;
        const utf8 = (record.SubEncoding || '').toUpperCase() === 'UTF-8';
        const fpsMilli = Number(record.fpsMilli);
        const fileName = record.subtitleFileName || 'subtitles.srt';
        return {
          url: record.url || '',
          fileName,
          downloadCount: subtitleCandidateScore(
            fileName,
            downloads + (utf8 ? 5 : 0),
          ),
          fps:
            Number.isFinite(fpsMilli) && fpsMilli > 0
              ? fpsMilli > 1_000
                ? fpsMilli / 1_000
                : fpsMilli
              : undefined,
          source: 'stremio' as const,
        };
      })
      .filter((candidate) => candidate.url.startsWith('https://'))
      .sort((a, b) => b.downloadCount - a.downloadCount);
  } catch {
    return [];
  }
}

const YIFY_SUBTITLES_BASE = 'https://yifysubtitles.ch';

const YIFY_LANGUAGE_ALIASES: Record<string, string[]> = {
  zh: ['chinese', 'mandarin'],
  fa: ['farsi', 'persian'],
  fil: ['tagalog', 'filipino'],
  pt: ['portuguese', 'brazilian'],
  no: ['norwegian'],
  el: ['greek'],
  he: ['hebrew'],
  ms: ['malay', 'malaysian'],
  sr: ['serbian'],
  uk: ['ukrainian'],
};

/**
 * YIFY Subtitles is a third catalog with strong Arabic/European coverage. It
 * serves a ZIP per title, so the download path extracts the first SRT/VTT file.
 */
async function searchYifysubtitles(
  imdbId: string,
  language: SubtitleLanguage,
  mediaType: string,
): Promise<SubtitleCandidate[]> {
  if (mediaType === 'tv') return [];
  const info = resolveSubtitleLanguage(language);
  const tokens = new Set(
    [info.label.toLowerCase(), info.code.toLowerCase()].filter(Boolean),
  );
  for (const alias of YIFY_LANGUAGE_ALIASES[info.code] || []) {
    tokens.add(alias);
  }

  try {
    const response = await fetch(
      `${YIFY_SUBTITLES_BASE}/movie-imdb/${imdbId}`,
      {
        cache: 'no-store',
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        headers: {
          Accept: 'text/html',
          'User-Agent': BROWSER_USER_AGENT,
          Referer: `${YIFY_SUBTITLES_BASE}/`,
        },
      },
    );
    if (!response.ok) return [];
    const html = await response.text();
    const links = Array.from(
      new Set(
        Array.from(html.matchAll(/href="(\/subtitles\/[^"]+)"/g)).map(
          (match) => match[1],
        ),
      ),
    );
    return links
      .filter((href) => {
        const slug = href.toLowerCase();
        return Array.from(tokens).some((token) => {
          const value = token.toLowerCase();
          // YIFY sometimes concatenates names ("farsipersian"), so long
          // labels match as substrings while short codes stay delimited.
          return value.length >= 4
            ? slug.includes(value)
            : slug.includes(`-${value}-`);
        });
      })
      .slice(0, 10)
      .map((href) => {
        const slug = href.split('/').pop() || '';
        return {
          url: `${YIFY_SUBTITLES_BASE}${href.replace('/subtitles/', '/subtitle/')}.zip`,
          fileName: `${slug}.zip`,
          downloadCount: subtitleCandidateScore(slug, 0),
          source: 'yifysubtitles' as const,
        };
      });
  } catch {
    return [];
  }
}

/**
 * Yields candidates as soon as each catalog answers, so a slow provider never
 * delays a subtitle track that a fast provider already has.
 */
async function* candidatesByArrival(
  searches: Array<Promise<SubtitleCandidate[]>>,
): AsyncGenerator<SubtitleCandidate> {
  const pending = new Map<
    number,
    Promise<{ index: number; candidates: SubtitleCandidate[] }>
  >();
  searches.forEach((search, index) => {
    pending.set(
      index,
      search
        .then((candidates) => ({ index, candidates }))
        .catch(() => ({ index, candidates: [] as SubtitleCandidate[] })),
    );
  });

  while (pending.size > 0) {
    const { index, candidates } = await Promise.race(pending.values());
    pending.delete(index);
    for (const candidate of candidates) yield candidate;
  }
}

function isAllowedSubtitleHost(hostname: string): boolean {
  return (
    hostname === 'opensubtitles.org' ||
    hostname.endsWith('.opensubtitles.org') ||
    hostname === 'strem.io' ||
    hostname.endsWith('.strem.io') ||
    hostname === 'yifysubtitles.ch' ||
    hostname.endsWith('.yifysubtitles.ch')
  );
}

async function readStreamWithLimit(
  stream: ReadableStream<Uint8Array>,
  limit: number,
): Promise<Uint8Array | null> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      size += value.byteLength;
      if (size > limit) {
        await reader.cancel().catch(() => undefined);
        return null;
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  const merged = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return merged;
}

async function gunzipWithLimit(
  bytes: Uint8Array,
  limit: number,
  format: 'gzip' | 'deflate-raw' = 'gzip',
): Promise<Uint8Array | null> {
  try {
    const buffer = bytes.buffer.slice(
      bytes.byteOffset,
      bytes.byteOffset + bytes.byteLength,
    ) as ArrayBuffer;
    const stream = new Blob([buffer])
      .stream()
      .pipeThrough(new DecompressionStream(format));
    return await readStreamWithLimit(stream, limit);
  } catch {
    return null;
  }
}

interface ZipEntry {
  name: string;
  compression: number;
  compressedSize: number;
  uncompressedSize: number;
  localHeaderOffset: number;
}

function readZipEntries(bytes: Uint8Array): ZipEntry[] {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  // Find the End Of Central Directory record (max comment size is 64 KiB).
  let eocd = -1;
  const stop = Math.max(0, bytes.length - 66_000);
  for (let offset = bytes.length - 22; offset >= stop; offset--) {
    if (view.getUint32(offset, true) === 0x06054b50) {
      eocd = offset;
      break;
    }
  }
  if (eocd < 0) return [];

  const entryCount = view.getUint16(eocd + 10, true);
  let offset = view.getUint32(eocd + 16, true);
  const entries: ZipEntry[] = [];

  for (let index = 0; index < entryCount; index++) {
    if (offset + 46 > bytes.length) break;
    if (view.getUint32(offset, true) !== 0x02014b50) break;
    const compression = view.getUint16(offset + 10, true);
    const compressedSize = view.getUint32(offset + 20, true);
    const uncompressedSize = view.getUint32(offset + 24, true);
    const nameLength = view.getUint16(offset + 28, true);
    const extraLength = view.getUint16(offset + 30, true);
    const commentLength = view.getUint16(offset + 32, true);
    const localHeaderOffset = view.getUint32(offset + 42, true);
    const name = new TextDecoder('utf-8', { fatal: false }).decode(
      bytes.subarray(offset + 46, offset + 46 + nameLength),
    );
    entries.push({
      name,
      compression,
      compressedSize,
      uncompressedSize,
      localHeaderOffset,
    });
    offset += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}

function extractZipEntry(
  bytes: Uint8Array,
  entry: ZipEntry,
): Uint8Array | null {
  if (entry.localHeaderOffset + 30 > bytes.length) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (view.getUint32(entry.localHeaderOffset, true) !== 0x04034b50) {
    return null;
  }
  const nameLength = view.getUint16(entry.localHeaderOffset + 26, true);
  const extraLength = view.getUint16(entry.localHeaderOffset + 28, true);
  const dataStart = entry.localHeaderOffset + 30 + nameLength + extraLength;
  const dataEnd = dataStart + entry.compressedSize;
  if (dataStart > bytes.length || dataEnd > bytes.length) return null;
  return bytes.subarray(dataStart, dataEnd);
}

/**
 * YIFY Subtitles serves a ZIP per title. Extract the first readable subtitle
 * file so the response stays the same as the other catalogs.
 */
async function unzipFirstSubtitle(
  bytes: Uint8Array,
  limit: number,
): Promise<Uint8Array | null> {
  const entries = readZipEntries(bytes);
  if (entries.length === 0) return null;
  const preferred = entries
    .filter((entry) => !entry.name.endsWith('/'))
    .sort((a, b) => {
      const rank = (entry: ZipEntry) => {
        const name = entry.name.toLowerCase();
        if (name.endsWith('.srt')) return 0;
        if (name.endsWith('.vtt')) return 1;
        if (name.endsWith('.ass') || name.endsWith('.ssa')) return 2;
        if (name.endsWith('.txt')) return 3;
        return 4;
      };
      return rank(a) - rank(b);
    });

  for (const entry of preferred.slice(0, 6)) {
    if (entry.uncompressedSize > limit) continue;
    const data = extractZipEntry(bytes, entry);
    if (!data || data.length === 0) continue;
    if (entry.compression === 0) return data.slice(0, limit);
    if (entry.compression === 8) {
      const inflated = await gunzipWithLimit(data, limit, 'deflate-raw');
      if (inflated && inflated.length > 0) return inflated;
    }
  }
  return null;
}

async function downloadSubtitleText(
  url: string,
  language: SubtitleLanguage,
): Promise<string | null> {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (parsed.protocol !== 'https:' || !isAllowedSubtitleHost(parsed.hostname)) {
    return null;
  }

  try {
    const isYify = parsed.hostname.endsWith('yifysubtitles.ch');
    const response = await fetch(parsed, {
      cache: 'no-store',
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      headers: {
        Accept: '*/*',
        'User-Agent': isYify ? BROWSER_USER_AGENT : SUBTITLE_USER_AGENT,
        ...(isYify ? { Referer: `${YIFY_SUBTITLES_BASE}/` } : {}),
      },
    });
    if (!response.ok || !response.body) return null;

    const bytes = await readStreamWithLimit(
      response.body,
      MAX_COMPRESSED_BYTES,
    );
    if (!bytes || bytes.length === 0) return null;
    // Subtitle archives arrive as gzip streams, ZIP files (YIFY), or plain
    // SRT/VTT. Detect each one instead of assuming the catalog.
    const isGzip = bytes[0] === 0x1f && bytes[1] === 0x8b;
    const isZip =
      bytes[0] === 0x50 &&
      bytes[1] === 0x4b &&
      (bytes[2] === 0x03 || bytes[2] === 0x05 || bytes[2] === 0x07);
    let raw: Uint8Array | null = bytes;
    if (isGzip) {
      raw = await gunzipWithLimit(bytes, MAX_DECOMPRESSED_BYTES);
    } else if (isZip) {
      raw = await unzipFirstSubtitle(bytes, MAX_DECOMPRESSED_BYTES);
    }
    if (!raw || raw.length === 0) return null;
    return decodeSubtitleBytes(raw, language);
  } catch {
    return null;
  }
}

export async function GET(request: Request) {
  const searchParams = new URL(request.url).searchParams;
  const tmdbId = (searchParams.get('tmdbId') || '').trim();
  const mediaType = searchParams.get('type') === 'tv' ? 'tv' : 'movie';
  const language = normalizeLanguage(searchParams.get('lang'));
  const season = Number(searchParams.get('season')) || 1;
  const episode = Number(searchParams.get('episode')) || 1;

  if (!/^\d+$/.test(tmdbId) || Number(tmdbId) <= 0) {
    return noStoreJson({ error: 'Provide a valid TMDB id.' }, 400);
  }

  const imdbId =
    normalizeImdbId(searchParams.get('imdbId')) ??
    (await lookupImdbId(tmdbId, mediaType));
  if (!imdbId) {
    return noStoreJson({ error: 'No IMDb mapping for this title.' }, 404);
  }

  const cacheKey = `${imdbId}:${language}:${mediaType}:${season}:${episode}`;
  const cached = subtitleCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) {
    return noStoreJson(cached.payload, 200, 'private, max-age=1800');
  }

  const searches = [
    searchOpenSubtitles(imdbId, language, mediaType, season, episode),
    searchStremio(imdbId, language, mediaType, season, episode),
    searchYifysubtitles(imdbId, language, mediaType),
  ];
  const seenUrls = new Set<string>();

  for await (const candidate of candidatesByArrival(searches)) {
    if (seenUrls.has(candidate.url)) continue;
    seenUrls.add(candidate.url);

    const text = await downloadSubtitleText(candidate.url, language);
    if (!text) continue;
    const cues = parseSubtitleText(text).slice(0, MAX_CUES);
    if (cues.length === 0) continue;

    const payload: SubtitlesPayload = {
      ok: true,
      language,
      cues,
      meta: {
        fileName: candidate.fileName,
        source: candidate.source,
        downloadCount: candidate.downloadCount,
        fps: candidate.fps,
        cueCount: cues.length,
      },
    };

    subtitleCache.set(cacheKey, {
      expiresAt: Date.now() + CACHE_TTL_MS,
      payload,
    });
    if (subtitleCache.size > 50) {
      const oldestKey = subtitleCache.keys().next().value;
      if (oldestKey) subtitleCache.delete(oldestKey);
    }

    return noStoreJson(payload, 200, 'private, max-age=1800');
  }

  return noStoreJson({ error: 'No subtitles found.' }, 404);
}
