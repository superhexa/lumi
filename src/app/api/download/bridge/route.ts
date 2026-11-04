import { NextResponse } from 'next/server';

import { decodeTorrent } from '@/lib/bencode';
import {
  BridgeUnavailableError,
  ensureBridgeTorrent,
  getBridgeStatus,
  openBridgeVideoStream,
  releaseBridgeTorrent,
  waitForBridgeMetadata,
} from '@/lib/torrent-bridge.server';
import { fetchTorrentFile } from '@/lib/yts-torrents';

/**
 * GET /api/download/bridge
 *
 * Server-side relay peer that unlocks the FULL torrent swarm (UDP trackers
 * + DHT + TCP), which browsers cannot reach. The server peer downloads from
 * the swarm and streams pieces through as they arrive — nothing is stored.
 *
 * Modes:
 *  - ?hash=<40hex>&act=status    -> JSON snapshot of the relay torrent state
 *  - ?hash=<40hex>&act=stream    -> streams the primary video file
 *  - ?hash=<40hex>&act=release   -> drops the torrent + wipes its temp store
 */

const TORRENT_HASH_PATTERN = /^[0-9a-f]{40}$/i;
const MAX_TEXT_LENGTH = 200;
const VIDEO_CONTENT_TYPES: Record<string, string> = {
  mp4: 'video/mp4',
  m4v: 'video/mp4',
  webm: 'video/webm',
  mkv: 'video/x-matroska',
  avi: 'video/x-msvideo',
  mov: 'video/quicktime',
  mpg: 'video/mpeg',
  mpeg: 'video/mpeg',
};

function noStoreJson(payload: unknown, status: number): NextResponse {
  const response = NextResponse.json(payload, { status });
  response.headers.set('Cache-Control', 'no-store, max-age=0');
  return response;
}

export async function GET(request: Request) {
  const searchParams = new URL(request.url).searchParams;
  const hash = (searchParams.get('hash') || '').trim();
  const act = (searchParams.get('act') || 'stream').trim();

  if (!TORRENT_HASH_PATTERN.test(hash)) {
    return noStoreJson({ error: 'Provide a valid 40-char info hash.' }, 400);
  }

  if (act === 'release') {
    releaseBridgeTorrent(hash);
    return noStoreJson({ ok: true }, 200);
  }

  // The bridge torrent needs its metainfo; fetch the tiny .torrent from the
  // YTS relay (a few KB), then let the server peer join the real swarm.
  const result = await fetchTorrentFile(hash);
  if (!result) {
    return noStoreJson(
      { error: 'Torrent file could not be retrieved.' },
      502,
    );
  }

  // Both status and stream start the bridge torrent if it is not running
  // yet, so a status poll also works as a pre-warm.
  try {
    await ensureBridgeTorrent(result.bytes, hash);
  } catch (error) {
    if (error instanceof BridgeUnavailableError) {
      return noStoreJson({ ok: false, reason: 'engine-unavailable' }, 503);
    }
    return noStoreJson({ error: 'Torrent could not start on the bridge.' }, 500);
  }

  if (act === 'status') {
    return noStoreJson({ ok: true, status: getBridgeStatus() }, 200);
  }

  try {
    await waitForBridgeMetadata(hash, result.bytes);
  } catch {
    return noStoreJson(
      { error: 'The relay peer is still joining the swarm. Retry soon.' },
      504,
    );
  }

  let streamHandle;
  try {
    streamHandle = openBridgeVideoStream();
  } catch (error) {
    return noStoreJson(
      {
        error:
          error instanceof Error
            ? error.message
            : 'The video could not open on the bridge.',
      },
      500,
    );
  }

  const extensionMatch = /\.(\w{2,5})$/i.exec(streamHandle.fileName);
  const extension = (extensionMatch?.[1] || 'mp4').toLowerCase();

  // Prefer the cleaned-up torrent display name for the download; fall back
  // to the raw video file name.
  let displayName = streamHandle.fileName;
  try {
    const parsed = decodeTorrent(result.bytes);
    if (parsed.name) displayName = parsed.name;
  } catch {
    // keep the raw file name
  }

  const headers: HeadersInit = {
    'Cache-Control': 'no-store, max-age=0',
    'Content-Type': VIDEO_CONTENT_TYPES[extension] || 'application/octet-stream',
    'Content-Length': String(streamHandle.length),
    'Content-Disposition': `attachment; filename="${encodeURIComponent(
      displayName.replace(/[\\/:*?"<>|]+/g, '_').slice(0, MAX_TEXT_LENGTH),
    )}"`,
  };
  return new Response(streamHandle.stream as unknown as BodyInit, {
    status: 200,
    headers,
  });
}
