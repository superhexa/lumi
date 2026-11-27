import { NextResponse } from 'next/server';

import {
  bingrMediaProxyUrl,
  unwrapBingrMediaUrl,
  validateBingrMediaUrl,
} from '@/lib/bingr-player';
import {
  type BingrSourcesPayload,
  decodeBingrSealedPayload,
  extractBingrWatchToken,
  rankBingrStreams,
} from '@/lib/bingr-sources';
import {
  normalizePositiveInteger,
  normalizeTmdbId,
  normalizeTmdbPlayerMediaType,
} from '@/lib/tmdb-player-sources';

const API = 'https://api.bingr.one/api';
const BINGR_ORIGIN = 'https://bingr.one';
const SERVER_IDS = ['s31', 's40', 's50', 's51', 's62', 's70', 's80', 's81'];
const HEADERS = {
  Accept: 'application/json',
  'Accept-Language': 'en-US,en;q=0.9',
  'User-Agent':
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  Origin: BINGR_ORIGIN,
  Referer: `${BINGR_ORIGIN}/`,
};

interface BingrWatchPage {
  token: string | null;
  manifestUrls: URL[];
}

/**
 * Links a per-request timeout to the route's overall abort signal so a single
 * stalled CDN cannot consume the whole budget. `AbortSignal.timeout` uses an
 * unref'd timer, so idle requests never keep the process alive.
 */
function requestSignal(parent: AbortSignal, timeoutMs: number): AbortSignal {
  const timeout = AbortSignal.timeout(timeoutMs);
  const anySignal = (
    AbortSignal as unknown as {
      any?: (signals: AbortSignal[]) => AbortSignal;
    }
  ).any;
  if (typeof anySignal === 'function') return anySignal([parent, timeout]);
  return timeout;
}

function decodeBingrHtmlUrl(value: string): string {
  return value
    .replace(/\\u0026/gi, '&')
    .replace(/&amp;/gi, '&')
    .replace(/&quot;/gi, '"')
    .replace(/\\\//g, '/');
}

function watchPageUrl(
  tmdbId: string,
  mediaType: string,
  season: number,
  episode: number,
): URL {
  return new URL(
    mediaType === 'tv'
      ? `${BINGR_ORIGIN}/watch/tv/${tmdbId}/${season}/${episode}`
      : `${BINGR_ORIGIN}/watch/movie/${tmdbId}`,
  );
}

/**
 * Reads the signed player token and every manifest embedded in the watch page.
 * The token unlocks `/api/sources`, which lists H.264 servers that the page
 * itself does not embed (it only preloads the first, often HEVC, server).
 */
async function fetchBingrWatchPage(
  tmdbId: string,
  mediaType: string,
  season: number,
  episode: number,
  signal: AbortSignal,
): Promise<BingrWatchPage | null> {
  const pageUrl = watchPageUrl(tmdbId, mediaType, season, episode);
  const response = await fetch(pageUrl, {
    signal: requestSignal(signal, 12_000),
    redirect: 'follow',
    headers: {
      ...HEADERS,
      Accept: 'text/html,application/xhtml+xml',
      Referer: `${BINGR_ORIGIN}/`,
    },
  });
  if (!response.ok) return null;
  const html = await response.text();

  const manifestUrls: URL[] = [];
  const matches = Array.from(
    new Set([
      ...(html.match(/https?:\/\/[^\s"'<]+\.m3u8[^\s"'<]*/gi) || []),
      ...(html.match(/https?:\\\/\\\/[^\s"'<]+\.m3u8[^\s"'<]*/gi) || []),
    ]),
  );
  for (const match of matches) {
    try {
      const raw = decodeBingrHtmlUrl(match).replace(/\\$/, '');
      manifestUrls.push(unwrapBingrMediaUrl(raw));
    } catch {
      // Ignore manifests that are not on an allowlisted media host.
    }
  }

  return { token: extractBingrWatchToken(html), manifestUrls };
}

async function fetchBingrSources(
  token: string,
  tmdbId: string,
  mediaType: string,
  season: number,
  episode: number,
  providerId: string | undefined,
  signal: AbortSignal,
): Promise<BingrSourcesPayload | null> {
  const url = new URL(`${BINGR_ORIGIN}/api/sources`);
  url.searchParams.set('kind', mediaType);
  url.searchParams.set('t', token);
  url.searchParams.set('tmdb', tmdbId);
  // `hevc=0` asks Bingr to skip servers that only serve H.265, which Chrome
  // and Firefox cannot play through Media Source Extensions.
  url.searchParams.set('hevc', '0');
  if (mediaType === 'tv') {
    url.searchParams.set('s', String(season));
    url.searchParams.set('e', String(episode));
  }
  if (providerId) url.searchParams.set('provider', providerId);

  try {
    const response = await fetch(url, {
      signal: requestSignal(signal, 12_000),
      cache: 'no-store',
      headers: {
        ...HEADERS,
        Referer: watchPageUrl(tmdbId, mediaType, season, episode).href,
      },
    });
    if (!response.ok) return null;
    const body = (await response.text()).trim();
    if (!body) return null;
    if (body.startsWith('v1.')) {
      return decodeBingrSealedPayload<BingrSourcesPayload>(body);
    }
    try {
      return JSON.parse(body) as BingrSourcesPayload;
    } catch {
      return null;
    }
  } catch {
    return null;
  }
}

interface ProbedMedia {
  url: URL;
  contentType: 'application/vnd.apple.mpegurl' | 'video/mp4';
}

async function probeBingrMedia(
  value: string,
  signal: AbortSignal,
): Promise<ProbedMedia | null> {
  let url: URL;
  try {
    url = validateBingrMediaUrl(value);
  } catch {
    return null;
  }
  try {
    const response = await fetch(url, {
      signal: requestSignal(signal, 12_000),
      redirect: 'follow',
      headers: { ...HEADERS, Range: 'bytes=0-4095' },
    });
    if (!response.ok) return null;
    const contentType = (
      response.headers.get('content-type') || ''
    ).toLowerCase();
    const looksLikePlaylist =
      url.pathname.endsWith('.m3u8') || /mpegurl|x-mpegurl/.test(contentType);
    if (looksLikePlaylist) {
      const manifest = await response.text();
      if (!manifest.trimStart().startsWith('#EXTM3U')) return null;
      return { url, contentType: 'application/vnd.apple.mpegurl' };
    }

    const looksLikeMp4 =
      url.pathname.endsWith('.mp4') ||
      /video\/mp4|application\/mp4/.test(contentType);
    if (!looksLikeMp4) return null;
    const buffer = await response.arrayBuffer();
    const bytes = new Uint8Array(buffer.slice(0, 16));
    const hasFtyp =
      bytes.length >= 8 &&
      bytes[4] === 0x66 &&
      bytes[5] === 0x74 &&
      bytes[6] === 0x79 &&
      bytes[7] === 0x70;
    if (!hasFtyp && !/video\/mp4/.test(contentType)) return null;
    return { url, contentType: 'video/mp4' };
  } catch {
    return null;
  }
}

function collectBingrStreams(
  payloads: Array<BingrSourcesPayload | null>,
): BingrSourcesPayload['streams'] {
  const seen = new Set<string>();
  const streams: NonNullable<BingrSourcesPayload['streams']> = [];
  for (const payload of payloads) {
    if (!payload) continue;
    for (const stream of [
      ...(payload.streams || []),
      ...(payload.sources || []),
    ]) {
      if (!stream?.url || seen.has(stream.url)) continue;
      seen.add(stream.url);
      streams.push(stream);
    }
  }
  return streams;
}

async function resolveBingrSourceStream(
  tmdbId: string,
  mediaType: string,
  season: number,
  episode: number,
  signal: AbortSignal,
): Promise<ProbedMedia | null> {
  const watch = await fetchBingrWatchPage(
    tmdbId,
    mediaType,
    season,
    episode,
    signal,
  );
  if (!watch?.token) return null;

  const first = await fetchBingrSources(
    watch.token,
    tmdbId,
    mediaType,
    season,
    episode,
    undefined,
    signal,
  );

  const tryPayloads = async (
    payloads: Array<BingrSourcesPayload | null>,
  ): Promise<ProbedMedia | null> => {
    const ranked = rankBingrStreams(collectBingrStreams(payloads) || []);
    const seen = new Set<string>();
    for (const stream of ranked.slice(0, 24)) {
      const value = stream.url || '';
      if (!value || seen.has(value)) continue;
      seen.add(value);
      const media = await probeBingrMedia(value, signal);
      if (media) return media;
    }
    return null;
  };

  // Fast path: the default source list usually already contains a playable
  // H.264 stream.
  const firstMedia = await tryPayloads([first]);
  if (firstMedia) return firstMedia;

  const serverIds = Array.from(
    new Set([
      ...(first?.servers || [])
        .map((server) => server.id)
        .filter(
          (id): id is string => Boolean(id) && id !== first?.provider?.id,
        ),
      ...SERVER_IDS,
    ]),
  ).slice(0, 12);

  // Ask every server in parallel; each request has its own short timeout so
  // one dead CDN cannot stall the whole resolution.
  const payloads = await Promise.all(
    serverIds.map((serverId) =>
      fetchBingrSources(
        watch.token as string,
        tmdbId,
        mediaType,
        season,
        episode,
        serverId,
        signal,
      ),
    ),
  );

  return tryPayloads(payloads);
}

export async function GET(request: Request) {
  const params = new URL(request.url).searchParams;
  const tmdbId = normalizeTmdbId(params.get('tmdbId'));
  if (!tmdbId)
    return NextResponse.json({ error: 'Invalid TMDB ID' }, { status: 400 });
  const mediaType = normalizeTmdbPlayerMediaType(params.get('type'));
  const season = normalizePositiveInteger(params.get('season'), 1);
  const episode = normalizePositiveInteger(params.get('episode'), 1);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 45000);
  const options = {
    signal: controller.signal,
    redirect: 'manual' as const,
    headers: HEADERS,
  };
  let failureCode = 'metadata-request';
  try {
    const detailsUrl = new URL('https://api.bingr.one');
    detailsUrl.pathname = `/api/details/${mediaType}/${Number(tmdbId)}`;
    const detailsResponse = await fetch(detailsUrl, {
      ...options,
      signal: requestSignal(controller.signal, 12_000),
    });
    let details: { title?: string; year?: string; imdb_id?: string } = {};
    if (detailsResponse.ok) {
      failureCode = 'metadata-response';
      details = (await detailsResponse
        .json()
        .catch(() => ({}))) as typeof details;
    } else {
      failureCode = `metadata-http-${detailsResponse.status}`;
    }

    // Preferred path: decode Bingr's own server list and pick an H.264 stream.
    failureCode = 'sources-request';
    try {
      const sourceUrl = await resolveBingrSourceStream(
        String(tmdbId),
        mediaType,
        season,
        episode,
        controller.signal,
      );
      if (sourceUrl) {
        return NextResponse.json(
          {
            streamUrl: bingrMediaProxyUrl(sourceUrl.url.href),
            contentType: sourceUrl.contentType,
            title: details.title,
          },
          { headers: { 'Cache-Control': 'no-store' } },
        );
      }
    } catch {
      // Fall through to the legacy resolver below.
    }

    const query: Record<string, string | number> = {};
    if (typeof details.title === 'string')
      query.title = details.title.slice(0, 300);
    if (typeof details.year === 'string')
      query.year = details.year.slice(0, 10);
    if (typeof details.imdb_id === 'string')
      query.imdb_id = details.imdb_id.slice(0, 30);
    if (mediaType === 'tv') {
      query.season = season;
      query.episode = episode;
    }

    // Legacy path: Bingr's POST endpoint is often blocked by its CDN, but when
    // it answers it can expose additional sources.
    failureCode = 'stream-request';
    const responses = await Promise.allSettled(
      SERVER_IDS.map((srv) =>
        fetch(`${API}/stream`, {
          ...options,
          signal: requestSignal(controller.signal, 12_000),
          method: 'POST',
          headers: { ...HEADERS, 'Content-Type': 'application/json' },
          body: JSON.stringify({
            srv,
            t: mediaType,
            id: String(tmdbId),
            query,
          }),
        }),
      ),
    );
    failureCode = 'stream-response';
    const candidates: URL[] = [];
    for (const result of responses) {
      if (result.status !== 'fulfilled' || !result.value?.ok) continue;
      let payload: { sources?: Array<{ url?: string; type?: string }> };
      try {
        payload = (await result.value.json()) as typeof payload;
      } catch {
        continue;
      }
      for (const source of (payload.sources || []).slice(0, 20)) {
        if (typeof source.url !== 'string') continue;
        try {
          candidates.push(unwrapBingrMediaUrl(source.url));
        } catch {
          // Try the next server/source returned by Bingr.
        }
      }
    }
    candidates.sort((a, b) => {
      const rank = (url: URL) => {
        if (/\.hscow\.com$/.test(url.hostname)) return 5;
        if (/\.streamrip\.fun$/.test(url.hostname)) return 4;
        if (/\.rousav\.tech$/.test(url.hostname)) return 3;
        if (/\.workers\.dev$/.test(url.hostname)) return 2;
        return 1;
      };
      return rank(b) - rank(a);
    });
    for (const url of candidates.slice(0, 12)) {
      const probed = await probeBingrMedia(url.href, controller.signal);
      if (probed) {
        return NextResponse.json(
          {
            streamUrl: bingrMediaProxyUrl(probed.url.href),
            contentType: probed.contentType,
            title: details.title,
          },
          { headers: { 'Cache-Control': 'no-store' } },
        );
      }
    }

    // Last resort: the manifest embedded in the watch page (may be HEVC only).
    failureCode = 'watch-page-request';
    try {
      const watch = await fetchBingrWatchPage(
        String(tmdbId),
        mediaType,
        season,
        episode,
        controller.signal,
      );
      const ordered = (watch?.manifestUrls || []).slice().sort((a, b) => {
        const rank = (url: URL) => {
          if (url.hostname.endsWith('.rousav.tech')) return 4;
          if (url.hostname.endsWith('.hscow.com')) return 3;
          if (url.hostname.endsWith('.streamrip.fun')) return 2;
          if (url.hostname.endsWith('.workers.dev')) return 1;
          return 0;
        };
        return rank(b) - rank(a);
      });
      for (const url of ordered) {
        const probed = await probeBingrMedia(url.href, controller.signal);
        if (probed) {
          return NextResponse.json(
            {
              streamUrl: bingrMediaProxyUrl(probed.url.href),
              contentType: probed.contentType,
              title: details.title,
            },
            { headers: { 'Cache-Control': 'no-store' } },
          );
        }
      }
    } catch {
      // Continue to a consistent provider error response.
    }
    failureCode = 'no-supported-media';
    throw new Error('No supported stream');
  } catch {
    return NextResponse.json(
      { error: 'Bingr is unavailable for this title', code: failureCode },
      { status: 502, headers: { 'Cache-Control': 'no-store' } },
    );
  } finally {
    clearTimeout(timeout);
  }
}
