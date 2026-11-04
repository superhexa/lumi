/**
 * In-browser BitTorrent download engine.
 *
 * The movie itself never touches the server: the browser loads WebTorrent
 * from a CDN, joins the swarm from the .torrent file (fetched here purely as
 * a few-kilobyte metadata file), downloads the video into the browser and
 * saves it straight to the user's disk. Video data lives only in the user's
 * browser memory/disk, not on the app server.
 *
 * The browser swarm is searched indefinitely — the engine never gives up on
 * peers. Because YTS trackers are UDP-only (browsers cannot speak UDP), every
 * handle also exposes the original .torrent bytes plus a magnet link so the
 * user can fall back to a desktop torrent client, which always finds seeders.
 */

import { decodeTorrent, findPrimaryVideoFile } from '@/lib/bencode';

const WEBTORRENT_CDNS = [
  'https://cdn.jsdelivr.net/npm/webtorrent@3.0.21/dist/webtorrent.min.js',
  'https://unpkg.com/webtorrent@3.0.21/dist/webtorrent.min.js',
];

/**
 * YTS .torrent files ship UDP trackers only, which browsers cannot speak.
 * Browsers join the swarm through WebRTC-friendly (wss://) trackers instead;
 * appending these matches how every other WebTorrent-enabled client works.
 *
 * This list mirrors https://github.com/ngosang/trackerslist
 * (trackers_all_ws.txt, verified daily by their announce bot; last synced
 * November 2026). WebTorrent re-announces on every tracker at the interval
 * the tracker assigns, so peers joining a famous title later are picked up.
 */
const BROWSER_ANNOUNCE_TRACKERS = [
  'wss://tracker.openwebtorrent.com:443',
  'wss://tracker.webtorrent.dev:443',
  'wss://tracker.files.fm:7073/announce',
  'wss://open.ftorrent.com:443',
];

/**
 * STUN (Google/Twilio) plus the free OpenRelay TURN relay. TURN matters a
 * lot in practice: when both peers sit behind symmetric/cone NATs, a relay
 * is the only path to actually completing the WebRTC handshake, so famous
 * titles still connect even on locked-down networks.
 */
const BROWSER_RTC_CONFIG = {
  iceServers: [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' },
    { urls: 'stun:global.stun.twilio.com:3478' },
    {
      urls: 'turn:openrelay.metered.ca:80',
      username: 'openrelayproject',
      credential: 'openrelayproject',
    },
    {
      urls: 'turn:openrelay.metered.ca:443',
      username: 'openrelayproject',
      credential: 'openrelayproject',
    },
    {
      urls: 'turn:openrelay.metered.ca:443?transport=tcp',
      username: 'openrelayproject',
      credential: 'openrelayproject',
    },
  ],
};

export const VIDEO_FILE_EXTENSION_PATTERN =
  /\.(mp4|mkv|avi|webm|mov|m4v|mpg|mpeg|ogv|3gp|m2ts)$/i;

interface WebTorrentFile {
  name: string;
  path: string;
  length: number;
  progress: number;
  stream(opts?: { start?: number; end?: number }): ReadableStream<Uint8Array>;
  blob(opts?: { start?: number; end?: number }): Promise<Blob>;
}

interface WebTorrentInstance {
  name: string;
  infoHash: string;
  progress: number;
  downloaded: number;
  uploaded: number;
  downloadSpeed: number;
  length: number;
  numPeers: number;
  done: boolean;
  files: WebTorrentFile[];
  on(event: string, handler: (...args: unknown[]) => void): void;
  removeListener?(event: string, handler: (...args: unknown[]) => void): void;
}

interface WebTorrentConstructor {
  new (opts?: Record<string, unknown>): WebTorrentClientStatic;
  WEBRTC_SUPPORT?: boolean;
}

interface WebTorrentClientStatic {
  add(
    torrentId: Uint8Array,
    opts: { announce: string[] },
    onTorrent?: (torrent: WebTorrentInstance) => void,
  ): WebTorrentInstance;
  destroy(callback?: () => void): void;
  WEBRTC_SUPPORT?: boolean;
}

declare global {
  interface Window {
    WebTorrent?: WebTorrentConstructor;
  }
}

let webTorrentPromise: Promise<WebTorrentConstructor | null> | null = null;

/**
 * webtorrent's dist bundle is an ES module, so it is imported dynamically and
 * its default export is stashed on `window` for reuse.
 * webpackIgnore keeps the bundler from trying to resolve the CDN URL.
 */
async function importWebTorrentFromCdn(cdn: string): Promise<boolean> {
  const esmModule = await import(/* webpackIgnore: true */ cdn);
  const constructor = (esmModule as { default?: unknown }).default;
  if (typeof constructor === 'function') {
    window.WebTorrent = constructor as WebTorrentConstructor;
    return true;
  }
  return Boolean(window.WebTorrent);
}

export async function loadWebTorrent(): Promise<WebTorrentConstructor> {
  if (typeof window !== 'undefined' && window.WebTorrent) {
    return window.WebTorrent;
  }
  if (!webTorrentPromise) {
    webTorrentPromise = (async () => {
      for (const cdn of WEBTORRENT_CDNS) {
        try {
          if (await importWebTorrentFromCdn(cdn) && window.WebTorrent) {
            return window.WebTorrent;
          }
        } catch {
          // Try the next CDN mirror.
        }
      }
      return null;
    })();
  }
  const loaded = await webTorrentPromise;
  if (!loaded) {
    webTorrentPromise = null;
    throw new Error('The torrent engine could not be loaded.');
  }
  return loaded;
}

export async function isBrowserTorrentSupported(): Promise<boolean> {
  try {
    const WebTorrent = await loadWebTorrent();
    return WebTorrent.WEBRTC_SUPPORT !== false;
  } catch {
    return false;
  }
}

export type TorrentDownloadPhase = 'connecting' | 'downloading' | 'done';

export interface TorrentDownloadProgress {
  phase: TorrentDownloadPhase;
  progress: number;
  totalBytes: number;
  downloadedBytes: number;
  speedBytesPerSecond: number;
  numPeers: number;
  fileName: string;
  noPeersYet: boolean;
}

export interface TorrentVideoResult {
  fileName: string;
  totalBytes: number;
}

export interface TorrentDownloadHandle {
  /// Promise that resolves once the torrent finished downloading.
  finished: Promise<TorrentVideoResult>;
  /// Streaming save to disk (File System Access API when available).
  saveVideo(): Promise<void>;
  /** Saves the original .torrent metadata file to the user's device. */
  saveTorrentFile(): Promise<void>;
  /** Hand-built magnet link (info hash + display name + trackers). */
  magnetUri(): string;
  /** Suggested .torrent file name, derived from the movie title. */
  suggestedTorrentFileName(): string;
  /** Cancels the download and disconnects the browser from the swarm. */
  abort(): void;
}

function formatPickerName(rawName: string): string {
  return rawName.replace(/[\\/:*?"<>|]+/g, '_').trim() || 'movie';
}

function pickPrimaryFile(torrent: WebTorrentInstance): WebTorrentFile | null {
  if (torrent.files.length === 0) return null;
  const videos = torrent.files.filter((file) =>
    VIDEO_FILE_EXTENSION_PATTERN.test(file.path || file.name),
  );
  const candidates = videos.length > 0 ? videos : torrent.files;
  return candidates.reduce((largest, current) =>
    current.length > largest.length ? current : largest,
  );
}

function saveViaAnchorDownload(blob: Blob, fileName: string): void {
  const url = URL.createObjectURL(blob);
  try {
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = fileName;
    anchor.rel = 'noopener';
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
  } finally {
    window.setTimeout(() => URL.revokeObjectURL(url), 60_000);
  }
}

function getSavePicker():
  | ((options: {
      suggestedName: string;
      types: Array<{ description: string; accept: Record<string, string[]> }>;
    }) => Promise<FileSystemFileHandle>)
  | null {
  const entry = (
    window as unknown as {
      showSaveFilePicker?: unknown;
    }
  ).showSaveFilePicker;
  return typeof entry === 'function'
    ? (entry as unknown as (options: {
        suggestedName: string;
        types: Array<{ description: string; accept: Record<string, string[]> }>;
      }) => Promise<FileSystemFileHandle>)
    : null;
}

async function streamTorrentFileToDisk(
  file: WebTorrentFile,
  fileName: string,
): Promise<void> {
  const picker = getSavePicker();
  if (!picker) {
    const blob = await file.blob();
    saveViaAnchorDownload(blob, fileName);
    return;
  }
  const extensionMatch = /\.(\w{2,4})$/.exec(fileName);
  const extension = extensionMatch ? `.${extensionMatch[1]}` : '.mp4';
  const handle = await picker({
    suggestedName: fileName,
    types: [
      {
        description: 'Video file',
        accept: { 'video/mp4': [extension] },
      },
    ],
  });
  const writable = await handle.createWritable();
  const stream = file.stream();
  const reader = stream.getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) await writable.write(value as FileSystemWriteChunkType);
    }
    await writable.close();
  } catch (error) {
    await writable.abort();
    throw error;
  }
}

export interface StartMovieDownloadInput {
  /** Raw .torrent file bytes (relayed through the API, never stored). */
  torrentBytes: Uint8Array;
  /** Plain info hash from the YTS listing (untouched 40-char hex). */
  infoHash?: string;
  fallbackFileName: string;
  onProgress?: (progress: TorrentDownloadProgress) => void;
  onFailed?: (error: Error) => void;
}

/**
 * Saves the small .torrent metadata file itself to the user's device so the
 * movie can also be fetched with a full desktop torrent client — those speak
 * UDP trackers and always reach the seeding swarm, unlike a browser.
 */
export async function saveTorrentMetaToDisk(
  torrentBytes: Uint8Array,
  fileName: string,
): Promise<void> {
  // Copy into a fresh buffer so the Blob receives an ArrayBuffer-backed view
  // (certain TS lib targets reject ArrayBufferLike views directly).
  const blob = new Blob([Uint8Array.from(torrentBytes)], {
    type: 'application/x-bittorrent',
  });
  const picker = getSavePicker();
  if (!picker) {
    saveViaAnchorDownload(blob, fileName);
    return;
  }
  try {
    const handle = await picker({
      suggestedName: fileName,
      types: [
        {
          description: 'Torrent file',
          accept: { 'application/x-bittorrent': ['.torrent'] },
        },
      ],
    });
    const writable = await handle.createWritable();
    try {
      await writable.write(blob as FileSystemWriteChunkType);
      await writable.close();
    } catch (writeError) {
      try {
        await writable.abort();
      } catch {
        // The writable already closed itself; surface the original error.
      }
      throw writeError;
    }
  } catch (pickerError) {
    // AbortError means the user closed the picker dialog — not a failure.
    const errorName =
      pickerError instanceof DOMException ? pickerError.name : '';
    if (errorName === 'AbortError') return;
    saveViaAnchorDownload(blob, fileName);
  }
}

/**
 * Builds the standard magnet URI by hand (encodeURIComponent matches magnet
 * conventions, %20 for spaces) with every tracker from the .torrent file,
 * so desktop torrent clients can announce to them directly.
 */
export function buildMagnetFromTorrent(
  torrentBytes: Uint8Array,
  infoHash: string | undefined,
  fallbackName: string,
): string {
  let displayName = fallbackName;
  const trackers: string[] = [];
  try {
    const parsed = decodeTorrent(torrentBytes);
    if (parsed.name) displayName = parsed.name;
    for (const tracker of parsed.announceList) {
      if (!trackers.includes(tracker)) trackers.push(tracker);
    }
  } catch {
    // Metadata unusable — fall back to the hash + name alone.
  }
  const hash = infoHash || '';
  let magnet = hash
    ? `magnet:?xt=urn:btih:${hash}&dn=${encodeURIComponent(displayName)}`
    : `magnet:?dn=${encodeURIComponent(displayName)}`;
  magnet += trackers
    .map((tracker) => `&tr=${encodeURIComponent(tracker)}`)
    .join('');
  return magnet;
}

/** Suggested .torrent filename from the movie title and quality. */
export function computeTorrentSaveFileName(
  title: string,
  quality?: string,
): string {
  const parts = [title.trim(), (quality || '').trim()]
    .filter(Boolean)
    .join(' ');
  return `${formatPickerName(parts || 'movie')}.torrent`;
}

/* -- UDP relay bridge (server peer provides full UDP/DHT swarm access) -- */

export function buildBridgeStreamUrl(hash: string): string {
  return `/api/download/bridge?hash=${encodeURIComponent(hash)}&act=stream`;
}

export function buildBridgeStatusUrl(hash: string): string {
  return `/api/download/bridge?hash=${encodeURIComponent(hash)}&act=status`;
}

export function buildBridgeReleaseUrl(hash: string): string {
  return `/api/download/bridge?hash=${encodeURIComponent(hash)}&act=release`;
}

export interface BridgeStatusSnapshot {
  ready: boolean;
  progress: number;
  downloadedBytes: number;
  totalBytes: number;
  numPeers: number;
  speedBytesPerSecond: number;
  fileName: string;
  fileBytes: number;
}

export interface BridgeSaveInput {
  hash: string;
  suggestedName: string;
  onProgress?: (progress: {
    percent: number;
    receivedBytes: number;
    totalBytes: number;
  }) => void;
}

/**
 * Relays the bridge stream straight to the user's disk. With the File
 * System Access API the movie streams chunk-by-chunk while the server peer
 * downloads it; without the picker the browser's native download manager
 * streams the response to disk on its own.
 */
export async function saveBridgeVideoToDisk(input: BridgeSaveInput): Promise<void> {
  const picker = getSavePicker();
  if (!picker) {
    // Direct navigation: the browser streams the response to the Downloads
    // folder without buffering the whole movie in memory.
    const anchor = document.createElement('a');
    anchor.href = buildBridgeStreamUrl(input.hash);
    anchor.download = input.suggestedName;
    anchor.rel = 'noopener';
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    return;
  }

  const response = await fetch(buildBridgeStreamUrl(input.hash), {
    cache: 'no-store',
  });
  if (!response.ok || !response.body) {
    throw new Error(
      `The relay bridge could not serve the video yet (HTTP ${response.status}).`,
    );
  }
  const total = Number(response.headers.get('Content-Length') || 0);
  const handle = await picker({
    suggestedName: input.suggestedName,
    types: [
      {
        description: 'Video file',
        accept: { 'video/mp4': ['.mp4'] },
      },
    ],
  });
  const writable = await handle.createWritable();
  const reader = response.body.getReader();
  let received = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) {
        await writable.write(value as FileSystemWriteChunkType);
        received += value.byteLength;
        input.onProgress?.({
          percent: total > 0 ? Math.min(100, Math.round((received / total) * 100)) : 0,
          receivedBytes: received,
          totalBytes: total,
        });
      }
    }
    await writable.close();
  } catch (error) {
    await writable.abort();
    throw error;
  }
}

/** Tolerant status poller for the bridge torrent. */
export async function fetchBridgeStatus(
  hash: string,
): Promise<BridgeStatusSnapshot | null> {
  try {
    const response = await fetch(buildBridgeStatusUrl(hash), {
      cache: 'no-store',
    });
    if (!response.ok) return null;
    const payload = (await response.json()) as {
      ok?: boolean;
      status?: BridgeStatusSnapshot | null;
    };
    return payload.status ?? null;
  } catch {
    return null;
  }
}

export function startMovieDownload(
  input: StartMovieDownloadInput,
): TorrentDownloadHandle {
  let destroyed = false;
  let client: WebTorrentClientStatic | null = null;
  let torrent: WebTorrentInstance | null = null;
  let pollTimer: number | null = null;
  let startedAt = 0;
  const listeners: Array<() => void> = [];
  let failed = false;

  const baseFileName = formatPickerName(input.fallbackFileName || 'movie');
  const suggestedTorrentName = computeTorrentSaveFileName(
    input.fallbackFileName || 'movie',
  );

  const startState: TorrentDownloadProgress = {
    phase: 'connecting',
    progress: 0,
    totalBytes: 0,
    downloadedBytes: 0,
    speedBytesPerSecond: 0,
    numPeers: 0,
    fileName: baseFileName,
    noPeersYet: false,
  };

  let currentState = { ...startState };

  const emit = () => {
    if (destroyed) return;
    input.onProgress?.({ ...currentState });
  };

  let resolveFinished: (value: TorrentVideoResult) => void;
  let rejectFinished: (reason: Error) => void;
  const finished = new Promise<TorrentVideoResult>((resolve, reject) => {
    resolveFinished = resolve;
    rejectFinished = reject;
  });

  const updateFromTorrent = () => {
    if (!torrent) return;
    currentState = {
      ...currentState,
      phase: torrent.done
        ? 'done'
        : torrent.progress > 0
          ? 'downloading'
          : 'connecting',
      progress: Math.min(1, Math.max(0, torrent.progress)),
      totalBytes: torrent.length,
      downloadedBytes: Math.round(torrent.downloaded),
      speedBytesPerSecond: Math.round(torrent.downloadSpeed),
      numPeers: torrent.numPeers,
      noPeersYet:
        !torrent.done &&
        torrent.numPeers === 0 &&
        torrent.progress === 0 &&
        startedAt > 0 &&
        Date.now() - startedAt > 15_000,
      fileName: torrent.name || currentState.fileName,
    };
    emit();
  };

  const clearPollTimer = () => {
    if (pollTimer !== null) {
      window.clearInterval(pollTimer);
      pollTimer = null;
    }
  };

  const teardown = () => {
    clearPollTimer();
    listeners.forEach((off) => off());
    listeners.length = 0;
  };

  const handleUnload = () => {
    destroyed = true;
    teardown();
    client?.destroy();
    client = null;
  };
  window.addEventListener('pagehide', handleUnload);
  listeners.push(() =>
    window.removeEventListener('pagehide', handleUnload),
  );

  const start = async () => {
    try {
      const WebTorrent = await loadWebTorrent();
      if (destroyed) return;
      if (WebTorrent.WEBRTC_SUPPORT === false) {
        throw new Error(
          'This browser cannot join the torrent swarm: WebRTC is disabled.',
        );
      }

      const parsed = decodeTorrent(input.torrentBytes);
      const videoFile = findPrimaryVideoFile(parsed.files);
      const preferredName = videoFile
        ? videoFile.path.split('/').pop() || parsed.name
        : parsed.name;
      currentState.fileName = formatPickerName(preferredName);
      currentState.totalBytes = parsed.length;
      emit();

      client = new WebTorrent({ rtcConfig: BROWSER_RTC_CONFIG });
      torrent = client.add(new Uint8Array(input.torrentBytes), {
        announce: BROWSER_ANNOUNCE_TRACKERS,
      });
      if (!torrent) {
        throw new Error('The torrent could not be added to the client.');
      }
      startedAt = Date.now();

      torrent.on('error', () => {
        // Individual tracker/peer errors are emitted here and are usually
        // recoverable; the poller keeps announcing and the UI keeps the
        // manual .torrent/magnet fallback available at all times.
      });
      torrent.on('noPeers', () => updateFromTorrent());
      torrent.on('download', () => updateFromTorrent());
      torrent.on('done', () => {
        clearPollTimer();
        const current = torrent;
        if (!current) return;
        updateFromTorrent();
        const primary = pickPrimaryFile(current);
        const primaryName: string = primary
          ? primary.path.split('/').pop() || primary.name
          : currentState.fileName;
        currentState = {
          ...currentState,
          phase: 'done',
          progress: 1,
          fileName: primaryName,
          noPeersYet: false,
        };
        emit();
        resolveFinished({
          fileName: primaryName,
          totalBytes: current.length || currentState.totalBytes,
        });
      });

      pollTimer = window.setInterval(updateFromTorrent, 1000);
      // No hard timeout: the browser keeps announcing to every wss tracker
      // and polls progress forever, so peers joining late still resume the
      // download. The UI surfaces "still looking for peers" while empty and
      // always offers the .torrent/magnet fallback for desktop clients.
    } catch (error) {
      if (!destroyed && !failed) {
        failed = true;
        rejectFinished(
          error instanceof Error ? error : new Error('Torrent download failed.'),
        );
      }
    }
  };

  void start();

  const handle = {
    finished,
    abort: () => {
      if (destroyed) return;
      destroyed = true;
      teardown();
      if (client) client.destroy();
      client = null;
      torrent = null;
      if (!failed) {
        failed = true;
        rejectFinished(new Error('The download was cancelled.'));
      }
    },
    saveVideo: async () => {
      if (!torrent) throw new Error('Torrent not ready to save.');
      const primary = pickPrimaryFile(torrent);
      if (!primary) throw new Error('No video file found in this torrent.');
      const fileName = primary.path.split('/').pop() || primary.name;
      await streamTorrentFileToDisk(primary, formatPickerName(fileName));
    },
    saveTorrentFile: async () => {
      await saveTorrentMetaToDisk(input.torrentBytes, suggestedTorrentName);
    },
    magnetUri: () =>
      buildMagnetFromTorrent(
        input.torrentBytes,
        input.infoHash,
        baseFileName,
      ),
    suggestedTorrentFileName: () => suggestedTorrentName,
  } satisfies TorrentDownloadHandle;

  return handle;
}

/** Parses a .torrent payload for a quick filename preview before download. */
export function getTorrentDisplayName(
  torrentBytes: Uint8Array,
  fallback: string,
): string {
  try {
    const parsed = decodeTorrent(torrentBytes);
    const video = findPrimaryVideoFile(parsed.files);
    const name = video
      ? video.path.split('/').pop() || parsed.name
      : parsed.name;
    return formatPickerName(name || fallback);
  } catch {
    return fallback;
  }
}

/** Human-readable byte formatter shared by download UI surfaces. */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 MB';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const power = Math.min(
    units.length - 1,
    Math.floor(Math.log(bytes) / Math.log(1024)),
  );
  const value = bytes / 1024 ** power;
  return `${value.toFixed(value >= 10 || power === 0 ? 0 : 1)} ${units[power]}`;
}
