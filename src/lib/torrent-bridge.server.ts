/**
 * Server-side torrent bridge for full UDP-swarm support.
 *
 * Browsers physically cannot open UDP sockets or join the BitTorrent DHT, so
 * a YTS movie's UDP-only swarm is unreachable from the browser alone. When
 * the browser finds no WebRTC peers this module runs a REAL BitTorrent peer
 * on the Node server side (UDP trackers + DHT + TCP peer wire), and streams
 * the finished pieces through to the browser over HTTP as they arrive.
 *
 * Nothing is persisted: the torrent store lives in the OS temp directory
 * only for active piece buffers and is destroyed on release/timeout — the
 * movie never remains on the server.
 */

import { decodeTorrent, findPrimaryVideoFile } from '@/lib/bencode';

/** Extra well-known swarm trackers so the server peer reaches max peers. */
const EXTRA_SWARM_TRACKERS = [
  // The UDP trackers shipped in YTS metainfo are honored automatically;
  // these broaden discovery (opentrackr is the biggest public swarm hub).
  'udp://tracker.opentrackr.org:1337/announce',
  'udp://tracker.evergarden.uk:1914/announce',
  'udp://tracker.004430.xyz:1337/announce',
  'udp://51.222.82.36:6969/announce',
  'udp://94.23.207.177:6969/announce',
  'udp://tracker.ilibr.org:6969/announce',
  'udp://185.216.179.62:25/announce',
  'udp://91.216.110.53:451/announce',
  'udp://exodus.desync.com:6969/announce',
  'udp://open.demonii.com:1337/announce',
  // wss trackers also let the user's own browser peer directly with the
  // bridge (both announce to the same public webtorrent trackers).
  'wss://tracker.openwebtorrent.com:443',
  'wss://tracker.webtorrent.dev:443',
  'wss://tracker.files.fm:7073/announce',
  'wss://open.ftorrent.com:443',
];

const VIDEO_FILE_EXTENSION_PATTERN =
  /\.(mp4|mkv|avi|webm|mov|m4v|mpg|mpeg|ogv|3gp|m2ts)$/i;

/** The bridge gives up waiting for swarm metadata after this long. */
const METADATA_TIMEOUT_MS = 120_000;

/** An untouched torrent is dropped from the server after this idle time. */
const IDLE_RELEASE_MS = 5 * 60_000;

interface NodeTorrentFileLike {
  path: string;
  length: number;
  offset: number;
  createReadStream(opts?: {
    start?: number;
    end?: number;
    highWaterMark?: number;
  }): unknown;
}

interface StreamxLike {
  on(event: string, handler: (chunk?: unknown) => void): void;
  destroy(): void;
}

interface NodeTorrentPieceSelector {
  deselect(startPiece: number, endPiece: number, notify: boolean): void;
  select(startPiece: number, endPiece: number, notify: boolean): void;
}

interface NodeTorrentLike {
  infoHash: string;
  name: string;
  length: number;
  pieceLength: number;
  progress: number;
  downloaded: number;
  uploadSpeed: number;
  downloadSpeed: number;
  numPeers: number;
  ready: boolean;
  done: boolean;
  files: NodeTorrentFileLike[];
  on(event: string, handler: (...args: unknown[]) => void): void;
  destroy(opts: { destroyStore: boolean }, callback?: () => void): void;
}

interface NodeClientLike {
  add(
    torrentId: Uint8Array,
    opts: { announce: string[] },
    onTorrent?: (torrent: NodeTorrentLike) => void,
  ): NodeTorrentLike;
  torrents: NodeTorrentLike[];
}

interface ActiveBridgeTorrent {
  hash: string;
  torrent: NodeTorrentLike;
  fileName: string;
  fileSize: number;
  lastUsed: number;
  cleanTimers: Array<() => void>;
}

interface BridgeModuleState {
  engine: NodeClientLike | null;
  enginePromise: Promise<NodeClientLike | null> | null;
  active: ActiveBridgeTorrent | null;
  idleTimer: ReturnType<typeof setInterval> | null;
}

export interface BridgeStatusPayload {
  ready: boolean;
  progress: number;
  downloadedBytes: number;
  totalBytes: number;
  numPeers: number;
  speedBytesPerSecond: number;
  fileName: string;
  fileBytes: number;
}

export class BridgeUnavailableError extends Error {
  constructor() {
    super('The torrent bridge engine could not be loaded on this server.');
    this.name = 'BridgeUnavailableError';
  }
}

const globalState = globalThis as unknown as {
  __lumaTorrentBridge?: BridgeModuleState;
};

function state(): BridgeModuleState {
  if (!globalState.__lumaTorrentBridge) {
    globalState.__lumaTorrentBridge = {
      engine: null,
      enginePromise: null,
      active: null,
      idleTimer: null,
    };
  }
  return globalState.__lumaTorrentBridge;
}

function pickPrimaryVideo(
  files: NodeTorrentFileLike[],
): NodeTorrentFileLike | null {
  if (files.length === 0) return null;
  const videos = files.filter((file) =>
    VIDEO_FILE_EXTENSION_PATTERN.test(file.path || file.path),
  );
  const candidates = videos.length > 0 ? videos : files;
  return candidates.reduce((largest, current) =>
    current.length > largest.length ? current : largest,
  );
}

async function loadNodeEngine(): Promise<NodeClientLike | null> {
  const current = state();
  if (current.engine) return current.engine;
  if (!current.enginePromise) {
    current.enginePromise = (async () => {
      try {
        const engineModule = (await import('webtorrent')) as {
          default?: unknown;
        };
        const WebTorrentNode = (engineModule.default ?? engineModule) as {
          new (opts?: Record<string, unknown>): NodeClientLike;
        };
        const client = new WebTorrentNode({
          // Full hybrid client: DHT + UDP/HTTP trackers + web seeds. WebRTC
          // is optional server-side; the metainfo UDP trackers plus these
          // additions reach every seeder a desktop client would.
          dht: true,
          maxPeers: 200,
        });
        current.engine = client;
        return client;
      } catch {
        current.enginePromise = null;
        // Engine load failures (missing native deps) surface through the
        // BridgeUnavailableError path so the UI can fall back gracefully.
        return null;
      }
    })();
  }
  return current.enginePromise;
}

function disposeActiveTorrent(active: ActiveBridgeTorrent): void {
  for (const dispose of active.cleanTimers) dispose();
  active.cleanTimers = [];
  try {
    active.torrent.destroy({ destroyStore: true });
  } catch {
    // Already destroyed — the store cleanup is best-effort here.
  }
}

function scheduleIdleCleanup(): void {
  const current = state();
  if (current.idleTimer) return;
  current.idleTimer = setInterval(() => {
    const bridgeState = state();
    if (!bridgeState.active) return;
    if (Date.now() - bridgeState.active.lastUsed > IDLE_RELEASE_MS) {
      releaseBridgeTorrent(bridgeState.active.hash);
    }
  }, 60_000);
  if (typeof current.idleTimer === 'object' && 'unref' in current.idleTimer) {
    (current.idleTimer as unknown as { unref: () => void }).unref();
  }
}

/**
 * Makes sure the requested torrent is running on the server peer. Switching
 * hashes drops the previous torrent (and its temp store) first.
 */
export async function ensureBridgeTorrent(
  torrentBytes: Uint8Array,
  hash: string,
): Promise<void> {
  const engine = await loadNodeEngine();
  if (!engine) throw new BridgeUnavailableError();
  const current = state();

  if (current.active?.hash === hash) {
    current.active.lastUsed = Date.now();
    scheduleIdleCleanup();
    return;
  }
  if (current.active) {
    const previous = current.active;
    current.active = null;
    try {
      previous.torrent.destroy({ destroyStore: true });
    } catch {
      // Already destroyed.
    }
  }

  const parsed = decodeTorrent(torrentBytes);
  const primary = findPrimaryVideoFile(parsed.files);
  const fileName = primary
    ? primary.path.split('/').pop() || primary.path
    : parsed.name;
  const fileSize = primary
    ? primary.length
    : parsed.length;

  // Copy into a plain ArrayBuffer-backed view (TS rejects ArrayBufferLike
  // coercion) and hand webtorrent a Buffer, which it requires.
  const plainBytes = new Uint8Array(new ArrayBuffer(torrentBytes.byteLength));
  plainBytes.set(torrentBytes);
  const torrent = engine.add(Buffer.from(plainBytes), {
    announce: EXTRA_SWARM_TRACKERS,
  });

  const active: ActiveBridgeTorrent = {
    hash,
    torrent,
    fileName: fileName || 'movie',
    fileSize: fileSize || 0,
    lastUsed: Date.now(),
    cleanTimers: [],
  };
  current.active = active;
  scheduleIdleCleanup();

  // Only fetch the movie file itself, skipping the bundled .nfo/.jpg/.srt
  // filler — keeps the temp store as small as the actual video.
  torrent.on('ready', () => {
    try {
      const video = pickPrimaryVideo(torrent.files);
      if (!video || torrent.pieceLength <= 0) return;
      const selector = torrent as unknown as NodeTorrentPieceSelector;
      selector.deselect(0, 1_000_000_000, false);
      const startPiece = Math.floor(video.offset / torrent.pieceLength);
      const endPiece = Math.floor(
        (video.offset + video.length - 1) / torrent.pieceLength,
      );
      selector.select(startPiece, endPiece, true);
      active.fileSize = video.length;
      active.fileName = video.path.split("/").pop() || video.path;
    } catch {
      // Selection limits are an optimization; the torrent still downloads.
    }
  });
  torrent.on('error', () => {
    // Per-torrent errors (single tracker/peer) are recoverable: the engine
    // keeps announcing to the remaining swarm.
  });
}

function snapshotStatus(): BridgeStatusPayload | null {
  const active = state().active;
  if (!active) return null;
  const torrent = active.torrent;
  return {
    ready: Boolean(torrent.ready),
    progress: Math.min(1, Math.max(0, torrent.progress)),
    downloadedBytes: Math.round(torrent.downloaded),
    totalBytes: torrent.length || torrent.files.reduce((sum, f) => sum + f.length, 0),
    numPeers: torrent.numPeers,
    speedBytesPerSecond: Math.round(torrent.downloadSpeed),
    fileName: active.fileName,
    fileBytes: active.fileSize,
  };
}

export function getBridgeStatus(): BridgeStatusPayload | null {
  const active = state().active;
  if (!active) return null;
  active.lastUsed = Date.now();
  return snapshotStatus();
}

export function hasBridgeTorrent(hash: string): boolean {
  const active = state().active;
  if (!active || active.hash !== hash) return false;
  if (Date.now() - active.lastUsed > IDLE_RELEASE_MS) return false;
  return Boolean(active.torrent.ready);
}

/** Resolves when the metadata is exchanged; throws after the timeout. */
export async function waitForBridgeMetadata(
  hash: string,
  torrentBytes: Uint8Array,
  timeoutMs = METADATA_TIMEOUT_MS,
): Promise<void> {
  const active = state().active;
  if (!active || active.hash !== hash) {
    await ensureBridgeTorrent(torrentBytes, hash);
  }
  const torrent = state().active?.torrent;
  if (!torrent) throw new BridgeUnavailableError();
  if (torrent.ready) return;
  await new Promise<void>((resolve, reject) => {
    const onReady = () => {
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(() => {
      clearTimeout(timer);
      reject(new Error('Timeout waiting for torrent metadata on the swarm'));
    }, timeoutMs);
    torrent.on('ready', onReady);
  });
}

export interface BridgeStreamHandle {
  stream: ReadableStream<Uint8Array>;
  fileName: string;
  length: number;
}

/**
 * Streams the primary video file over HTTP the moment the bridge peer
 * verifies pieces — the response finishes exactly when the download does.
 */
export function openBridgeVideoStream(): BridgeStreamHandle {
  const active = state().active;
  if (!active) throw new Error('No torrent is running on the bridge.');
  const torrent = active.torrent;
  if (!torrent.ready) throw new Error('Torrent metadata not ready.');
  const video = pickPrimaryVideo(torrent.files);
  if (!video) throw new Error('No video file in this torrent.');
  active.lastUsed = Date.now();
  // streamx (v2+) requires an explicit highWaterMark; align it with the
  // torrent piece size so piece verification buffers stay small.
  const nodeStream = video.createReadStream({
    highWaterMark: Math.max(torrent.pieceLength || 256_000, 65_536),
  }) as StreamxLike;
  // webtorrent file streams are streamx streams, not node streams, so
  // node's Readable.toWeb cannot wrap them — pump manually into the Web
  // ReadableStream the HTTP Response body expects.
  const webStream = new ReadableStream<Uint8Array>({
    start(controller) {
      nodeStream.on('data', (chunk) => {
        const buffered = chunk as Uint8Array;
        const chunkCopy = new Uint8Array(new ArrayBuffer(buffered.byteLength));
        chunkCopy.set(buffered);
        controller.enqueue(chunkCopy);
      });
      nodeStream.on('end', () => {
        try {
          controller.close();
        } catch {
          // Already cancelled by the HTTP client.
        }
      });
      nodeStream.on('error', (streamError: unknown) => {
        try {
          controller.error(streamError);
        } catch {
          // Controller already errored/closed.
        }
      });
    },
    cancel() {
      nodeStream.destroy();
    },
  });
  return {
    stream: webStream,
    fileName: video.path.split("/").pop() || video.path,
    length: video.length,
  };
}

/** Drops the active torrent and wipes its temp piece store. */
export function releaseBridgeTorrent(hash: string): void {
  const current = state();
  if (!current.active || current.active.hash !== hash) return;
  const active = current.active;
  current.active = null;
  disposeActiveTorrent(active);
}
