import { NextResponse } from 'next/server';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function cacheKey(tmdbId: number, mediaType: string, season: number, episode: number): string {
  return mediaType === 'tv'
    ? `lumi-cinesrc-${tmdbId}-tv-${season}-${episode}.json`
    : `lumi-cinesrc-${tmdbId}-movie.json`;
}

async function cacheRequest(request: Request, paramsUrl: URL) {
  const tmdbId = Number(paramsUrl.searchParams.get('tmdbId'));
  const mediaType = paramsUrl.searchParams.get('type') === 'tv' ? 'tv' : 'movie';
  const season = Math.max(1, Number(paramsUrl.searchParams.get('season')) || 1);
  const episode = Math.max(1, Number(paramsUrl.searchParams.get('episode')) || 1);
  const streamUrl = paramsUrl.searchParams.get('url');
  if (!Number.isInteger(tmdbId) || tmdbId <= 0 || !streamUrl) {
    return NextResponse.json({ error: 'Invalid cache request' }, { status: 400 });
  }
  let url: URL;
  try {
    url = new URL(streamUrl);
  } catch {
    return NextResponse.json({ error: 'Invalid stream URL' }, { status: 400 });
  }
  if (
    url.protocol !== 'https:' ||
    url.hostname !== 'cinesrc.st' ||
    (!url.pathname.startsWith('/api/playlist/') && !/\.m3u8(?:$|\?)/i.test(url.pathname + url.search))
  ) {
    return NextResponse.json({ error: 'Unsupported CineSrc stream URL' }, { status: 400 });
  }
  const payload = { streamUrl: url.toString(), createdAt: Date.now(), tmdbId, mediaType, season, episode };
  await fs.writeFile(join(tmpdir(), cacheKey(tmdbId, mediaType, season, episode)), JSON.stringify(payload), 'utf8');
  await fs.writeFile(join(tmpdir(), `lumi-cinesrc-${tmdbId}.json`), JSON.stringify(payload), 'utf8');
  return NextResponse.json({ cached: true, tmdbId, mediaType, season, episode, streamUrl: url.toString() });
}

export async function GET(request: Request) {
  return cacheRequest(request, new URL(request.url));
}

export async function POST(request: Request) {
  const search = new URL(request.url);
  try {
    const payload = await request.json() as { tmdbId?: number; type?: string; season?: number; episode?: number; url?: string };
    if (payload.url) search.searchParams.set('url', payload.url);
    if (payload.tmdbId) search.searchParams.set('tmdbId', String(payload.tmdbId));
    if (payload.type) search.searchParams.set('type', payload.type);
    if (payload.season) search.searchParams.set('season', String(payload.season));
    if (payload.episode) search.searchParams.set('episode', String(payload.episode));
  } catch {
    return NextResponse.json({ error: 'Invalid JSON payload' }, { status: 400 });
  }
  return cacheRequest(request, search);
}
