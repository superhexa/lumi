import { NextResponse } from 'next/server';

import {
  type SubtitleCue,
  type SubtitleLanguage,
  decodeSubtitleBytes,
  parseSubtitleText,
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
const REQUEST_TIMEOUT_MS = 15_000;
const MAX_COMPRESSED_BYTES = 4 * 1024 * 1024;
const MAX_DECOMPRESSED_BYTES = 8 * 1024 * 1024;
const MAX_CUES = 10_000;
const CACHE_TTL_MS = 30 * 60_000;

type SubtitleSource = 'opensubtitles' | 'stremio';

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
  return /^tt\d{5,10}$/i.test(withPrefix)
    ? withPrefix.toLowerCase()
    : null;
}

function normalizeLanguage(value?: string | null): SubtitleLanguage {
  return subtitleLanguageFromLocale(value);
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

async function searchOpenSubtitles(
  imdbId: string,
  language: SubtitleLanguage,
  mediaType: string,
  season: number,
  episode: number,
): Promise<SubtitleCandidate[]> {
  const numericImdb = imdbId.replace(/^tt/i, '');
  const languageId = language === 'ar' ? 'ara' : 'eng';
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
        return {
          url: record.SubDownloadLink || '',
          fileName: record.SubFileName || 'subtitles.srt',
          downloadCount: hearingImpaired ? Math.floor(downloads / 4) : downloads,
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
  const suffix =
    mediaType === 'tv'
      ? `${imdbId}:${season}:${episode}`
      : imdbId;
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
    const languagePrefix = language === 'ar' ? 'ar' : 'en';

    return records
      .filter((record) => Boolean(record?.url))
      .filter((record) =>
        (record.lang || '').toLowerCase().startsWith(languagePrefix),
      )
      .filter((record) => !/(?:^|[.\s_-])(hi|sdh)(?:[.\s_-]|$)/i.test(record.subtitleFileName || ''))
      .map((record) => {
        const downloads = Number(record.g) || 0;
        const utf8 = (record.SubEncoding || '').toUpperCase() === 'UTF-8';
        const fpsMilli = Number(record.fpsMilli);
        return {
          url: record.url || '',
          fileName: record.subtitleFileName || 'subtitles.srt',
          downloadCount: downloads + (utf8 ? 5 : 0),
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

function isAllowedSubtitleHost(hostname: string): boolean {
  return (
    hostname === 'opensubtitles.org' ||
    hostname.endsWith('.opensubtitles.org') ||
    hostname === 'strem.io' ||
    hostname.endsWith('.strem.io')
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
): Promise<Uint8Array | null> {
  try {
    const buffer = bytes.buffer.slice(
      bytes.byteOffset,
      bytes.byteOffset + bytes.byteLength,
    ) as ArrayBuffer;
    const stream = new Blob([buffer])
      .stream()
      .pipeThrough(new DecompressionStream('gzip'));
    return await readStreamWithLimit(stream, limit);
  } catch {
    return null;
  }
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
    const response = await fetch(parsed, {
      cache: 'no-store',
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      headers: {
        Accept: '*/*',
        'User-Agent': SUBTITLE_USER_AGENT,
      },
    });
    if (!response.ok || !response.body) return null;

    const bytes = await readStreamWithLimit(
      response.body,
      MAX_COMPRESSED_BYTES,
    );
    if (!bytes || bytes.length === 0) return null;
    // Subtitle archives are gzip streams; a zip (PK) or HTML error page will
    // simply fail to parse into cues further down.
    const isGzip = bytes[0] === 0x1f && bytes[1] === 0x8b;
    const raw = isGzip
      ? await gunzipWithLimit(bytes, MAX_DECOMPRESSED_BYTES)
      : bytes;
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

  const candidates = [
    ...(await searchOpenSubtitles(
      imdbId,
      language,
      mediaType,
      season,
      episode,
    )),
    ...(await searchStremio(imdbId, language, mediaType, season, episode)),
  ];
  const seenUrls = new Set<string>();

  for (const candidate of candidates) {
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
