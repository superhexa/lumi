import { NextResponse } from 'next/server';

import {
  fetchTorrentFile,
  fetchYtsTorrents,
} from '@/lib/yts-torrents';

/**
 * GET /api/download/yts
 *
 * Two modes:
 *  - ?title=<movie>&year=<yyyy> [&imdbId=<ttN>]  -> JSON with the torrent listing
 *  - ?torrent=<40-char-info-hash>                -> relays the small .torrent file
 *
 * The torrent listing is metadata only; the actual video is transferred
 * peer-to-peer in the browser via WebTorrent, so the server never stores
 * media files. The .torrent relay is a few kilobytes per request.
 */

const MAX_TEXT_LENGTH = 200;

function buildNoStoreHeaders(): HeadersInit {
  return {
    'Cache-Control': 'no-store, max-age=0',
  };
}

function buildTorrentResponseHeaders(filename: string): HeadersInit {
  return {
    'Cache-Control': 'no-store, max-age=0',
    'Content-Type': 'application/x-bittorrent',
    'Content-Disposition': `attachment; filename="${filename.replace(/[^\w\d() .[\]-]+/g, '_')}"`,
  };
}

export async function GET(request: Request) {
  const searchParams = new URL(request.url).searchParams;

  const torrent = (searchParams.get('torrent') || '').trim();
  if (torrent) {
    const result = await fetchTorrentFile(torrent);
    if (!result) {
      return NextResponse.json(
        { error: 'Torrent file could not be retrieved.' },
        { status: 502, headers: buildNoStoreHeaders() },
      );
    }
    return new Response(result.bytes as unknown as BodyInit, {
      status: 200,
      headers: buildTorrentResponseHeaders(result.filename),
    });
  }

  const title = (searchParams.get('title') || '').trim().slice(0, MAX_TEXT_LENGTH);
  const year = (searchParams.get('year') || '').trim().slice(0, 4);
  const imdbId = (searchParams.get('imdbId') || '').trim().slice(0, 12);

  if (!title && !/^tt\d{7,10}$/i.test(imdbId)) {
    return NextResponse.json(
      { error: 'Provide a movie title or a valid imdbId.' },
      { status: 400, headers: buildNoStoreHeaders() },
    );
  }

  try {
    const movie = await fetchYtsTorrents({ title, year, imdbId });
    if (!movie) {
      return NextResponse.json(
        { error: 'No torrent catalog entry found for this movie.' },
        { status: 404, headers: buildNoStoreHeaders() },
      );
    }
    return NextResponse.json(movie, { headers: buildNoStoreHeaders() });
  } catch {
    return NextResponse.json(
      { error: 'The torrent catalog is unreachable right now. Retry soon.' },
      { status: 502, headers: buildNoStoreHeaders() },
    );
  }
}
