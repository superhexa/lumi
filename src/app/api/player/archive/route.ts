import { NextResponse } from 'next/server';

import {
  normalizeTmdbId,
  normalizeTmdbPlayerMediaType,
} from '@/lib/tmdb-player-sources';

const TMDB_BASE = 'https://api.themoviedb.org/3';
const ARCHIVE_SEARCH = 'https://archive.org/advancedsearch.php';
const ARCHIVE_METADATA = 'https://archive.org/metadata';
const SEARCH_TIMEOUT_MS = 28_000;

interface ArchiveStream {
  streamUrl: string;
  contentType: 'video/mp4' | 'video/webm' | 'video/ogg';
  title: string;
  identifier: string;
  file: string;
  license: string;
  resolution: string;
}

const archiveResultCache = new Map<string, { expires: number; result: ArchiveStream[] }>();

function normalizeText(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function normalizeTitle(value: string): string {
  return value
    .normalize('NFKC')
    .replace(/&amp;/gi, '&')
    .replace(/[^a-z0-9\u0600-\u06ff\s]/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

function titleSimilarity(query: string, candidate: string): number {
  const q = normalizeTitle(query);
  const c = normalizeTitle(candidate);
  if (!q || !c) return 0;
  if (q === c) return 1;
  if (c.includes(q) || q.includes(c)) return 0.9;
  const qWords = new Set(q.split(' ').filter((word) => word.length > 1));
  const cWords = new Set(c.split(' ').filter((word) => word.length > 1));
  if (!qWords.size || !cWords.size) return 0;
  let matches = 0;
  qWords.forEach((word) => {
    if (cWords.has(word) || Array.from(cWords).some((candidateWord) => candidateWord.includes(word) || word.includes(candidateWord))) matches += 1;
  });
  return matches / Math.max(qWords.size, 1);
}

function isVerifiedOpenLicense(value: Record<string, unknown>): boolean {
  const text = [value.licenseurl, value.rights, value.rights_statement, value.license]
    .filter((item): item is string => typeof item === 'string')
    .join(' ')
    .toLowerCase();
  if (!text) return false;
  if (/copyrighted|all rights reserved|copyright \u00a9|copyright:/i.test(text)) return false;
  return (
    text.includes('creativecommons.org/') ||
    /public domain|public-domain|no copyright|no known copyright|cc0|united states government work/i.test(text)
  );
}

function resolutionForFile(name: string, format: string): { rank: number; label: string } {
  const text = `${name} ${format}`;
  const explicit = text.match(/(?:1920\s*[x×]\s*1080|1080p)/i);
  if (explicit) return { rank: 400, label: '1080p' };
  if (/1280\s*[x×]\s*720|720p/i.test(text)) return { rank: 300, label: '720p' };
  if (/854\s*[x×]\s*480|480p/i.test(text)) return { rank: 200, label: '480p' };
  if (/640\s*[x×]\s*360|360p/i.test(text)) return { rank: 100, label: '360p' };
  if (/webm/i.test(name) && /mpeg4|h\.264/i.test(format)) return { rank: 250, label: 'HD' };
  return { rank: 50, label: 'SD' };
}

function choosePlayableFiles(metadata: Record<string, unknown>, identifier: string): ArchiveStream[] {
  const files = Array.isArray(metadata.files) ? metadata.files : [];
  const playable = files
    .filter((file): file is Record<string, unknown> => typeof file === 'object' && file !== null)
    .map((file) => ({
      name: normalizeText(file.name),
      format: normalizeText(file.format).toLowerCase(),
      source: normalizeText(file.source).toLowerCase(),
      size: Number(file.size || 0),
    }))
    .filter((file) => file.name && !file.name.includes('/') && !file.name.includes('\\'))
    .filter((file) => !/(sample|preview|trailer|thumb|poster)/i.test(file.name))
    .filter((file) => /\.(mp4|webm|ogv)$/i.test(file.name))
    .filter((file) => /mp4|webm|ogv|ogg|mpeg4/i.test(file.format))
    .map((file) => {
      const resolution = resolutionForFile(file.name, file.format);
      const extensionRank = file.name.endsWith('.mp4') ? 40 : file.name.endsWith('.webm') ? 30 : 20;
      const sourceRank = file.source === 'original' ? 25 : file.source === 'derivative' ? 15 : 10;
      return { ...file, resolution, score: resolution.rank + extensionRank + sourceRank };
    })
    .sort((a, b) => b.score - a.score || b.size - a.size);

  const unique = new Map<string, typeof playable[number]>();
  playable.forEach((file) => {
    if (!unique.has(file.name)) unique.set(file.name, file);
  });

  return Array.from(unique.values()).slice(0, 6).map((file) => {
    const contentType = file.name.endsWith('.webm') ? 'video/webm' : file.name.endsWith('.ogv') ? 'video/ogg' : 'video/mp4';
    return {
      streamUrl: `/api/player/archive?media=1&identifier=${encodeURIComponent(identifier)}&file=${encodeURIComponent(file.name)}`,
      contentType,
      title: normalizeText(metadata.title) || identifier,
      identifier,
      file: file.name,
      license: normalizeText(metadata.licenseurl || metadata.rights || metadata.license || metadata.rights_statement),
      resolution: file.resolution.label,
    };
  });
}

function safeIdentifier(value: string): boolean {
  return /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,199}$/.test(value);
}

function safeMediaFile(value: string): boolean {
  return value.length > 0 && value.length <= 300 && !/[\\/\0\r\n]/.test(value) && /\.(mp4|webm|ogv)$/i.test(value);
}

async function fetchTmdbMetadata(tmdbId: number, mediaType: 'movie' | 'tv', language: string, signal: AbortSignal) {
  const key = process.env.TMDB_API_KEY || process.env.NEXT_PUBLIC_TMDB_API_KEY;
  if (!key) return null;
  const detailUrl = new URL(`${TMDB_BASE}/${mediaType}/${tmdbId}`);
  detailUrl.searchParams.set('api_key', key);
  detailUrl.searchParams.set('language', language || 'ar-EG');
  const alternativesUrl = new URL(`${TMDB_BASE}/${mediaType}/${tmdbId}/alternative_titles`);
  alternativesUrl.searchParams.set('api_key', key);
  if (mediaType === 'movie') alternativesUrl.searchParams.set('country', 'EG');
  const translationsUrl = new URL(`${TMDB_BASE}/${mediaType}/${tmdbId}/translations`);
  translationsUrl.searchParams.set('api_key', key);

  const [detailResponse, alternativesResponse, translationsResponse] = await Promise.allSettled([
    fetch(detailUrl, { signal, headers: { Accept: 'application/json' } }),
    fetch(alternativesUrl, { signal, headers: { Accept: 'application/json' } }),
    fetch(translationsUrl, { signal, headers: { Accept: 'application/json' } }),
  ]);

  let detail: { title?: string; name?: string; original_title?: string; original_name?: string; release_date?: string; first_air_date?: string } = {};
  try {
    if (detailResponse.status === 'fulfilled' && detailResponse.value.ok) detail = await detailResponse.value.json();
  } catch {}

  const titles = new Map<string, string>();
  const addTitle = (value: unknown) => {
    const title = normalizeText(value);
    if (title) titles.set(normalizeTitle(title), title);
  };
  addTitle(detail.title || detail.name);
  addTitle(detail.original_title || detail.original_name);

  try {
    if (alternativesResponse.status === 'fulfilled' && alternativesResponse.value.ok) {
      const alternatives = await alternativesResponse.value.json() as { titles?: Array<{ title?: string; name?: string }>; results?: Array<{ title?: string; name?: string }> };
      (alternatives.titles || []).concat(alternatives.results || []).forEach((item) => addTitle(item.title || item.name));
    }
  } catch {}

  try {
    if (translationsResponse.status === 'fulfilled' && translationsResponse.value.ok) {
      const translations = await translationsResponse.value.json() as { translations?: Array<{ data?: { title?: string; name?: string } }> };
      translations.translations?.forEach((item) => addTitle(item.data?.title || item.data?.name));
    }
  } catch {}

  return {
    title: normalizeText(detail.title || detail.name),
    originalTitle: normalizeText(detail.original_title || detail.original_name),
    titles: Array.from(titles.values()),
    year: normalizeText((detail.release_date || detail.first_air_date || '').slice(0, 4)),
  };
}

async function searchArchive(title: string, year: string, tmdbId: number, mediaType: 'movie' | 'tv', signal: AbortSignal) {
  const titlePhrase = title.replace(/"/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 180);
  const words = titlePhrase.split(/\s+/).filter((word) => word.length >= 2).slice(0, 9).join(' AND ');
  const yearClause = year ? ` AND (year:${year} OR year:[${Math.max(1880, Number(year) - 1)} TO ${Number(year) + 1}] OR date:[${year}-01-01 TO ${year}-12-31])` : '';
  const queryVariants = Array.from(new Set([
    `(title:("${titlePhrase}") OR identifier:"${titlePhrase}") AND mediatype:movies${yearClause}`,
    `(title:("${titlePhrase}" OR ${words || titlePhrase}) OR creator:("${titlePhrase}")) AND mediatype:movies${yearClause}`,
    `(title:("${titlePhrase}" OR ${words || titlePhrase}) OR subject:("${titlePhrase}")) AND mediatype:movies`,
  ]));

  const results = await Promise.all(queryVariants.map(async (query) => {
    const url = new URL(ARCHIVE_SEARCH);
    url.searchParams.set('q', query);
    url.searchParams.append('fl[]', 'identifier,title,date,year,description,subject,creator,language,licenseurl,rights,collection,downloads');
    url.searchParams.set('rows', '100');
    url.searchParams.set('page', '1');
    url.searchParams.set('output', 'json');
    url.searchParams.set('sort[]', 'downloads desc');
    try {
      const response = await fetch(url, { signal, headers: { Accept: 'application/json', 'User-Agent': 'Lumi/1.0' } });
      if (!response.ok) return [];
      const payload = await response.json() as { response?: { docs?: Array<Record<string, unknown>> } };
      return payload.response?.docs || [];
    } catch {
      return [];
    }
  }));

  const candidates = new Map<string, Record<string, unknown>>();
  results.flat().forEach((doc) => {
    const identifier = normalizeText(doc.identifier);
    if (identifier && safeIdentifier(identifier)) candidates.set(identifier, doc);
  });
  return Array.from(candidates.entries());
}

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  if (searchParams.get('media') === '1') {
    const identifier = searchParams.get('identifier') || '';
    const file = searchParams.get('file') || '';
    if (!safeIdentifier(identifier) || !safeMediaFile(file)) return new Response('Invalid media identifier', { status: 400 });
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 40_000);
    try {
      const upstream = `https://archive.org/download/${encodeURIComponent(identifier)}/${encodeURIComponent(file)}`;
      const headers: HeadersInit = { Accept: '*/*', 'User-Agent': 'Mozilla/5.0 Lumi/1.0', Referer: 'https://archive.org/' };
      const range = request.headers.get('range');
      if (range && /^bytes=\d*-\d*$/.test(range)) (headers as Record<string, string>).Range = range;
      const response = await fetch(upstream, { headers, signal: controller.signal, redirect: 'follow' });
      if (!response.ok || !response.body) return new Response('Archive media unavailable', { status: 502 });
      const output = new Headers({ 'Cache-Control': 'public, max-age=86400', 'X-Content-Type-Options': 'nosniff', 'Accept-Ranges': response.headers.get('accept-ranges') || 'bytes' });
      for (const name of ['content-type', 'content-length', 'content-range', 'etag', 'last-modified']) {
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
  const season = Math.max(1, Number(searchParams.get('season') || 1));
  const episode = Math.max(1, Number(searchParams.get('episode') || 1));
  const cacheKey = `${mediaType}:${tmdbId}:${mediaType === 'tv' ? `${season}:${episode}` : ''}`;
  const cached = archiveResultCache.get(cacheKey);
  if (cached && cached.expires > Date.now()) {
    return NextResponse.json({ ...cached.result[0], alternatives: cached.result.slice(1) }, { headers: { 'Cache-Control': 'public, max-age=3600, stale-while-revalidate=21600' } });
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), SEARCH_TIMEOUT_MS);
  try {
    const metadata = await fetchTmdbMetadata(tmdbId, mediaType, searchParams.get('language') || 'ar-EG', controller.signal);
    const requestedTitle = normalizeText(searchParams.get('title'));
    const titles = Array.from(new Set([requestedTitle, ...(metadata?.titles || []), metadata?.title, metadata?.originalTitle].filter(Boolean) as string[])).slice(0, 5);
    if (!titles.length) return NextResponse.json({ error: 'No searchable title' }, { status: 404 });
    const year = metadata?.year || normalizeText(searchParams.get('year'));

    const candidateMaps = await Promise.all(titles.map((title) => searchArchive(title, year, tmdbId, mediaType, controller.signal)));
    const candidates = new Map<string, Record<string, unknown>>();
    candidateMaps.flat().forEach(([identifier, doc]) => {
      if (!candidates.has(identifier)) candidates.set(identifier, doc);
    });

    const ranked = Array.from(candidates.entries()).sort((a, b) => {
      const scoreEntry = (entry: [string, Record<string, unknown>]) => {
        const doc = entry[1];
        const candidateTitle = normalizeText(doc.title) || normalizeText(doc.identifier);
        const titleScore = Math.max(...titles.map((title) => titleSimilarity(title, candidateTitle)));
        const candidateYear = normalizeText(doc.year).slice(0, 4) || normalizeText(doc.date).slice(0, 4);
        const numericYear = Number(candidateYear);
        const yearScore = year && numericYear ? Math.max(0, 1 - Math.abs(numericYear - Number(year)) / 5) : 0;
        const licensed = isVerifiedOpenLicense(doc) ? 0.15 : 0;
        return titleScore * 1.5 + yearScore * 0.35 + licensed;
      };
      return scoreEntry(b) - scoreEntry(a);
    });

    const metadataResults: ArchiveStream[] = [];
    const batchSize = 12;
    for (let index = 0; index < Math.min(ranked.length, 72); index += batchSize) {
      const batch = ranked.slice(index, index + batchSize);
      const resolved = await Promise.all(batch.map(async ([identifier, searchDoc]) => {
        try {
          const response = await fetch(`${ARCHIVE_METADATA}/${encodeURIComponent(identifier)}`, { signal: controller.signal, headers: { Accept: 'application/json' } });
          if (!response.ok) return null;
          const rawMetadata = await response.json() as { metadata?: Record<string, unknown>; files?: unknown[] };
          const fullMetadata: Record<string, unknown> = {
            ...(rawMetadata.metadata || {}),
            files: Array.isArray(rawMetadata.files) ? rawMetadata.files : [],
          };
          if (!isVerifiedOpenLicense(fullMetadata)) return null;
          const archiveTitle = normalizeText(fullMetadata.title || searchDoc.title || '');
          const bestSimilarity = Math.max(...titles.map((title) => titleSimilarity(title, archiveTitle)));
          if (bestSimilarity < 0.28) return null;
          if (mediaType === 'tv') {
            const episodeText = normalizeText(fullMetadata.description) + ' ' + archiveTitle;
            if (!archiveTitle && !episodeText) return null;
          }
          return choosePlayableFiles(fullMetadata, identifier);
        } catch {
          return null;
        }
      }));
      resolved.forEach((streams) => {
        if (streams) streams.forEach((stream) => metadataResults.push(stream));
      });
      if (metadataResults.length >= 6) break;
    }

    if (!metadataResults.length) return NextResponse.json({ error: 'No verified Internet Archive video found for this title' }, { status: 404, headers: { 'Cache-Control': 'no-store' } });
    archiveResultCache.set(cacheKey, { expires: Date.now() + 6 * 60 * 60 * 1000, result: metadataResults });
    const first = metadataResults[0];
    return NextResponse.json({ ...first, alternatives: metadataResults.slice(1) }, { headers: { 'Cache-Control': 'public, max-age=3600, stale-while-revalidate=21600' } });
  } catch {
    return NextResponse.json({ error: 'Internet Archive search failed', code: 'archive-search-failed' }, { status: 502 });
  } finally {
    clearTimeout(timeout);
  }
}
