/**
 * YTS torrent catalog client (server-side).
 *
 * Port of download.py's YTSClient logic to the app's runtime — instead of
 * scraping the browse HTML we use the official JSON API exposed by the same
 * host, which returns title/year/rating plus every torrent quality with its
 * info hash, size, seeds and download URL.
 */

const YTS_API_BASE_URL = 'https://yts.gg/api/v2';
const YTS_TORRENT_DOWNLOAD_BASE_URL = 'https://yts.gg/torrent/download';

const USER_AGENT =
  'Mozilla/5.0 (X11; Linux x86_64; rv:153.0) Gecko/20100101 Firefox/153.0';

const TORRENT_HASH_PATTERN = /^[0-9a-f]{40}$/i;

export const MAX_TORRENT_FILE_BYTES = 512 * 1024;

export interface YtsTorrent {
  quality: string;
  release: string;
  size: string;
  sizeBytes: number | null;
  hash: string;
  downloadUrl: string;
  magnet: string;
  seeds: number;
  peers: number;
}

export interface YtsMovieTorrents {
  title: string;
  year: string;
  imdbCode: string;
  coverImage: string;
  torrents: YtsTorrent[];
}

interface RawYtsTorrent {
  quality?: string;
  size?: string;
  size_bytes?: number;
  filesize?: number;
  filesize_bytes?: number;
  hash?: string;
  name?: string;
  type?: string;
  video_codec?: string;
  seeds?: number;
  peers?: number;
  url?: string;
}

interface RawYtsMovie {
  title_long?: string;
  title?: string;
  year?: number;
  imdb_code?: string;
  medium_cover_image?: string;
  torrents?: RawYtsTorrent[];
}

interface YtsApiResponse {
  status?: string;
  data?: {
    movie?: RawYtsMovie;
    movies?: RawYtsMovie[];
  };
}

/**
 * Validates a 40-char hex info hash and returns it trimmed exactly as the
 * catalog sent it — the yts.gg download endpoint is case-sensitive.
 */
export function normalizeTorrentHash(value: unknown): string {
  const hash = typeof value === 'string' ? value.trim() : '';
  return TORRENT_HASH_PATTERN.test(hash) ? hash : '';
}

export function buildYtsTorrentDownloadUrl(hash: string): string {
  return `${YTS_TORRENT_DOWNLOAD_BASE_URL}/${hash}`;
}

export function buildMagnetUri(hash: string, displayName: string): string {
  // encodeURIComponent matches magnet URI conventions (%20 for spaces).
  return `magnet:?xt=urn:btih:${hash}&dn=${encodeURIComponent(displayName)}`;
}

function parseSizeBytes(raw: RawYtsTorrent): number | null {
  const bytes = raw.size_bytes ?? raw.filesize_bytes ?? raw.filesize;
  return typeof bytes === 'number' && Number.isFinite(bytes) && bytes > 0
    ? Math.floor(bytes)
    : null;
}

function normalizeTorrent(raw: RawYtsTorrent, displayName: string): YtsTorrent | null {
  const hash = normalizeTorrentHash(raw.hash);
  if (!hash) return null;  const quality = (raw.quality || '').trim();
  const release = [
    (raw.type || '').trim(),
    (raw.video_codec || '').trim(),
  ]
    .filter(Boolean)
    .join(' · ');
  return {
    quality: quality || 'UNKNOWN',
    release: (raw.name || '').trim() || release.toUpperCase(),
    size: (raw.size || '').trim(),
    sizeBytes: parseSizeBytes(raw),
    hash,
    downloadUrl: buildYtsTorrentDownloadUrl(hash),
    magnet: buildMagnetUri(hash, displayName || quality || 'movie'),
    seeds: typeof raw.seeds === 'number' && raw.seeds > 0 ? raw.seeds : 0,
    peers: typeof raw.peers === 'number' && raw.peers > 0 ? raw.peers : 0,
  };
}

function normalizeMovie(raw: RawYtsMovie): YtsMovieTorrents | null {
  const displayName = (raw.title_long || raw.title || '').trim();
  if (!displayName) return null;
  const torrents: YtsTorrent[] = [];
  const seenHashes = new Set<string>();
  for (const rawTorrent of raw.torrents ?? []) {
    const torrent = normalizeTorrent(rawTorrent, displayName);
    if (!torrent || seenHashes.has(torrent.hash)) continue;
    seenHashes.add(torrent.hash);
    torrents.push(torrent);
  }
  if (torrents.length === 0) return null;
  return {
    title: displayName,
    year: typeof raw.year === 'number' && raw.year > 0 ? String(raw.year) : '',
    imdbCode: (raw.imdb_code || '').trim(),
    coverImage: (raw.medium_cover_image || '').trim(),
    torrents,
  };
}

function sanitizeSearchTitle(value: string): string {
  return value
    .replace(/[\\/:*?"<>|]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 180);
}

/**
 * Picks the closest YTS match for a title/year pair: exact year first,
 * then nearest release year, then the first result.
 */
export function pickBestMovieMatch(
  movies: RawYtsMovie[],
  year?: string,
): RawYtsMovie | null {
  if (movies.length === 0) return null;
  if (!year) return movies[0];

  const wantedYear = Number.parseInt(year, 10);
  if (!Number.isFinite(wantedYear)) return movies[0];

  const exact = movies.find(
    (movie) => typeof movie.year === 'number' && movie.year === wantedYear,
  );
  if (exact) return exact;

  return movies.reduce((closest, current) => {
    if (typeof current.year !== 'number') return closest;
    if (typeof closest.year !== 'number') return current;
    return Math.abs(current.year - wantedYear) <
      Math.abs(closest.year - wantedYear)
      ? current
      : closest;
  }, movies[0]);
}

/**
 * Queries the YTS API. `imdbId` is the strongest key (exact movie); the
 * title/year pair is the fallback used when no IMDb code is available.
 */
export async function fetchYtsTorrents(options: {
  imdbId?: string;
  title?: string;
  year?: string;
  timeoutMs?: number;
}): Promise<YtsMovieTorrents | null> {
  const imdbId = typeof options.imdbId === 'string' ? options.imdbId.trim() : '';
  const title = sanitizeSearchTitle(
    typeof options.title === 'string' ? options.title : '',
  );
  const year = /^\d{4}$/.test((options.year || '').trim())
    ? (options.year || '').trim()
    : '';
  const timeoutMs = options.timeoutMs ?? 15000;

  const requests: Array<{ url: URL; mode: 'imdb' | 'search' }> = [];
  if (/^tt\d{7,10}$/i.test(imdbId)) {
    const url = new URL(`${YTS_API_BASE_URL}/movie_details.json`);
    url.searchParams.set('imdb_id', imdbId);
    requests.push({ url, mode: 'imdb' });
  }
  if (title) {
    const url = new URL(`${YTS_API_BASE_URL}/list_movies.json`);
    url.searchParams.set('query_term', title);
    url.searchParams.set('limit', '20');
    url.searchParams.set('sort_by', 'relevance');
    url.searchParams.set('page', '1');
    requests.push({ url, mode: 'search' });
  }
  if (requests.length === 0) return null;

  for (const request of requests) {
    try {
      const response = await fetch(request.url, {
        signal: AbortSignal.timeout(timeoutMs),
        redirect: 'follow',
        headers: {
          'User-Agent': USER_AGENT,
          Accept: 'application/json',
        },
        cache: 'no-store',
      });
      if (!response.ok) continue;
      const payload = (await response.json()) as YtsApiResponse;
      if (payload.status !== 'ok' || !payload.data) continue;
      if (request.mode === 'imdb' && payload.data.movie) {
        const movie = normalizeMovie(payload.data.movie);
        if (movie) return movie;
        continue;
      }
      const movies = payload.data.movies || [];
      const matched = pickBestMovieMatch(movies, year);
      const movie = matched ? normalizeMovie(matched) : null;
      if (movie) return movie;
    } catch {
      // Try the next strategy; a total failure yields null.
    }
  }
  return null;
}

/** Torrent info hashes that should never be relayed (empty by policy). */
export function isTorrentHashAllowed(hash: string): boolean {
  return TORRENT_HASH_PATTERN.test(hash);
}

export async function fetchTorrentFile(
  hash: string,
  timeoutMs = 30000,
): Promise<{ bytes: Uint8Array; filename: string } | null> {
  if (!isTorrentHashAllowed(hash)) return null;
  try {
    const response = await fetch(buildYtsTorrentDownloadUrl(hash), {
      signal: AbortSignal.timeout(timeoutMs),
      redirect: 'follow',
      headers: {
        'User-Agent': USER_AGENT,
        Accept: 'application/x-bittorrent,*/*',
        Referer: `${YTS_TORRENT_DOWNLOAD_BASE_URL}/`,
      },
      cache: 'no-store',
    });
    if (!response.ok) return null;
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.length === 0 || bytes.length > MAX_TORRENT_FILE_BYTES) return null;
    // Sanity check: a .torrent file always starts with a bencoded dictionary.
    if (bytes[0] !== 0x64) return null;
    const disposition = response.headers.get('Content-Disposition') || '';
    const match = /filename\*?="?([^";]+)"?/i.exec(disposition);
    const filename = match?.[1]
      ? decodeURIComponent(match[1].trim())
      : `${hash.slice(0, 12)}.torrent`;
    return { bytes, filename };
  } catch {
    return null;
  }
}
