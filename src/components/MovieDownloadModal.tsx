'use client';

import { motion } from 'framer-motion';
import { Check, Download, Loader2, X } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';

import {
  type BridgeStatusSnapshot,
  type TorrentDownloadHandle,
  type TorrentDownloadProgress,
  buildBridgeReleaseUrl,
  buildMagnetFromTorrent,
  computeTorrentSaveFileName,
  formatBytes,
  saveBridgeVideoToDisk,
  saveTorrentMetaToDisk,
  startMovieDownload,
} from '@/lib/movie-download.client';
import type { YtsTorrent } from '@/lib/yts-torrents';

interface YtsTorrentsResponse {
  title: string;
  year: string;
  torrents: YtsTorrent[];
}

type DownloadUiPhase =
  | 'listing'
  | 'starting'
  | 'downloading'
  | 'saving'
  | 'saved'
  | 'done';

export interface MovieDownloadModalProps {
  open: boolean;
  onClose: () => void;
  movieTitle: string;
  movieYear?: string;
  imdbId?: string;
}

export default function MovieDownloadModal({
  open,
  onClose,
  movieTitle,
  movieYear,
  imdbId,
}: MovieDownloadModalProps) {
  const { t } = useTranslation();
  const [listing, setListing] = useState<YtsTorrentsResponse | null>(null);
  const [listingError, setListingError] = useState<string | null>(null);
  const [listingLoading, setListingLoading] = useState(false);
  const [uiPhase, setUiPhase] = useState<DownloadUiPhase>('listing');
  const [error, setError] = useState<string | null>(null);
  const [progress, setProgress] = useState<TorrentDownloadProgress | null>(null);
  const [readyFileName, setReadyFileName] = useState('');
  const [torrentSaved, setTorrentSaved] = useState(false);
  const [magnetCopied, setMagnetCopied] = useState(false);
  const [relayMode, setRelayMode] = useState(false);
  const [relayProgress, setRelayProgress] =
    useState<BridgeStatusSnapshot | null>(null);
  const [relaySaving, setRelaySaving] = useState(false);
  const [relayError, setRelayError] = useState<string | null>(null);
  const handleRef = useRef<TorrentDownloadHandle | null>(null);
  const torrentBytesRef = useRef<Uint8Array | null>(null);
  const torrentMetaRef = useRef<{ hash: string; quality: string } | null>(
    null,
  );
  const startingRef = useRef(false);
  const uiPhaseRef = useRef(uiPhase);
  uiPhaseRef.current = uiPhase;
  const progressRef = useRef<TorrentDownloadProgress | null>(null);
  const relayModeRef = useRef(false);
  relayModeRef.current = relayMode;
  const startedWebRtcAtRef = useRef(0);
  const watchdogTimerRef = useRef<number | null>(null);
  const relayPollTimerRef = useRef<number | null>(null);

  const clearWatchdog = useCallback(() => {
    if (watchdogTimerRef.current !== null) {
      window.clearTimeout(watchdogTimerRef.current);
      watchdogTimerRef.current = null;
    }
  }, []);

  const clearRelayPoll = useCallback(() => {
    if (relayPollTimerRef.current !== null) {
      window.clearInterval(relayPollTimerRef.current);
      relayPollTimerRef.current = null;
    }
  }, []);

  const releaseBridgeTorrent = useCallback(() => {
    const hash = torrentMetaRef.current?.hash;
    if (!hash) return;
    void fetch(buildBridgeReleaseUrl(hash), {
      cache: 'no-store',
      keepalive: true,
    }).catch(() => undefined);
  }, []);

  const resetDownloadState = useCallback((abortActive: boolean) => {
    if (abortActive && handleRef.current) {
      handleRef.current.abort();
      handleRef.current = null;
    }
    clearWatchdog();
    clearRelayPoll();
    releaseBridgeTorrent();
    startingRef.current = false;
    relayModeRef.current = false;
    setRelayMode(false);
    setRelayProgress(null);
    setRelayError(null);
    setRelaySaving(false);
    setProgress(null);
    setReadyFileName('');
    setTorrentSaved(false);
    setMagnetCopied(false);
    setUiPhase('listing');
    setError(null);
    }, [clearRelayPoll, clearWatchdog, releaseBridgeTorrent]);

  const startRelayPolling = useCallback(
    (hash: string) => {
      clearRelayPoll();
      const poll = async () => {
        try {
          const response = await fetch(
            `/api/download/bridge?hash=${encodeURIComponent(hash)}&act=status`,
            { cache: 'no-store' },
          );
          if (!response.ok) throw new Error(`HTTP ${response.status}`);
          const payload = (await response.json()) as {
            ok?: boolean;
            status?: BridgeStatusSnapshot | null;
          };
          const snapshot = payload.status ?? null;
          setRelayProgress(snapshot);
          if (
            snapshot &&
            snapshot.fileBytes > 0 &&
            snapshot.downloadedBytes >= snapshot.fileBytes
          ) {
            clearRelayPoll();
          }
        } catch {
          setRelayError(t('play.downloadRelayUnavailable'));
          clearRelayPoll();
        }
      };
      void poll();
      relayPollTimerRef.current = window.setInterval(() => void poll(), 2000);
    },
    [clearRelayPoll, t],
  );

  /**
   * Handover from the browser-only WebRTC swarm to the server relay, which
   * joins the full UDP + DHT swarm on the network side. Also used straight
   * away when the browser cannot torrent at all (WebRTC disabled).
   */
  const enterRelayMode = useCallback(() => {
    clearWatchdog();
    const activeHandle = handleRef.current;
    handleRef.current = null;
    startingRef.current = false;
    if (activeHandle) activeHandle.abort();
    if (!relayModeRef.current) {
      relayModeRef.current = true;
      setRelayMode(true);
      setUiPhase('downloading');
    }
    const hash = torrentMetaRef.current?.hash;
    if (hash) {
      startRelayPolling(hash);
    }
  }, [clearWatchdog, startRelayPolling]);

  /** Streams the relay's video through to the user's chosen folder. */
  const handleRelaySave = useCallback(async () => {
    const hash = torrentMetaRef.current?.hash;
    if (!hash || relaySaving) return;
    setRelaySaving(true);
    setRelayError(null);
    setUiPhase('saving');
    const snapshotName = relayProgress?.fileName || '';
    const quality = torrentMetaRef.current?.quality;
    const baseName =
      snapshotName ||
      `${listing?.title || movieTitle || 'movie'}${quality ? ` ${quality}` : ''}`;
    const withExtension = /\.\w{2,5}$/.test(baseName)
      ? baseName
      : `${baseName}.mp4`;
    try {
      await saveBridgeVideoToDisk({
        hash,
        suggestedName: withExtension.replace(/[\\/:*?"<>|]+/g, '_'),
      });
      setUiPhase('saved');
    } catch (error) {
      const isUserAbort =
        error instanceof DOMException && error.name === 'AbortError';
      setUiPhase('downloading');
      if (!isUserAbort) {
        setRelayError(t('play.downloadRelaySaveFailed'));
      }
    } finally {
      setRelaySaving(false);
    }
  }, [listing?.title, movieTitle, relayProgress?.fileName, relaySaving, t]);

  useEffect(() => {
    if (!open) {
      resetDownloadState(true);
      setListing(null);
      setListingError(null);
      return;
    }

    let cancelled = false;
    setListingLoading(true);
    setListingError(null);

    const params = new URLSearchParams();
    if (imdbId) params.set('imdbId', imdbId);
    if (movieTitle) params.set('title', movieTitle);
    if (movieYear) params.set('year', movieYear);

    fetch(`/api/download/yts?${params.toString()}`, { cache: 'no-store' })
      .then(async (response) => {
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        return (await response.json()) as YtsTorrentsResponse;
      })
      .then((payload) => {
        if (cancelled) return;
        if (!payload?.torrents?.length) {
          setListingError(t('play.downloadNoTorrents'));
        } else {
          setListing(payload);
        }
      })
      .catch(() => {
        if (!cancelled) setListingError(t('play.downloadLoadFailed'));
      })
      .finally(() => {
        if (!cancelled) setListingLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [open, imdbId, movieTitle, movieYear, t, resetDownloadState]);

  useEffect(() => {
    return () => {
      handleRef.current?.abort();
      handleRef.current = null;
    };
  }, []);

  const startTorrent = useCallback(
    async (torrent: YtsTorrent) => {
      if (startingRef.current) return;
      startingRef.current = true;
      setError(null);
      setRelayError(null);
      setRelayProgress(null);
      setRelayMode(false);
      relayModeRef.current = false;
      setUiPhase('starting');

      try {
        const response = await fetch(
          `/api/download/yts?torrent=${encodeURIComponent(torrent.hash)}`,
          { cache: 'no-store' },
        );
        if (!response.ok) throw new Error(await response.text());
        const bytes = new Uint8Array(await response.arrayBuffer());
        torrentBytesRef.current = bytes;
        torrentMetaRef.current = {
          hash: torrent.hash,
          quality: torrent.quality,
        };

        const handle = startMovieDownload({
          torrentBytes: bytes,
          infoHash: torrent.hash,
          fallbackFileName: listing?.title || movieTitle || 'movie',
          onProgress: (next) => {
            progressRef.current = next;
            setProgress(next);
            if (
              next.phase === 'downloading' &&
              uiPhaseRef.current === 'starting'
            ) {
              setUiPhase('downloading');
            }
          },
        });
        handleRef.current = handle;

        // UDP-swarm watchdog: browsers can only reach WebRTC peers. If
        // 20s in there is still no peer and no byte, hand over to the
        // server relay so the full UDP+DHT swarm is used automatically.
        clearWatchdog();
        startedWebRtcAtRef.current = Date.now();
        watchdogTimerRef.current = window.setTimeout(() => {
          watchdogTimerRef.current = null;
          if (relayModeRef.current) return;
          if (uiPhaseRef.current === 'done' || uiPhaseRef.current === 'saving') {
            return;
          }
          const currentProgress = progressRef.current;
          const stale = Boolean(
            currentProgress &&
              currentProgress.numPeers === 0 &&
              currentProgress.downloadedBytes === 0,
          );
          if (stale) {
            enterRelayMode();
          }
        }, 20_000);

        handle.finished
          .then((result) => {
            clearWatchdog();
            setReadyFileName(result.fileName);
            setProgress((current) =>
              current
                ? {
                    ...current,
                    phase: 'done',
                    progress: 1,
                    noPeersYet: false,
                    numPeers: current.numPeers,
                    fileName: result.fileName,
                  }
                : current,
            );
            setUiPhase('done');
          })
          .catch((failure: Error) => {
            clearWatchdog();
            startingRef.current = false;
            if (relayModeRef.current) {
              return;
            }
            handleRef.current = null;
            setUiPhase('listing');
            setProgress(null);
            if (/cancelled/i.test(failure.message)) {
              setError(null);
            } else if (/WebRTC/i.test(failure.message)) {
              // Browser cannot torrent at all — go straight to the relay.
              enterRelayMode();
            } else if (/peers/i.test(failure.message)) {
              setError(t('play.downloadNoPeersFailed'));
            } else {
              setError(t('play.downloadFetchTorrentFailed'));
            }
          });
      } catch {
        startingRef.current = false;
        setUiPhase('listing');
        setError(t('play.downloadFetchTorrentFailed'));
      }
    },
    // enterRelayMode is defined below with stable deps
    [clearWatchdog, enterRelayMode, listing?.title, movieTitle, t],
  );

  const handleSave = useCallback(async () => {
    const handle = handleRef.current;
    if (!handle) return;
    setUiPhase('saving');
    setError(null);
    try {
      await handle.saveVideo();
      setUiPhase('saved');
    } catch {
      setUiPhase('done');
      setError(t('play.downloadSaveFailed'));
    }
  }, [t]);

  const cancelDownload = useCallback(() => {
    resetDownloadState(true);
  }, [resetDownloadState]);

  /**
   * Manual fallback: hand the user the .torrent file itself so a desktop
   * torrent client (which speaks the UDP trackers YTS files ship) can always
   * fetch the movie, even when the browser finds no WebRTC peers.
   */
  const handleSaveTorrentFile = useCallback(async () => {
    const bytes = torrentBytesRef.current;
    if (!bytes) return;
    try {
      await saveTorrentMetaToDisk(
        bytes,
        computeTorrentSaveFileName(
          listing?.title || movieTitle || 'movie',
          torrentMetaRef.current?.quality,
        ),
      );
      setTorrentSaved(true);
    } catch {
      setError(t('play.downloadSaveFailed'));
    }
  }, [listing?.title, movieTitle, t]);

  const handleCopyMagnet = useCallback(() => {
    const bytes = torrentBytesRef.current;
    if (!bytes) return;
    const magnet = buildMagnetFromTorrent(
      bytes,
      torrentMetaRef.current?.hash,
      listing?.title || movieTitle || 'movie',
    );
    try {
      void navigator.clipboard
        .writeText(magnet)
        .then(() => setMagnetCopied(true))
        .catch(() => setMagnetCopied(false));
    } catch {
      setMagnetCopied(false);
    }
  }, [listing?.title, movieTitle]);

  const requestClose = useCallback(() => {
    const activePhase = uiPhaseRef.current;
    resetDownloadState(
      activePhase === 'downloading' || activePhase === 'starting',
    );
    onClose();
  }, [onClose, resetDownloadState]);

  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') requestClose();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [open, requestClose]);

  if (!open || typeof document === 'undefined') return null;

  const percent =
    progress && progress.totalBytes > 0
      ? Math.min(100, Math.round(progress.progress * 100))
      : 0;
  const relayPercent =
    relayProgress && relayProgress.fileBytes > 0
      ? Math.min(
          100,
          Math.round(
            Math.max(relayProgress.downloadedBytes, 0) /
              relayProgress.fileBytes *
              100,
          ),
        )
      : uiPhase === 'saved'
        ? 100
        : 0;
  const showTorrentList = uiPhase === 'listing' && !listingError;
  const showProgressView = uiPhase !== 'listing' || Boolean(error);

  return createPortal(
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      transition={{ duration: 0.16 }}
      className='fixed inset-0 z-[3000] flex items-center justify-center p-4'
      onPointerDown={(event) => {
        if (
          event.target === event.currentTarget &&
          uiPhase !== 'downloading' &&
          uiPhase !== 'starting' &&
          !relayMode
        ) {
          requestClose();
        }
      }}
    >
      <div className='absolute inset-0 bg-black/65' />
      <div className='absolute inset-0 bg-black/20 backdrop-blur-[6px]' />

      <motion.div
        role='dialog'
        aria-modal='true'
        aria-label={t('play.downloadTitle')}
        initial={{ opacity: 0, y: 18, scale: 0.97 }}
        animate={{ opacity: 1, y: 0, scale: 1 }}
        transition={{ duration: 0.2, ease: 'easeOut' }}
        className='ui-glass-panel relative z-[1] flex max-h-[86vh] w-[min(92vw,26rem)] flex-col overflow-hidden'
        style={{ borderRadius: 'var(--ui-radius-panel)' }}
      >
        <div className='flex items-start justify-between gap-3 border-b border-[var(--ui-glass-divider)] px-5 py-4'>
          <div className='min-w-0'>
            <p className='ui-token-text-subtle text-[11px] font-semibold uppercase tracking-wider'>
              {t('play.downloadQualityEyebrow')}
            </p>
            <h3 className='ui-token-text-strong mt-0.5 truncate text-base font-bold'>
              {t('play.downloadTitle')}
            </h3>
          </div>
          <button
            type='button'
            aria-label={t('common.close')}
            onClick={requestClose}
            className='ui-glass-control inline-flex h-9 w-9 shrink-0 items-center justify-center'
          >
            <X className='ui-token-text-muted h-4 w-4' />
          </button>
        </div>

        <div className='min-h-0 flex-1 overflow-y-auto px-5 py-4 scrollbar-hide'>
          {listingLoading ? (
            <div className='py-8 text-center'>
              <Loader2 className='ui-token-text-secondary mx-auto h-6 w-6 animate-spin' />
              <p className='ui-token-text-muted mt-3 text-sm'>
                {t('play.downloadLoadingListing')}
              </p>
            </div>
          ) : null}

          {!listingLoading && listingError ? (
            <p
              role='status'
              className='ui-token-text-muted py-6 text-center text-sm leading-6'
            >
              {listingError}
            </p>
          ) : null}

          {showTorrentList && !listingLoading && listing ? (
            <>
              <p className='ui-token-text-muted mb-3 text-xs leading-5'>
                {t('play.downloadSubtitle')}
              </p>
              <div className='space-y-1.5'>
                {listing.torrents.map((torrent) => (
                  <button
                    key={torrent.hash}
                    type='button'
                    onClick={() => void startTorrent(torrent)}
                    className='ui-glass-row flex w-full items-center gap-3 p-3 text-left transition-colors'
                    style={{ borderRadius: 'var(--ui-radius-row)' }}
                  >
                    <span className='ui-token-media-surface inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-lg'>
                      <Download className='ui-token-text-secondary h-4 w-4' />
                    </span>
                    <span className='min-w-0 flex-1'>
                      <span className='ui-token-text-primary block text-sm font-bold'>
                        {torrent.quality}
                        {torrent.size ? (
                          <span className='ui-token-text-muted ml-2 text-xs font-normal'>
                            {torrent.size}
                          </span>
                        ) : null}
                      </span>
                      <span className='ui-token-text-subtle line-clamp-1 text-[11px]'>
                        {torrent.release ||
                          [torrent.quality, listing.year].filter(Boolean).join(' · ')}
                      </span>
                    </span>
                    <span className='ui-token-text-muted shrink-0 text-[11px]'>
                      {t('play.downloadSeeds', {
                        seeds: Math.max(torrent.seeds, 0),
                      })}
                    </span>
                  </button>
                ))}
              </div>
            </>
          ) : null}

          {showProgressView && listing && relayMode ? (
            <div className='mt-1'>
              <p className='ui-token-text-primary truncate text-sm font-semibold'>
                {t('play.downloadRelayTitle')}
              </p>
              <p className='ui-token-text-muted mt-0.5 truncate text-xs'>
                {relayProgress?.fileName || listing.title}
              </p>

              <div className='mt-4 h-2 w-full overflow-hidden rounded-full bg-white/10'>
                <div
                  className='h-full rounded-full bg-gradient-to-r from-amber-400 to-yellow-300 transition-[width] duration-500 ease-out'
                  style={{ width: `${relayPercent}%` }}
                />
              </div>

              <p className='ui-token-text-muted mt-2 text-xs'>
                {relayPercent >= 100
                  ? t('play.finishedLabel')
                  : relayProgress && relayProgress.numPeers > 0
                    ? t('play.downloadPeersLine', {
                        peers: relayProgress.numPeers,
                        speed: formatBytes(relayProgress.speedBytesPerSecond),
                        percent: relayPercent,
                      })
                    : t('play.downloadRelayConnecting')}
              </p>

              <p className='ui-token-text-subtle mt-2 text-[11px] leading-5'>
                {t('play.downloadRelayNote')}
              </p>

              {relayError ? (
                <p
                  role='alert'
                  className='ui-token-text-muted mt-3 text-xs leading-5'
                >
                  {relayError}
                </p>
              ) : null}

              {uiPhase !== 'saved' ? (
                <button
                  type='button'
                  onClick={() => void handleRelaySave()}
                  disabled={relaySaving}
                  className='mt-4 inline-flex w-full items-center justify-center gap-2 rounded-[var(--ui-radius-row)] bg-white px-4 py-2.5 text-sm font-semibold text-zinc-950 shadow-[0_10px_24px_rgba(0,0,0,0.24)] hover:bg-zinc-100 disabled:opacity-60'
                >
                  {relaySaving ? (
                    <Loader2 className='h-4 w-4 animate-spin' />
                  ) : (
                    <Download className='h-4 w-4' />
                  )}
                  {relaySaving
                    ? t('play.downloadSavingLabel')
                    : t('play.downloadRelaySaveButton')}
                </button>
              ) : null}

              {uiPhase === 'saving' ? (
                <p className='ui-token-text-muted mt-3 text-xs'>
                  {t('play.downloadRelaySaveNote')}
                </p>
              ) : null}

              {uiPhase === 'saved' ? (
                <p
                  role='status'
                  className='ui-token-text-primary mt-3 flex items-center gap-2 text-xs font-semibold'
                >
                  <Check className='h-4 w-4 text-emerald-400' />
                  {t('play.downloadSaved')}
                </p>
              ) : null}

              {uiPhase !== 'saved' ? (
                <div
                  className='mt-4 border border-[var(--ui-glass-divider)] bg-white/[0.04] p-3'
                  style={{ borderRadius: 'var(--ui-radius-row)' }}
                >
                  <p className='ui-token-text-primary text-xs font-bold'>
                    {t('play.downloadManualTitle')}
                  </p>
                  <p className='ui-token-text-muted mt-1 text-[11px] leading-4'>
                    {t('play.downloadManualHint')}
                  </p>
                  <div className='mt-2.5 flex flex-wrap gap-2'>
                    <button
                      type='button'
                      onClick={() => void handleSaveTorrentFile()}
                      className='ui-glass-control inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold'
                    >
                      <Download className='h-3.5 w-3.5' />
                      {t('play.downloadSaveTorrentButton')}
                    </button>
                    <button
                      type='button'
                      onClick={handleCopyMagnet}
                      className='ui-glass-control inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold'
                    >
                      {t('play.downloadCopyMagnetButton')}
                    </button>
                  </div>
                </div>
              ) : null}

              {uiPhase !== 'saved' ? (
                <button
                  type='button'
                  onClick={cancelDownload}
                  className='ui-glass-control mt-4 w-full px-4 py-2 text-sm font-semibold'
                >
                  {t('play.cancelDownload')}
                </button>
              ) : null}
            </div>
          ) : null}

          {showProgressView && listing && !relayMode ? (
            <div className='mt-1'>
              {error ? (
                <p
                  role='alert'
                  className='ui-token-text-muted text-center text-sm leading-6'
                >
                  {error}
                </p>
              ) : (
                <>
                  <p className='ui-token-text-primary truncate text-sm font-semibold'>
                    {uiPhase === 'starting'
                      ? t('play.startingDownload')
                      : uiPhase === 'saving' || uiPhase === 'saved'
                        ? t('play.downloadSavingLabel')
                        : progress?.phase === 'done'
                          ? t('play.finishedLabel')
                          : t('play.downloadingLabel')}
                  </p>
                  <p className='ui-token-text-muted mt-0.5 truncate text-xs'>
                    {readyFileName || progress?.fileName || listing.title}
                  </p>

                  <div className='mt-4 h-2 w-full overflow-hidden rounded-full bg-white/10'>
                    <div
                      className='h-full rounded-full bg-gradient-to-r from-amber-400 to-yellow-300 transition-[width] duration-500 ease-out'
                      style={{ width: `${percent}%` }}
                    />
                  </div>

                  <p className='ui-token-text-muted mt-2 text-xs'>
                    {percent >= 100
                      ? t('play.finishedLabel')
                      : progress && progress.numPeers > 0
                        ? t('play.downloadPeersLine', {
                            peers: progress.numPeers,
                            speed: formatBytes(progress.speedBytesPerSecond),
                            percent,
                          })
                        : t('play.connectingLabel')}
                  </p>

                  {progress?.noPeersYet ? (
                    <p className='ui-token-text-subtle mt-2 text-[11px] leading-5'>
                      {t('play.downloadNoPeersHint')}
                    </p>
                  ) : null}

                  {uiPhase === 'starting' || uiPhase === 'downloading' ? (
                    <div
                      className='mt-4 border border-[var(--ui-glass-divider)] bg-white/[0.04] p-3'
                      style={{ borderRadius: 'var(--ui-radius-row)' }}
                    >
                      <p className='ui-token-text-primary text-xs font-bold'>
                        {t('play.downloadManualTitle')}
                      </p>
                      <p className='ui-token-text-muted mt-1 text-[11px] leading-4'>
                        {t('play.downloadManualHint')}
                      </p>
                      <div className='mt-2.5 flex flex-wrap gap-2'>
                        <button
                          type='button'
                          onClick={() => void handleSaveTorrentFile()}
                          className='ui-glass-control inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold'
                        >
                          <Download className='h-3.5 w-3.5' />
                          {t('play.downloadSaveTorrentButton')}
                        </button>
                        <button
                          type='button'
                          onClick={handleCopyMagnet}
                          className='ui-glass-control inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold'
                        >
                          {t('play.downloadCopyMagnetButton')}
                        </button>
                      </div>
                      {torrentSaved ? (
                        <p
                          role='status'
                          className='ui-token-text-primary mt-2 flex items-center gap-1.5 text-[11px] font-semibold'
                        >
                          <Check className='h-3 w-3 text-emerald-400' />
                          {t('play.downloadTorrentSaved')}
                        </p>
                      ) : null}
                      {magnetCopied ? (
                        <p
                          role='status'
                          className='ui-token-text-primary mt-2 flex items-center gap-1.5 text-[11px] font-semibold'
                        >
                          <Check className='h-3 w-3 text-emerald-400' />
                          {t('play.downloadMagnetCopied')}
                        </p>
                      ) : null}
                    </div>
                  ) : null}

                  {uiPhase === 'downloading' || uiPhase === 'starting' ? (
                    <button
                      type='button'
                      onClick={cancelDownload}
                      className='ui-glass-control mt-4 w-full px-4 py-2 text-sm font-semibold'
                    >
                      {t('play.cancelDownload')}
                    </button>
                  ) : null}

                  {progress?.phase === 'done' && uiPhase === 'done' ? (
                    <button
                      type='button'
                      onClick={() => void handleSave()}
                      className='mt-4 inline-flex w-full items-center justify-center gap-2 rounded-[var(--ui-radius-row)] bg-white px-4 py-2.5 text-sm font-semibold text-zinc-950 shadow-[0_10px_24px_rgba(0,0,0,0.24)] hover:bg-zinc-100'
                    >
                      <Check className='h-4 w-4' />
                      {t('play.downloadSaveButton')}
                    </button>
                  ) : null}

                  {uiPhase === 'saving' ? (
                    <p className='ui-token-text-muted mt-3 text-xs'>
                      {t('play.downloadSavingNote')}
                    </p>
                  ) : null}

                  {uiPhase === 'saved' ? (
                    <p
                      role='status'
                      className='ui-token-text-primary mt-3 flex items-center gap-2 text-xs font-semibold'
                    >
                      <Check className='h-4 w-4 text-emerald-400' />
                      {t('play.downloadSaved')}
                    </p>
                  ) : null}
                </>
              )}
            </div>
          ) : null}
        </div>

        <div className='border-t border-[var(--ui-glass-divider)] px-5 py-3'>
          <p className='ui-token-text-subtle text-[10px] leading-4'>
            {t('play.downloadBrowserOnlyNote')}
          </p>
        </div>
      </motion.div>
    </motion.div>,
    document.body,
  );
}
