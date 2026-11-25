'use client';

import {
  Captions,
  CaptionsOff,
  Check,
  Loader2,
  RotateCcw,
  Upload,
  X,
} from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

import {
  type SubtitleCue,
  type SubtitleLanguage,
  applySubtitleTiming,
  clampSubtitleOffset,
  decodeSubtitleBytes,
  findActiveSubtitleCue,
  formatSubtitleOffset,
  normalizeSubtitleTiming,
  parseSubtitleText,
} from '@/lib/subtitles';

interface SubtitlesResponse {
  ok?: boolean;
  cues?: SubtitleCue[];
  meta?: {
    fileName?: string;
    cueCount?: number;
    fps?: number;
  };
}

export interface DirectPlayerSubtitlesProps {
  tmdbId: string;
  mediaType: 'movie' | 'tv';
  season: number;
  episode: number;
  preferredLanguage: SubtitleLanguage;
  currentTime: number;
  /** `overlay` renders over a third-party iframe player. */
  variant?: 'embedded' | 'overlay';
  /** True when the playback time is estimated rather than reported. */
  syncEstimated?: boolean;
  /** Offered when the current source cannot report exact playback time. */
  onSwitchToLuma?: () => void;
  /**
   * Re-anchors the subtitle clock to a playback time the user read from a
   * third-party player. Only used by the `overlay` variant.
   */
  onAnchorTime?: (seconds: number) => void;
}

type SubtitleStatus = 'idle' | 'loading' | 'ready' | 'empty' | 'error';

const SYNC_STORAGE_PREFIX = 'luma:subtitle-sync:v1';
const ENABLED_STORAGE_KEY = 'luma:subtitle-enabled:v1';
const MAX_SUBTITLE_FILE_BYTES = 8 * 1024 * 1024;

function timingStorageKey(
  mediaType: 'movie' | 'tv',
  tmdbId: string,
  season: number,
  episode: number,
  language: SubtitleLanguage,
): string {
  return `${SYNC_STORAGE_PREFIX}:${mediaType}:${tmdbId}:${season}:${episode}:${language}`;
}

function readStoredTiming(key: string) {
  if (typeof window === 'undefined') return normalizeSubtitleTiming(null);
  try {
    const raw = window.localStorage.getItem(key);
    if (!raw) return normalizeSubtitleTiming(null);
    return normalizeSubtitleTiming(JSON.parse(raw));
  } catch {
    return normalizeSubtitleTiming(null);
  }
}

function writeStoredTiming(
  key: string,
  timing: { offsetMs: number; scale: number },
) {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(key, JSON.stringify(timing));
  } catch {
    // Storage can be unavailable in private mode; the feature still works.
  }
}

/** Parses `90`, `1:30`, or `0:01:30` into seconds. */
function parseTimeInput(value: string): number | null {
  const trimmed = value.trim();
  if (!trimmed) return null;
  if (/^\d+(?:\.\d+)?$/.test(trimmed)) {
    const seconds = Number(trimmed);
    return Number.isFinite(seconds) ? seconds : null;
  }
  const parts = trimmed.split(':');
  if (parts.length < 2 || parts.length > 3) return null;
  const numbers = parts.map((part) => Number(part));
  if (numbers.some((part) => !Number.isFinite(part) || part < 0)) return null;
  return numbers.reduce((total, part) => total * 60 + part, 0);
}

function formatClockTime(seconds: number): string {
  const safe = Math.max(0, Math.floor(seconds));
  const hours = Math.floor(safe / 3600);
  const minutes = Math.floor((safe % 3600) / 60);
  const secs = safe % 60;
  const pad = (value: number) => String(value).padStart(2, '0');
  return hours > 0
    ? `${hours}:${pad(minutes)}:${pad(secs)}`
    : `${minutes}:${pad(secs)}`;
}

function readEnabledPreference(): boolean {
  if (typeof window === 'undefined') return true;
  try {
    return window.localStorage.getItem(ENABLED_STORAGE_KEY) !== '0';
  } catch {
    return true;
  }
}

/**
 * Luma's own subtitle layer for the direct player.
 *
 * Because the player renders the cues, timing can be corrected live:
 * delay buttons shift every cue, the slider gives fine control, and the
 * optional length fit stretches drifting tracks. Corrections are saved per
 * movie/episode/language, so a fix is remembered on the next watch.
 */
export function DirectPlayerSubtitles({
  tmdbId,
  mediaType,
  season,
  episode,
  preferredLanguage,
  currentTime,
  variant = 'embedded',
  syncEstimated = false,
  onSwitchToLuma,
  onAnchorTime,
}: DirectPlayerSubtitlesProps) {
  const { t, i18n } = useTranslation();
  const isOverlay = variant === 'overlay';
  const uiDirection = i18n.language?.toLowerCase().startsWith('ar')
    ? 'rtl'
    : 'ltr';
  const [language, setLanguage] = useState<SubtitleLanguage>(preferredLanguage);
  const [panelOpen, setPanelOpen] = useState(false);
  const [status, setStatus] = useState<SubtitleStatus>('idle');
  const [enabled, setEnabled] = useState(readEnabledPreference);
  const [cues, setCues] = useState<SubtitleCue[]>([]);
  const [fileName, setFileName] = useState('');
  const [sourceFps, setSourceFps] = useState<number | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [offsetMs, setOffsetMs] = useState(0);
  const [scale, setScale] = useState(1);
  const [reloadKey, setReloadKey] = useState(0);
  const [anchorValue, setAnchorValue] = useState('');
  const fileInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    setLanguage(preferredLanguage);
  }, [preferredLanguage]);

  useEffect(() => {
    try {
      window.localStorage.setItem(ENABLED_STORAGE_KEY, enabled ? '1' : '0');
    } catch {
      // Ignore storage failures.
    }
  }, [enabled]);

  useEffect(() => {
    const controller = new AbortController();
    setStatus('loading');
    setNotice(null);
    setCues([]);
    setFileName('');

    const query = new URLSearchParams({
      tmdbId,
      type: mediaType,
      lang: language,
    });
    if (mediaType === 'tv') {
      query.set('season', String(season));
      query.set('episode', String(episode));
    }

    void fetch(`/api/player/subtitles?${query.toString()}`, {
      cache: 'no-store',
      signal: controller.signal,
    })
      .then(async (response) => {
        if (response.status === 404) return null;
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        return (await response.json()) as SubtitlesResponse | null;
      })
      .then((payload) => {
        if (controller.signal.aborted) return;
        if (!payload) {
          setStatus('empty');
          return;
        }
        const nextCues = Array.isArray(payload?.cues)
          ? payload.cues.filter(
              (cue) =>
                cue &&
                Number.isFinite(cue.start) &&
                Number.isFinite(cue.end) &&
                cue.end > cue.start &&
                typeof cue.text === 'string' &&
                cue.text.trim().length > 0,
            )
          : [];
        if (nextCues.length === 0) {
          setStatus('empty');
          return;
        }
        const stored = readStoredTiming(
          timingStorageKey(mediaType, tmdbId, season, episode, language),
        );
        setCues(nextCues);
        setFileName(payload.meta?.fileName || '');
        setSourceFps(
          Number.isFinite(payload.meta?.fps) && (payload.meta?.fps || 0) > 0
            ? Number(payload.meta?.fps)
            : null,
        );
        setOffsetMs(stored.offsetMs);
        setScale(stored.scale);
        setStatus('ready');
      })
      .catch(() => {
        if (controller.signal.aborted) return;
        setStatus('error');
      });

    return () => controller.abort();
  }, [tmdbId, mediaType, season, episode, language, reloadKey]);

  useEffect(() => {
    if (status !== 'ready') return;
    writeStoredTiming(
      timingStorageKey(mediaType, tmdbId, season, episode, language),
      { offsetMs, scale },
    );
  }, [status, offsetMs, scale, mediaType, tmdbId, season, episode, language]);

  const timedCues = useMemo(
    () => applySubtitleTiming(cues, { offsetMs, scale }),
    [cues, offsetMs, scale],
  );
  const activeCue = useMemo(
    () => (enabled ? findActiveSubtitleCue(timedCues, currentTime) : null),
    [enabled, timedCues, currentTime],
  );

  const nudge = useCallback((deltaMs: number) => {
    setOffsetMs((current) => clampSubtitleOffset(current + deltaMs));
  }, []);

  useEffect(() => {
    if (!panelOpen) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.metaKey || event.ctrlKey || event.altKey) return;
      if (event.key === '[') {
        event.preventDefault();
        nudge(-500);
      } else if (event.key === ']') {
        event.preventDefault();
        nudge(500);
      } else if (event.key === '\\') {
        event.preventDefault();
        setOffsetMs(0);
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [panelOpen, nudge]);

  const handleDrift = useCallback(
    (ratio: number) => {
      setScale(ratio);
      setNotice(t('play.subtitlesDriftApplied'));
    },
    [t],
  );

  const applyAnchor = useCallback(() => {
    if (!onAnchorTime) return;
    const seconds = parseTimeInput(anchorValue);
    if (seconds === null) {
      setNotice(t('play.subtitlesAnchorInvalid'));
      return;
    }
    onAnchorTime(seconds);
    setNotice(
      t('play.subtitlesAnchorApplied', { time: formatClockTime(seconds) }),
    );
  }, [anchorValue, onAnchorTime, t]);

  const handleFile = useCallback(
    async (file: File | undefined) => {
      if (!file) return;
      if (file.size > MAX_SUBTITLE_FILE_BYTES) {
        setNotice(t('play.subtitlesFileInvalid'));
        return;
      }
      try {
        const bytes = new Uint8Array(await file.arrayBuffer());
        const text = decodeSubtitleBytes(bytes, language);
        const parsed = parseSubtitleText(text);
        if (parsed.length === 0) {
          setNotice(t('play.subtitlesFileInvalid'));
          return;
        }
        setCues(parsed);
        setFileName(file.name);
        setOffsetMs(0);
        setScale(1);
        setStatus('ready');
        setEnabled(true);
        setNotice(t('play.subtitlesFileLoaded'));
      } catch {
        setNotice(t('play.subtitlesFileInvalid'));
      }
    },
    [language, t],
  );

  const offsetLabel =
    Math.abs(offsetMs) < 50
      ? t('play.subtitlesOnTime')
      : offsetMs < 0
        ? t('play.subtitlesSecondsAhead', {
            value: formatSubtitleOffset(offsetMs).replace('-', ''),
          })
        : t('play.subtitlesSecondsBehind', {
            value: formatSubtitleOffset(offsetMs).replace('+', ''),
          });

  const statusLabel =
    status === 'loading'
      ? t('play.subtitlesLoading')
      : status === 'empty'
        ? t('play.subtitlesUnavailable')
        : status === 'error'
          ? t('play.subtitlesLoadFailed')
          : status === 'ready'
            ? t('play.subtitlesReady')
            : t('play.subtitlesIdle');

  const hasSubtitles = status === 'ready' && cues.length > 0;

  return (
    <>
      {activeCue ? (
        <div
          className={`pointer-events-none absolute inset-x-0 z-[420] flex justify-center px-4 ${
            isOverlay ? 'bottom-[6.5rem]' : 'bottom-[5.5rem] md:bottom-24'
          }`}
        >
          <span
            dir='auto'
            className='max-w-[min(92%,52rem)] whitespace-pre-line rounded-md bg-black/70 px-3 py-1.5 text-center text-[clamp(0.9rem,2.4vw,1.7rem)] font-semibold leading-snug text-white'
            style={{
              textShadow:
                '0 1px 3px rgba(0,0,0,0.95), 0 0 10px rgba(0,0,0,0.9)',
            }}
          >
            {activeCue.text}
          </span>
        </div>
      ) : null}

      <div
        className={`absolute z-[10000000] flex items-start gap-2 ${
          isOverlay ? 'left-3 top-14 flex-col' : 'left-3 top-3 flex-col'
        }`}
      >
        <button
          type='button'
          onClick={() => setPanelOpen((open) => !open)}
          aria-expanded={panelOpen}
          aria-label={t('play.subtitlesTitle')}
          title={t('play.subtitlesTitle')}
          className={`ui-glass-control inline-flex h-10 items-center gap-1.5 rounded-xl px-2.5 text-xs font-semibold ${
            hasSubtitles && enabled ? 'text-amber-300' : ''
          }`}
        >
          {status === 'loading' ? (
            <Loader2 className='h-4 w-4 animate-spin' />
          ) : hasSubtitles && enabled ? (
            <Captions className='h-4 w-4' />
          ) : (
            <CaptionsOff className='h-4 w-4' />
          )}
          <span className='hidden sm:inline'>CC</span>
        </button>

        {panelOpen ? (
          <div
            dir={uiDirection}
            role='region'
            aria-label={t('play.subtitlesTitle')}
            className='ui-glass-panel max-h-[70vh] w-[min(88vw,19rem)] overflow-y-auto p-4'
            style={{ borderRadius: 'var(--ui-radius-panel)' }}
          >
            <div className='flex items-start justify-between gap-3'>
              <div className='min-w-0'>
                <p className='ui-token-text-primary text-sm font-bold'>
                  {t('play.subtitlesTitle')}
                </p>
                <p className='ui-token-text-muted mt-0.5 flex items-center gap-1.5 text-[11px] leading-4'>
                  {status === 'loading' ? (
                    <Loader2 className='h-3 w-3 shrink-0 animate-spin' />
                  ) : hasSubtitles ? (
                    <Check className='h-3 w-3 shrink-0 text-emerald-400' />
                  ) : null}
                  {statusLabel}
                </p>
              </div>
              <button
                type='button'
                onClick={() => setPanelOpen(false)}
                aria-label={t('play.subtitlesClose')}
                title={t('play.subtitlesClose')}
                className='ui-glass-control inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-lg'
              >
                <X className='h-4 w-4' />
              </button>
            </div>

            {isOverlay && syncEstimated ? (
              <div className='mt-3 rounded-xl border border-amber-400/30 bg-amber-400/10 px-3 py-2'>
                <p className='text-[11px] leading-4 text-amber-200/90'>
                  {t('play.subtitlesEstimatedSync')}
                </p>
                {onSwitchToLuma ? (
                  <button
                    type='button'
                    onClick={() => {
                      setPanelOpen(false);
                      onSwitchToLuma();
                    }}
                    className='mt-2 w-full rounded-lg bg-amber-400 px-2 py-1.5 text-[11px] font-bold text-zinc-950'
                  >
                    {t('play.subtitlesUseLumaPlayer')}
                  </button>
                ) : null}
              </div>
            ) : null}

            {isOverlay && onAnchorTime ? (
              <div className='mt-3 rounded-xl border border-[var(--ui-glass-divider)] bg-white/[0.04] px-3 py-2'>
                <p className='ui-token-text-primary text-[11px] font-bold'>
                  {t('play.subtitlesAnchorTitle')}
                </p>
                <p className='ui-token-text-muted mt-1 text-[10px] leading-4'>
                  {t('play.subtitlesAnchorHint')}
                </p>
                <div className='mt-2 flex gap-1.5' dir='ltr'>
                  <input
                    type='text'
                    inputMode='numeric'
                    value={anchorValue}
                    onChange={(event) => setAnchorValue(event.target.value)}
                    onKeyDown={(event) => {
                      if (event.key === 'Enter') {
                        event.preventDefault();
                        applyAnchor();
                      }
                    }}
                    placeholder={t('play.subtitlesAnchorPlaceholder')}
                    aria-label={t('play.subtitlesAnchorTitle')}
                    className='ui-glass-control h-8 min-w-0 flex-1 rounded-lg px-2 text-xs font-semibold tabular-nums text-[var(--ui-token-text-primary)] outline-none'
                  />
                  <button
                    type='button'
                    onClick={applyAnchor}
                    className='rounded-lg bg-amber-400 px-2.5 py-1 text-[11px] font-bold text-zinc-950'
                  >
                    {t('play.subtitlesAnchorApply')}
                  </button>
                </div>
              </div>
            ) : null}

            <div className='mt-3 flex items-center justify-between gap-2'>
              <span className='ui-token-text-subtle text-[10px] font-semibold uppercase tracking-wider'>
                {t('play.subtitlesLanguage')}
              </span>
              <div className='flex gap-1'>
                <button
                  type='button'
                  onClick={() => setLanguage('ar')}
                  aria-pressed={language === 'ar'}
                  className={`rounded-lg px-2.5 py-1 text-xs font-semibold ${
                    language === 'ar'
                      ? 'bg-white text-zinc-950'
                      : 'ui-glass-control'
                  }`}
                >
                  العربية
                </button>
                <button
                  type='button'
                  onClick={() => setLanguage('en')}
                  aria-pressed={language === 'en'}
                  className={`rounded-lg px-2.5 py-1 text-xs font-semibold ${
                    language === 'en'
                      ? 'bg-white text-zinc-950'
                      : 'ui-glass-control'
                  }`}
                >
                  English
                </button>
              </div>
            </div>

            {hasSubtitles ? (
              <>
                <div className='mt-3 flex items-center justify-between gap-2 rounded-xl border border-[var(--ui-glass-divider)] bg-white/[0.04] px-3 py-2'>
                  <div className='min-w-0'>
                    <p className='ui-token-text-primary text-xs font-semibold'>
                      {enabled
                        ? t('play.subtitlesEnabled')
                        : t('play.subtitlesDisabled')}
                    </p>
                    <p
                      className='ui-token-text-subtle mt-0.5 truncate text-[10px]'
                      title={fileName}
                    >
                      {fileName || t('play.subtitlesUnknownFile')}
                    </p>
                  </div>
                  <button
                    type='button'
                    role='switch'
                    aria-checked={enabled}
                    onClick={() => setEnabled((value) => !value)}
                    className={`relative h-6 w-11 shrink-0 rounded-full transition-colors ${
                      enabled ? 'bg-emerald-400' : 'bg-white/20'
                    }`}
                  >
                    <span
                      className={`absolute top-0.5 h-5 w-5 rounded-full bg-white transition-all ${
                        enabled ? 'left-[1.375rem]' : 'left-0.5'
                      }`}
                    />
                  </button>
                </div>

                <div className='mt-4'>
                  <div className='flex items-center justify-between gap-2'>
                    <span className='ui-token-text-subtle text-[10px] font-semibold uppercase tracking-wider'>
                      {t('play.subtitlesOffset')}
                    </span>
                    <span
                      className='ui-token-text-primary text-xs font-bold tabular-nums'
                      dir='ltr'
                    >
                      {formatSubtitleOffset(offsetMs)}s
                    </span>
                  </div>
                  <p
                    className='ui-token-text-muted mt-1 text-[11px]'
                    dir='auto'
                  >
                    {offsetLabel}
                  </p>

                  <input
                    type='range'
                    min={-10000}
                    max={10000}
                    step={100}
                    value={offsetMs}
                    dir='ltr'
                    onChange={(event) =>
                      setOffsetMs(clampSubtitleOffset(Number(event.target.value)))
                    }
                    aria-label={t('play.subtitlesOffset')}
                    className='mt-2 w-full accent-amber-400'
                  />

                  <div className='mt-2 grid grid-cols-4 gap-1.5'>
                    {[
                      { delta: -1000, label: '-1s' },
                      { delta: -500, label: '-0.5s' },
                      { delta: 500, label: '+0.5s' },
                      { delta: 1000, label: '+1s' },
                    ].map(({ delta, label }) => (
                      <button
                        key={delta}
                        type='button'
                        onClick={() => nudge(delta)}
                        aria-label={t(
                          delta < 0
                            ? 'play.subtitlesEarlier'
                            : 'play.subtitlesLater',
                        )}
                        className='ui-glass-control rounded-lg px-1 py-1.5 text-[11px] font-semibold tabular-nums'
                        dir='ltr'
                      >
                        {label}
                      </button>
                    ))}
                  </div>

                  <div className='mt-2 flex gap-1.5'>
                    <button
                      type='button'
                      onClick={() => {
                        setOffsetMs(0);
                        setScale(1);
                        setNotice(null);
                      }}
                      className='ui-glass-control inline-flex w-full items-center justify-center gap-1.5 rounded-lg px-2 py-1.5 text-[11px] font-semibold'
                    >
                      <RotateCcw className='h-3 w-3' />
                      {t('play.subtitlesReset')}
                    </button>
                  </div>

                  <div className='mt-3'>
                    <div className='flex items-center justify-between gap-2'>
                      <span className='ui-token-text-subtle text-[10px] font-semibold uppercase tracking-wider'>
                        {t('play.subtitlesDrift')}
                      </span>
                      <span
                        className='ui-token-text-primary text-xs font-bold tabular-nums'
                        dir='ltr'
                      >
                        ×{scale.toFixed(3)}
                      </span>
                    </div>
                    <div className='mt-1.5 space-y-1.5'>
                      <button
                        type='button'
                        onClick={() => handleDrift(1.04271)}
                        className='ui-glass-control w-full rounded-lg px-2 py-1.5 text-[11px] font-semibold'
                        dir='ltr'
                      >
                        {t('play.subtitlesDriftStretch')}
                      </button>
                      <button
                        type='button'
                        onClick={() => handleDrift(0.95904)}
                        className='ui-glass-control w-full rounded-lg px-2 py-1.5 text-[11px] font-semibold'
                        dir='ltr'
                      >
                        {t('play.subtitlesDriftShrink')}
                      </button>
                    </div>
                    <p className='ui-token-text-subtle mt-1.5 text-[10px] leading-4'>
                      {t('play.subtitlesDriftHint', {
                        fps: sourceFps ? sourceFps.toFixed(2) : '—',
                      })}
                    </p>
                  </div>
                </div>

                <p className='ui-token-text-subtle mt-3 text-[10px] leading-4'>
                  {t('play.subtitlesKeyboardHint')}
                </p>
              </>
            ) : status === 'loading' ? (
              <p className='ui-token-text-muted mt-4 text-xs leading-5'>
                {t('play.subtitlesLoadingHint')}
              </p>
            ) : (
              <div className='mt-4 space-y-2'>
                <p className='ui-token-text-muted text-xs leading-5'>
                  {status === 'empty'
                    ? t('play.subtitlesUnavailable')
                    : t('play.subtitlesLoadFailed')}
                </p>
                <button
                  type='button'
                  onClick={() => setReloadKey((value) => value + 1)}
                  className='ui-glass-control w-full rounded-lg px-3 py-2 text-xs font-semibold'
                >
                  {t('play.retry')}
                </button>
              </div>
            )}

            <div className='mt-3'>
              <input
                ref={fileInputRef}
                type='file'
                accept='.srt,.vtt,.txt,text/vtt,application/x-subrip'
                className='hidden'
                onChange={(event) => {
                  const file = event.target.files?.[0];
                  event.target.value = '';
                  void handleFile(file);
                }}
              />
              <button
                type='button'
                onClick={() => fileInputRef.current?.click()}
                className='ui-glass-control inline-flex w-full items-center justify-center gap-1.5 rounded-lg px-3 py-2 text-xs font-semibold'
              >
                <Upload className='h-3.5 w-3.5' />
                {t('play.subtitlesLoadFile')}
              </button>
            </div>

            {notice ? (
              <p
                role='status'
                className='ui-token-text-muted mt-2 text-[11px] leading-4'
              >
                {notice}
              </p>
            ) : null}
          </div>
        ) : null}
      </div>
    </>
  );
}
