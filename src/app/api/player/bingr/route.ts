import { NextResponse } from 'next/server';

import { bingrMediaProxyUrl, unwrapBingrMediaUrl } from '@/lib/bingr-player';
import {
  normalizePositiveInteger,
  normalizeTmdbId,
  normalizeTmdbPlayerMediaType,
} from '@/lib/tmdb-player-sources';

const API = 'https://api.bingr.one/api';
const HEADERS = {
  Accept: 'application/json',
  'Accept-Language': 'en-US,en;q=0.9',
  'User-Agent':
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  Origin: 'https://bingr.one',
  Referer: 'https://bingr.one/',
};

function decodeBingrHtmlUrl(value: string): string {
  return value
    .replace(/\\u0026/gi, '&')
    .replace(/&amp;/gi, '&')
    .replace(/&quot;/gi, '"')
    .replace(/\\\//g, '/');
}

async function resolveBingrWatchPage(
  tmdbId: string,
  mediaType: string,
  season: number,
  episode: number,
  signal: AbortSignal,
): Promise<URL | null> {
  const pageUrl = new URL(`https://bingr.one/watch/${mediaType}/${tmdbId}`);
  if (mediaType === 'tv') {
    pageUrl.searchParams.set('s', String(season));
    pageUrl.searchParams.set('e', String(episode));
  }
  const response = await fetch(pageUrl, {
    signal,
    redirect: 'follow',
    headers: { ...HEADERS, Accept: 'text/html,application/xhtml+xml' },
  });
  if (!response.ok) return null;
  const html = await response.text();
  const matches = Array.from(
    new Set([
      ...(html.match(/https?:\/\/[^\s"'<]+\.m3u8[^\s"'<]*/gi) || []),
      ...(html.match(/https?:\\\/\\\/[^\s"'<]+\.m3u8[^\s"'<]*/gi) || []),
    ]),
  );
  for (const match of matches) {
    try {
      const raw = decodeBingrHtmlUrl(match).replace(/\\$/, '');
      const url = unwrapBingrMediaUrl(raw);
      return url;
    } catch {
      // Try the next manifest exposed by the watch page.
    }
  }
  return null;
}

export async function GET(request: Request) {
  const params = new URL(request.url).searchParams;
  const tmdbId = normalizeTmdbId(params.get('tmdbId'));
  if (!tmdbId)
    return NextResponse.json({ error: 'Invalid TMDB ID' }, { status: 400 });
  const mediaType = normalizeTmdbPlayerMediaType(params.get('type'));
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15000);
  const options = {
    signal: controller.signal,
    redirect: 'manual' as const,
    headers: HEADERS,
  };
  let failureCode = 'metadata-request';
  try {
    const detailsUrl = new URL('https://api.bingr.one');
    detailsUrl.pathname = `/api/details/${mediaType}/${Number(tmdbId)}`;
    const detailsResponse = await fetch(detailsUrl, options);
    if (!detailsResponse.ok) {
      failureCode = `metadata-http-${detailsResponse.status}`;
      throw new Error('Metadata unavailable');
    }
    failureCode = 'metadata-response';
    const details = (await detailsResponse.json()) as {
      title?: string;
      year?: string;
      imdb_id?: string;
    };
    const query: Record<string, string | number> = {};
    if (typeof details.title === 'string')
      query.title = details.title.slice(0, 300);
    if (typeof details.year === 'string')
      query.year = details.year.slice(0, 10);
    if (typeof details.imdb_id === 'string')
      query.imdb_id = details.imdb_id.slice(0, 30);
    const season = normalizePositiveInteger(params.get('season'), 1);
    const episode = normalizePositiveInteger(params.get('episode'), 1);
    if (mediaType === 'tv') {
      query.season = season;
      query.episode = episode;
    }
    failureCode = 'watch-page-request';
    try {
      const watchUrl = await resolveBingrWatchPage(
        String(tmdbId),
        mediaType,
        season,
        episode,
        controller.signal,
      );
      if (watchUrl) {
        return NextResponse.json(
          { streamUrl: bingrMediaProxyUrl(watchUrl.href), title: details.title },
          { headers: { 'Cache-Control': 'no-store' } },
        );
      }
    } catch {
      // The public API fallback below remains available for older deployments.
    }
    failureCode = 'stream-request';
    const response = await fetch(`${API}/stream`, {
      ...options,
      method: 'POST',
      headers: { ...HEADERS, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        srv: 's3',
        t: mediaType,
        id: String(tmdbId),
        query,
      }),
    });
    if (!response.ok) {
      failureCode = `stream-http-${response.status}`;
      throw new Error('Stream unavailable');
    }
    failureCode = 'stream-response';
    const payload = (await response.json()) as {
      sources?: Array<{ url?: string; type?: string }>;
    };
    failureCode = 'no-supported-media';
    for (const source of (payload.sources || []).slice(0, 8)) {
      if (
        typeof source.url !== 'string' ||
        !/mpegurl|hls/i.test(source.type || '')
      )
        continue;
      try {
        const url = unwrapBingrMediaUrl(source.url);
        return NextResponse.json(
          { streamUrl: bingrMediaProxyUrl(url.href), title: details.title },
          { headers: { 'Cache-Control': 'no-store' } },
        );
      } catch {
        /* Try another supported source. */
      }
    }
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
