import { NextResponse } from 'next/server';

import {
  normalizeTmdbId,
  normalizeTmdbPlayerMediaType,
} from '@/lib/tmdb-player-sources';

const TMDB_BASE = 'https://api.themoviedb.org/3';
const ARCHIVE_SEARCH = 'https://archive.org/advancedsearch.php';
const ARCHIVE_METADATA = 'https://archive.org/metadata';

function normalizeText(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function textSimilarity(query: string, candidate: string): number {
  const normalize = (value: string) =>
    value
      .toLowerCase()
      .normalize('NFKC')
      .replace(/[^a-z0-9\u0600-\u06FF\s]/gi, ' ')
      .split(/\s+/)
      .filter((word) => word.length > 1);
  const q = new Set(normalize(query));
  const c = normalize(candidate);
  if (!q.size || !c.length) return 0;
  const matches = c.filter((word) => q.has(word)).length;
  return matches / Math.max(q.size, 1);
}

function isVerifiedOpenLicense(metadata: Record<string, unknown>): boolean {
  const values = [metadata.licenseurl, metadata.rights, metadata.license, metadata.rights_statement]
    .filter((value): value is string => typeof value === 'string')
    .join(' ')
    .toLowerCase();
  return values.includes('creativecommons.org/') || values.includes('public domain') || values.includes('public-domain');
}

function choosePlayableFile(metadata: Record<string, unknown>): { file: string; type: string } | null {
  const files = Array.isArray(metadata.files) ? metadata.files : [];
  const playable = files
    .filter((file): file is Record<string, unknown> => typeof file === 'object' && file !== null)
    .filter((file) => typeof file.name === 'string')
    .map((file) => ({
      name: String(file.name),
      format: normalizeText(file.format).toLowerCase(),
      source: normalizeText(file.source).toLowerCase(),
      size: Number(file.size || 0),
    }))
    .filter((file) => !file.name.includes('/'))
    .filter((file) => /\.(mp4|webm|ogv)$/i.test(file.name))
    .filter((file) => /mp4|webm|ogg|mpeg4/i.test(file.format))
    .sort((a, b) => {
      const quality = (value: string) => (/1920|1080|high/i.test(value) ? 3 : /1280|720/i.test(value) ? 2 : 1);
      return quality(b.format) - quality(a.format) || b.size - a.size;
    });
  const first = playable[0];
  if (!first) return null;
  return {
    file: first.name,
    type: first.name.endsWith('.webm')
      ? 'video/webm'
      : first.name.endsWith('.ogv')
        ? 'video/ogg'
        : 'video/mp4',
  };
}

async function fetchTmdbTitle(tmdbId: number, mediaType: 'movie' | 'tv', language: string, signal: AbortSignal) {
  const key = process.env.TMDB_API_KEY || process.env.NEXT_PUBLIC_TMDB_API_KEY;
  if (!key) return null;
  const url = new URL(`${TMDB_BASE}/${mediaType}/${tmdbId}`);
  url.searchParams.set('api_key', key);
  url.searchParams.set('language', language || 'ar-EG');
  const response = await fetch(url, { signal, headers: { Accept: 'application/json' } });
  if (!response.ok) return null;
  const data = await response.json() as { title?: string; name?: string; original_title?: string; original_name?: string; release_date?: string; first_air_date?: string };
  return {
    title: normalizeText(data.title || data.name),
    originalTitle: normalizeText(data.original_title || data.original_name),
    year: normalizeText((data.release_date || data.first_air_date || '').slice(0, 4)),
  };
}

function safeIdentifier(value: string): boolean {
  return /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,199}$/.test(value);
}

function safeMediaFile(value: string): boolean {
  return value.length > 0 && value.length <= 300 && !value.includes('/') && !value.includes('\\') && !/[\0\r\n]/.test(value);
}

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  if (searchParams.get('media') === '1') {
    const identifier = searchParams.get('identifier') || '';
    const file = searchParams.get('file') || '';
    if (!safeIdentifier(identifier) || !safeMediaFile(file)) {
      return new Response('Invalid media identifier', { status: 400 });
    }
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 30_000);
    try {
      const upstream = `https://archive.org/download/${encodeURIComponent(identifier)}/${encodeURIComponent(file)}`;
      const headers: HeadersInit = { Accept: '*/*', 'User-Agent': 'Mozilla/5.0 Lumi/1.0', Referer: 'https://archive.org/' };
      const range = request.headers.get('range');
      if (range && /^bytes=\d*-\d*$/.test(range)) (headers as Record<string, string>).Range = range;
      const response = await fetch(upstream, { headers, signal: controller.signal, redirect: 'follow' });
      if (!response.ok) return new Response('Archive media unavailable', { status: 502 });
      const output = new Headers({ 'Cache-Control': 'public, max-age=3600', 'X-Content-Type-Options': 'nosniff' });
      for (const name of ['content-type', 'content-length', 'content-range', 'accept-ranges', 'etag', 'last-modified']) {
        const value = response.headers.get(name);
        if (value) output.set(name, value);
      }
      return new Response(response.body, { status: response.status, headers: output });
    } catch {
      return new Response('Archive media unavailable', { status: 502 });
    } finally {
      clearTimeout(timeout);
    }
  }

  const tmdbId = normalizeTmdbId(searchParams.get('tmdbId'));
  if (!tmdbId) return NextResponse.json({ error: 'Invalid TMDB ID' }, { status: 400 });
  const mediaType = normalizeTmdbPlayerMediaType(searchParams.get('type'));
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 20_000);

  try {
    const tmdb = await fetchTmdbTitle(tmdbId, mediaType, searchParams.get('language') || 'ar-EG', controller.signal);
    const requestedTitle = normalizeText(searchParams.get('title'));
    const titles = Array.from(new Set([requestedTitle, tmdb?.title, tmdb?.originalTitle].filter(Boolean) as string[]));
    if (!titles.length) return NextResponse.json({ error: 'No searchable title' }, { status: 404 });

    const year = tmdb?.year || normalizeText(searchParams.get('year'));
    const candidates = new Map<string, Record<string, unknown>>();
    for (const title of titles.slice(0, 3)) {
      const words = title.split(/\s+/).filter((word) => word.length >= 3).slice(0, 8);
      const titleQuery = title.includes(' ') ? words.join(' AND ') : title;
      const yearClause = year ? ` AND (year:${year} OR date:${year}*)` : '';
      const query = `(title:("${titleQuery}" OR ${titleQuery}) OR description:("${titleQuery}" OR ${titleQuery})) AND mediatype:movies${yearClause}`;
      const url = new URL(ARCHIVE_SEARCH);
      url.searchParams.set('q', query);
      url.searchParams.set('fl[]', 'identifier,title,date,year,description,subject,language,licenseurl,rights,collection');
      url.searchParams.set('rows', '50');
      url.searchParams.set('page', '1');
      url.searchParams.set('output', 'json');
      url.searchParams.set('sort[]', 'downloads desc');
      const response = await fetch(url, { signal: controller.signal, headers: { Accept: 'application/json' } });
      if (!response.ok) continue;
      const payload = await response.json() as { response?: { docs?: Array<Record<string, unknown>> } };
      for (const doc of payload.response?.docs || []) {
        const identifier = normalizeText(doc.identifier);
        if (identifier && !candidates.has(identifier)) candidates.set(identifier, doc);
      }
    }

    const ranked = Array.from(candidates.entries()).sort((a, b) => {
      const score = (entry: [string, Record<string, unknown>]) => {
        const doc = entry[1];
        const title = normalizeText(doc.title);
        const titleScore = Math.max(...titles.map((queryTitle) => textSimilarity(queryTitle, title)));
        const yearScore = year && normalizeText(doc.year) === year ? 0.5 : 0;
        const licenseScore = isVerifiedOpenLicense(doc) ? 0.35 : 0;
        return titleScore + yearScore + licenseScore;
      };
      return score(b) - score(a);
    });

    for (const [identifier, searchDoc] of ranked.slice(0, 40)) {
      const metadataResponse = await fetch(`${ARCHIVE_METADATA}/${encodeURIComponent(identifier)}`, {
        signal: controller.signal,
        headers: { Accept: 'application/json' },
      });
      if (!metadataResponse.ok) continue;
      const metadata = await metadataResponse.json() as Record<string, unknown>;
      if (!isVerifiedOpenLicense(metadata)) continue;
      const playable = choosePlayableFile(metadata);
      if (!playable) continue;
      const streamUrl = `/api/player/archive?media=1&identifier=${encodeURIComponent(identifier)}&file=${encodeURIComponent(playable.file)}`;
      return NextResponse.json({
        streamUrl,
        title: normalizeText(metadata.title || searchDoc.title) || titles[0],
        contentType: playable.type,
        identifier,
        license: normalizeText(metadata.licenseurl || metadata.rights || metadata.license),
      }, { headers: { 'Cache-Control': 'no-store' } });
    }

    return NextResponse.json({ error: 'No verified Internet Archive video found for this title' }, { status: 404 });
  } catch {
    return NextResponse.json({ error: 'Internet Archive search failed', code: 'archive-search-failed' }, { status: 502 });
  } finally {
    clearTimeout(timeout);
  }
}
