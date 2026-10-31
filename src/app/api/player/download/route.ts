import ffmpegPath from 'ffmpeg-static';
import { NextResponse } from 'next/server';
import { spawn } from 'node:child_process';
import { createReadStream, promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';

import { unwrapBingrMediaUrl, validateBingrMediaUrl } from '@/lib/bingr-player';
import {
  normalizePositiveInteger,
  normalizeTmdbId,
  normalizeTmdbPlayerMediaType,
  normalizeTmdbPlayerProvider,
} from '@/lib/tmdb-player-sources';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function safeFilename(value: string | null, tmdbId: number): string {
  const normalized = (value || `movie-${tmdbId}`).normalize('NFKC');
  const cleaned = Array.from(normalized, (character) => {
    const code = character.charCodeAt(0);
    return /[\\/:*?"<>|]/.test(character) || code < 32
      ? ' '
      : character;
  }).join('');
  const base = cleaned.replace(/\s+/g, ' ').trim().slice(0, 120);
  return `${base || `movie-${tmdbId}`}.mp4`;
}

function contentDisposition(filename: string): string {
  const ascii = filename.replace(/[^\x20-\x7e]/g, '_');
  const encoded = encodeURIComponent(filename).replace(/['()*]/g, (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`);
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encoded}`;
}

function buildProviderEmbedUrl(provider: string, mediaType: 'movie' | 'tv', tmdbId: number, season: number, episode: number): URL | null {
  if (provider === 'bingr' || provider === 'archive') return null;
  let raw = '';
  if (provider === 'vidsrc-buzz') {
    raw = mediaType === 'movie'
      ? `https://vidsrc.buzz/embed/movie/${tmdbId}`
      : `https://vidsrc.buzz/embed/tv/${tmdbId}/${season}/${episode}`;
  } else if (provider === 'vidfast') {
    raw = mediaType === 'movie'
      ? `https://vidfast.vc/movie/${tmdbId}`
      : `https://vidfast.vc/tv/${tmdbId}/${season}/${episode}`;
  } else if (provider === 'vidsrc-wtf') {
    raw = mediaType === 'movie'
      ? `https://vidsrc.wtf/1/movie/${tmdbId}`
      : `https://vidsrc.wtf/1/tv/${tmdbId}/${season}/${episode}`;
  } else if (provider === 'cinesrc') {
    raw = mediaType === 'movie'
      ? `https://cinesrc.st/embed/movie/${tmdbId}`
      : `https://cinesrc.st/embed/tv/${tmdbId}?s=${season}&e=${episode}`;
  }
  try { return raw ? new URL(raw) : null; } catch { return null; }
}

function decodeExtractedUrl(value: string, base: URL): URL | null {
  const text = value
    .replace(/\\u0026/gi, '&')
    .replace(/\\u002F/gi, '/')
    .replace(/\\\//g, '/')
    .replace(/\\\//g, '/')
    .replace(/\\x2f/gi, '/')
    .replace(/\\x26/gi, '&')
    .replace(/&amp;/gi, '&')
    .replace(/^['"`] | ['"`]$/g, '')
    .trim();
  try { return new URL(text, base); } catch { return null; }
}

function extractMediaUrls(text: string, base: URL): URL[] {
  const decoded = text
    .replace(/\\u0026/gi, '&')
    .replace(/\\u002F/gi, '/')
    .replace(/\\\//g, '/')
    .replace(/\\x2F/gi, '/')
    .replace(/\\x26/gi, '&');
  const candidates = new Set<string>();
  const patterns = [
    /https?:\\?\/\\?\/[^\s"'<>\\]+?\.(?:m3u8|mp4|webm)(?:[^\s"'<>\\]*)/gi,
    /(?:https?:)?\\?\/\\?\/[^\s"'<>\\]+?\.(?:m3u8|mp4|webm)(?:[^\s"'<>\\]*)/gi,
    /["'`](?:\.\.\/|\.\/)?[^"'`\s]*\.(?:m3u8|mp4|webm)(?:[^"'`\s]*)["'`]/gi,
  ];
  for (const pattern of patterns) {
    for (const match of decoded.match(pattern) || []) {
      const cleaned = match.replace(/^['"`]|['"`]$/g, '').replace(/\\u0026/g, '&');
      const candidate = decodeExtractedUrl(cleaned, base);
      if (candidate && /^https?:$/i.test(candidate.protocol)) candidates.add(candidate.toString());
    }
  }
  return Array.from(candidates).map((value) => new URL(value)).slice(0, 80);
}

async function probeMediaUrl(url: URL): Promise<boolean> {
  try {
    const response = await fetch(url, {
      method: 'GET',
      headers: {
        Accept: '*/*',
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/131.0.0.0 Safari/537.36',
        Referer: url.origin + '/',
      },
      redirect: 'follow',
      signal: AbortSignal.timeout(12_000),
      cache: 'no-store',
    });
    return response.ok && Boolean(response.body);
  } catch {
    return false;
  }
}

async function resolveProviderMediaUrl(embedUrl: URL, _provider: string): Promise<{ streamUrl: URL; referer: string } | null> {
  const response = await fetch(embedUrl, {
    headers: {
      Accept: 'text/html,application/xhtml+xml,application/json,text/plain,*/*;q=0.8',
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/131.0.0.0 Safari/537.36',
      Referer: embedUrl.origin + '/',
      Origin: embedUrl.origin,
    },
    redirect: 'follow',
    signal: AbortSignal.timeout(18_000),
    cache: 'no-store',
  });
  if (!response.ok) return null;
  const finalPageUrl = response.url ? new URL(response.url) : embedUrl;
  const html = await response.text();
  let candidates = extractMediaUrls(html, finalPageUrl);

  const iframeMatches = Array.from(html.matchAll(/<iframe[^>]+(?:src|data-src)=["']([^"']+)["'][^>]*>/gi));
  const iframePages = await Promise.all(iframeMatches.slice(0, 6).map(async (match) => {
    try {
      const iframeUrl = new URL(match[1], finalPageUrl);
      const allowed = iframeUrl.origin === embedUrl.origin || iframeUrl.hostname.includes(embedUrl.hostname.replace(/^www\./, '').replace(/^.*?\./, '')) || /(?:cdn|stream|player|embed)/i.test(iframeUrl.hostname);
      if (!allowed) return '';
      const iframeResponse = await fetch(iframeUrl, {
        headers: { Accept: 'text/html,*/*', 'User-Agent': 'Mozilla/5.0 Chrome/131.0.0.0 Safari/537.36', Referer: finalPageUrl.toString() },
        redirect: 'follow', signal: AbortSignal.timeout(15_000), cache: 'no-store',
      });
      return iframeResponse.ok ? iframeResponse.text() : '';
    } catch { return ''; }
  }));
  for (const iframeHtml of iframePages) candidates = candidates.concat(extractMediaUrls(iframeHtml, finalPageUrl));

  const scriptMatches = Array.from(html.matchAll(/<script[^>]+src=["']([^"']+)["'][^>]*>/gi));
  const scripts = scriptMatches.map((match) => match[1]).slice(0, 12);
  const resolvedScripts = await Promise.all(scripts.map(async (script) => {
    try {
      const scriptUrl = new URL(script, response.url ? response.url : embedUrl);
      if (      scriptUrl.origin !== embedUrl.origin && !/(?:cdn|cloudflare|jsdelivr|googleapis|gstatic|cloudfront)/.test(scriptUrl.hostname)) return '';      const scriptResponse = await fetch(scriptUrl, {
        headers: { Accept: '*/*', 'User-Agent': 'Mozilla/5.0 Chrome/131.0.0.0 Safari/537.36', Referer: embedUrl.origin + '/' },
        redirect: 'follow',
        signal: AbortSignal.timeout(15_000),
        cache: 'no-store',
      });
      return scriptResponse.ok ? scriptResponse.text() : '';
    } catch { return ''; }
  }));
  for (const script of resolvedScripts) {
    candidates = candidates.concat(extractMediaUrls(script, embedUrl));
  }

  const unique = Array.from(new Map(candidates.map((url) => [url.toString(), url])).values());
  unique.sort((a, b) => {
    const rank = (url: URL) => url.pathname.endsWith('.m3u8') ? 3 : /\.(mp4|webm)$/i.test(url.pathname) ? 4 : 1;
    return rank(b) - rank(a);
  });
  for (const candidate of unique.slice(0, 50)) {
    if (await probeMediaUrl(candidate)) {
      return { streamUrl: candidate, referer: response.url || embedUrl.toString() };
    }
  }
  return null;
}

async function resolveStream(request: Request, origin: string) {
  const params = new URL(request.url).searchParams;
  const tmdbId = normalizeTmdbId(params.get('tmdbId'));
  if (!tmdbId) return { error: 'Invalid TMDB ID', status: 400 } as const;
  const mediaType = normalizeTmdbPlayerMediaType(params.get('type'));
  const provider = normalizeTmdbPlayerProvider(params.get('provider'));
  const season = normalizePositiveInteger(params.get('season'), 1);
  const episode = normalizePositiveInteger(params.get('episode'), 1);
  const title = params.get('title') || '';
  const year = params.get('year') || '';
  if (provider === 'cinesrc') {
    try {
      const cachePath = mediaType === 'tv'
        ? join(tmpdir(), `lumi-cinesrc-${tmdbId}-tv-${season}-${episode}.json`)
        : join(tmpdir(), `lumi-cinesrc-${tmdbId}-movie.json`);
      const fallbackCachePath = join(tmpdir(), `lumi-cinesrc-${tmdbId}.json`);
      let cached: { streamUrl?: string; createdAt?: number; type?: string; season?: number; episode?: number };
      try {
        cached = JSON.parse(await fs.readFile(cachePath, 'utf8'));
      } catch {
        cached = JSON.parse(await fs.readFile(fallbackCachePath, 'utf8'));
      }
      if (cached.streamUrl && (!cached.createdAt || Date.now() - cached.createdAt < 24 * 60 * 60 * 1000)) {
        const streamUrl = new URL(cached.streamUrl);
        const isCapturedCinesrc = streamUrl.protocol === 'https:' && (
          streamUrl.hostname === 'cinesrc.st' ||
          streamUrl.hostname.endsWith('.bright67.online') ||
          streamUrl.hostname.includes('cinesrc') ||
          /\.m3u8(?:$|\?)/i.test(streamUrl.pathname + streamUrl.search)
        );
        if (isCapturedCinesrc) {
          return {
            streamUrl,
            referer: 'https://cinesrc.st/',
            origin: 'https://cinesrc.st',
            contentType: 'application/x-mpegurl',
            title: title || `movie-${tmdbId}`,
          } as const;
        }
      }
    } catch {
      // Fall through to the server-side resolver when no browser-captured source exists.
    }
  }
  if (provider !== 'bingr' && provider !== 'archive') {
    const embedUrl = buildProviderEmbedUrl(provider, mediaType, tmdbId, season, episode);
    if (!embedUrl) return { error: 'Provider embed URL is unavailable', status: 502 } as const;
    const resolved = await resolveProviderMediaUrl(embedUrl, provider);
    if (!resolved) return { error: 'No downloadable media network stream found for this provider', status: 404 } as const;
    return {
      streamUrl: resolved.streamUrl,
      referer: resolved.referer,
      origin: resolved.streamUrl.origin,
      contentType: resolved.streamUrl.pathname.endsWith('.m3u8') ? 'application/x-mpegurl' : resolved.streamUrl.pathname.endsWith('.webm') ? 'video/webm' : 'video/mp4',
      title: title || `movie-${tmdbId}`,
    } as const;
  }
  const apiUrl = new URL(`/api/player/${provider}`, origin);
  apiUrl.searchParams.set('tmdbId', String(tmdbId));
  apiUrl.searchParams.set('type', mediaType);
  apiUrl.searchParams.set('season', String(season));
  apiUrl.searchParams.set('episode', String(episode));
  if (title) apiUrl.searchParams.set('title', title);
  if (year) apiUrl.searchParams.set('year', year);
  const response = await fetch(apiUrl, {
    headers: { Accept: 'application/json', Referer: origin },
    signal: AbortSignal.timeout(55_000),
    cache: 'no-store',
  });
  if (!response.ok) {
    const payload = await response.json().catch(() => null) as { error?: string } | null;
    return { error: payload?.error || 'Playable source is unavailable', status: 502 } as const;
  }
  const payload = await response.json() as { streamUrl?: string; title?: string; contentType?: string };
  if (!payload.streamUrl) return { error: 'Playable source is unavailable', status: 502 } as const;
  let streamUrl = new URL(payload.streamUrl, origin);
  if (streamUrl.pathname === '/api/player/media') {
    const upstreamParam = streamUrl.searchParams.get('url');
    if (upstreamParam) {
      try {
        streamUrl = unwrapBingrMediaUrl(upstreamParam);
      } catch {
        try {
          streamUrl = validateBingrMediaUrl(upstreamParam);
        } catch {
          return { error: 'Bingr returned an unsupported media source', status: 502 } as const;
        }
      }
    }
  }
  return {
    streamUrl,
    referer: provider === 'bingr' ? 'https://bingr.one/' : streamUrl.pathname.startsWith('/api/player/') ? origin : streamUrl.origin + '/',
    origin: provider === 'bingr' ? 'https://bingr.one' : streamUrl.origin,
    contentType: payload.contentType || '',
    title: payload.title || title,
  } as const;
}

async function materializeHls(streamUrl: URL, referer: string, origin: string, tempDirectory: string): Promise<{ videoPlaylist: string; audioPlaylist?: string }> {
  const headers = {
    Accept: '*/*',
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/131.0.0.0 Safari/537.36',
    Referer: referer,
    Origin: origin,
  };
  const fetchText = async (url: URL) => {
    const response = await fetch(url, { headers, redirect: 'follow', signal: AbortSignal.timeout(45_000), cache: 'no-store' });
    if (!response.ok) throw new Error(`HLS manifest unavailable (${response.status})`);
    const text = await response.text();
    if (!text.trimStart().startsWith('#EXTM3U')) throw new Error('Invalid HLS manifest');
    return text;
  };
  const downloadFile = async (url: URL, fileName: string) => {
    const response = await fetch(url, { headers, redirect: 'follow', signal: AbortSignal.timeout(45_000), cache: 'no-store' });
    if (!response.ok || !response.body) throw new Error(`HLS segment unavailable (${response.status})`);
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.byteLength < 16) throw new Error('HLS segment is empty or invalid');
    await fs.writeFile(join(tempDirectory, fileName), bytes);
  };

  let manifestUrl = streamUrl;
  let manifest = await fetchText(manifestUrl);
  let audioUrl: URL | null = null;
  if (manifest.includes('#EXT-X-STREAM-INF')) {
    const audioMatch = manifest.match(/#EXT-X-MEDIA:TYPE=AUDIO[^\n]*URI="([^"]+)"/i);
    if (audioMatch) audioUrl = new URL(audioMatch[1], manifestUrl);
    const lines = manifest.split(/\r?\n/);
    let selected: URL | null = null;
    let selectedPixels = -1;
    for (let index = 0; index < lines.length; index++) {
      if (!lines[index].startsWith('#EXT-X-STREAM-INF:')) continue;
      const next = lines[index + 1]?.trim();
      if (!next || next.startsWith('#') || /(tile|thumb|subtitle)/i.test(next)) continue;
      const candidate = new URL(next, manifestUrl);
      const resolution = lines[index].match(/RESOLUTION=(\d+)x(\d+)/i);
      const pixels = resolution ? Number(resolution[1]) * Number(resolution[2]) : 0;
      if (pixels >= selectedPixels) { selected = candidate; selectedPixels = pixels; }
    }
    if (!selected) throw new Error('No playable HLS variant found');
    manifestUrl = selected;
    manifest = await fetchText(manifestUrl);
  }

  const rewriteManifest = async (source: string, baseUrl: URL, prefix: string) => {
    const localLines: string[] = [];
    const downloads: Array<{ url: URL; fileName: string }> = [];
    let index = 0;
    for (const line of source.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed) { localLines.push(line); continue; }
      if (trimmed.startsWith('#EXT-X-MAP:URI=')) {
        const match = trimmed.match(/URI="([^"]+)"/i);
        if (!match) { localLines.push(line); continue; }
        const fileName = `${prefix}-init-${String(index++).padStart(5, '0')}.m4s`;
        downloads.push({ url: new URL(match[1], baseUrl), fileName });
        localLines.push(trimmed.replace(match[1], fileName));
      } else if (trimmed.startsWith('#')) {
        localLines.push(line);
      } else if (!/\.(jpg|jpeg|png)(\?|$)/i.test(trimmed)) {
        const fileName = `${prefix}-${String(index++).padStart(6, '0')}.m4s`;
        downloads.push({ url: new URL(trimmed, baseUrl), fileName });
        localLines.push(fileName);
      }
    }
    if (downloads.length === 0) throw new Error('No HLS media segments found');
    for (let start = 0; start < downloads.length; start += 12) {
      await Promise.all(downloads.slice(start, start + 12).map((item) => downloadFile(item.url, item.fileName)));
    }
    return localLines.join('\n');
  };

  const videoPlaylist = join(tempDirectory, 'video.m3u8');
  await fs.writeFile(videoPlaylist, await rewriteManifest(manifest, manifestUrl, 'video'), 'utf8');
  let audioPlaylist: string | undefined;
  if (audioUrl) {
    try {
      const audioManifest = await fetchText(audioUrl);
      audioPlaylist = join(tempDirectory, 'audio.m3u8');
      await fs.writeFile(audioPlaylist, await rewriteManifest(audioManifest, audioUrl, 'audio'), 'utf8');
    } catch { audioPlaylist = undefined; }
  }
  return { videoPlaylist, audioPlaylist };
}

export async function GET(request: Request) {
  const url = new URL(request.url);
  const origin = `${url.protocol}//${url.host}`;
  const resolved = await resolveStream(request, origin);
  if ('error' in resolved) {
    return NextResponse.json({ error: resolved.error }, { status: resolved.status });
  }
  const filename = safeFilename(resolved.title || url.searchParams.get('title'), normalizeTmdbId(url.searchParams.get('tmdbId')) || 0);

  let sourceResponse: Response;
  try {
    sourceResponse = await fetch(resolved.streamUrl, {
      headers: {
        Accept: '*/*',
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/131.0.0.0 Safari/537.36',
        Referer: resolved.referer || origin,
        Origin: resolved.origin || resolved.streamUrl.origin,
        ...(request.headers.get('range') ? { Range: request.headers.get('range') as string } : {}),
      },
      redirect: 'follow',
      signal: AbortSignal.timeout(60_000),
      cache: 'no-store',
    });
  } catch {
    return NextResponse.json({ error: 'Download source timed out' }, { status: 502 });
  }
  if (!sourceResponse.ok || !sourceResponse.body) {
    return NextResponse.json({ error: 'Download source is unavailable' }, { status: 502 });
  }

  const contentType = sourceResponse.headers.get('content-type') || resolved.contentType || '';
  const isM3u8 = resolved.streamUrl.pathname.endsWith('.m3u8') || /mpegurl/i.test(contentType);
  const directPath = /\.(mp4|webm)(?:$|\?|\/)/i.test(resolved.streamUrl.pathname + resolved.streamUrl.search);
  const isDirectVideo = (/^(video\/|application\/octet-stream)/i.test(contentType) || directPath) && !isM3u8 && !/^(text\/|application\/(?:json|x-mpegURL))/i.test(contentType);

  if (isDirectVideo) {
    const headers = new Headers({
      'Content-Type': /video\/webm/i.test(contentType) ? 'video/webm' : 'video/mp4',
      'Content-Disposition': contentDisposition(filename),
      'Cache-Control': 'private, max-age=0, no-store',
      'X-Content-Type-Options': 'nosniff',
    });
    for (const name of ['content-length', 'content-range', 'etag', 'last-modified']) {
      const value = sourceResponse.headers.get(name);
      if (value) headers.set(name, value);
    }
    return new Response(sourceResponse.body, { status: sourceResponse.status, headers });
  }

  if (!isM3u8) {
    return NextResponse.json({ error: 'This source does not expose a downloadable video stream' }, { status: 415 });
  }
  if (!ffmpegPath) {
    return NextResponse.json({ error: 'Video merging is unavailable on this server' }, { status: 503 });
  }

  const executable = ffmpegPath;
  const tempDirectory = await fs.mkdtemp(join(tmpdir(), 'lumi-download-'));
  const outputPath = join(tempDirectory, 'video.mp4');
  let ffmpegError = '';
  let ffmpegInputs: string[];
  let audioPlaylist: string | undefined;
  try {
    const materialized = await materializeHls(resolved.streamUrl, resolved.referer || origin, resolved.origin || resolved.streamUrl.origin, tempDirectory);
    ffmpegInputs = [materialized.videoPlaylist];
    audioPlaylist = materialized.audioPlaylist;
  } catch (error) {
    await fs.rm(tempDirectory, { recursive: true, force: true }).catch(() => undefined);
    return NextResponse.json({ error: error instanceof Error ? error.message : 'HLS source could not be prepared' }, { status: 502 });
  }
  const mergeResult = await new Promise<{ code: number | null }>((resolve) => {
    const ffmpeg = spawn(executable, [
      '-nostdin', '-hide_banner', '-loglevel', 'error', '-y',
      '-protocol_whitelist', 'file,http,https,tcp,tls,crypto,data',
      '-rw_timeout', '30000000', '-timeout', '30000000',
      '-reconnect', '1', '-reconnect_streamed', '1', '-reconnect_delay_max', '15', '-reconnect_at_eof', '1',
      '-user_agent', 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/131.0.0.0 Safari/537.36',
      '-referer', resolved.referer || origin,
      '-headers', 'Accept: */*\r\nOrigin: ' + (resolved.origin || resolved.streamUrl.origin) + '\r\n',
      '-i', ffmpegInputs[0],
      ...(audioPlaylist ? ['-i', audioPlaylist] : []),
      '-map', '0:v:0', ...(audioPlaylist ? ['-map', '1:a:0'] : ['-map', '0:a?']),
      '-c:v', 'copy', '-c:a', 'aac', '-b:a', '192k',
      '-movflags', '+faststart+frag_keyframe+empty_moov',
      '-f', 'mp4', outputPath,
    ], { stdio: ['ignore', 'ignore', 'pipe'] });
    const timeout = setTimeout(() => ffmpeg.kill('SIGKILL'), 25 * 60 * 1000);
    ffmpeg.stderr?.on('data', (chunk) => { ffmpegError += String(chunk).slice(-8000); });
    ffmpeg.on('error', () => resolve({ code: -1 }));
    ffmpeg.on('close', (code) => { clearTimeout(timeout); resolve({ code }); });
  });

  let outputSize = 0;
  try { outputSize = (await fs.stat(outputPath)).size; } catch { outputSize = 0; }
  if (mergeResult.code !== 0 || outputSize < 1024) {
    await fs.rm(tempDirectory, { recursive: true, force: true }).catch(() => undefined);
    const detail = ffmpegError.trim().slice(-500);
    return NextResponse.json({
      error: 'This provider stream could not be merged into MP4',
      ...(detail ? { code: detail } : {}),
    }, { status: 502 });
  }

  const output = createReadStream(outputPath);
  output.on('close', () => void fs.rm(tempDirectory, { recursive: true, force: true }).catch(() => undefined));
  return new Response(Readable.toWeb(output) as ReadableStream<Uint8Array>, {
    status: 200,
    headers: {
      'Content-Type': 'video/mp4',
      'Content-Length': String(outputSize),
      'Content-Disposition': contentDisposition(filename),
      'Cache-Control': 'private, max-age=0, no-store',
      'X-Content-Type-Options': 'nosniff',
      'Accept-Ranges': 'bytes',
    },
  });
}
