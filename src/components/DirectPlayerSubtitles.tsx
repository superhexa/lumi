'use client';

import {
  Captions,
  CaptionsOff,
  Check,
  FileText,
  Gauge,
  Languages,
  Loader2,
  RotateCcw,
  Search,
  Sparkles,
  Timer,
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
  resolveSubtitleLanguage,
  SUBTITLE_LANGUAGES,
} from '@/lib/subtitles';

interface SubtitlesResponse {
  ok?: boolean;
  cues?: SubtitleCue[];
  meta?: {
    fileName?: string;
    source?: string;
    cueCount?: number;
    fps?: number;
  };
}

interface SubtitleMeta {
  fileName: string;
  source: string;
  cueCount: number;
  fps?: number;
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
  /**
   * Only begin resolving subtitles once the player has actually loaded. This
   * keeps slow networks from fetching subtitle catalogs while the page is
   * still loading.
   */
  playerReady?: boolean;
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
const CUE_CACHE_PREFIX = 'luma:subtitle-cues:v2';
const CUE_CACHE_TTL_MS = 6 * 60 * 60 * 1000;
const MAX_SUBTITLE_FILE_BYTES = 8 * 1024 * 1024;

interface CachedCues {
  at: number;
  cues: SubtitleCue[];
  meta: SubtitleMeta;
}

function timingStorageKey(
  mediaType: 'movie' | 'tv',
  tmdbId: string,
  season: number,
  episode: number,
  language: SubtitleLanguage,
): string {
  return `${SYNC_STORAGE_PREFIX}:${mediaType}:${tmdbId}:${season}:${episode}:${language}`;
}

function cueCacheKey(
  mediaType: 'movie' | 'tv',
  tmdbId: string,
  season: number,
  episode: number,
  language: SubtitleLanguage,
): string {
  return `${CUE_CACHE_PREFIX}:${mediaType}:${tmdbId}:${season}:${episode}:${language}`;
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

function sanitizeCues(input: unknown): SubtitleCue[] {
  if (!Array.isArray(input)) return [];
  return input.filter(
    (cue): cue is SubtitleCue =>
      Boolean(cue) &&
      Number.isFinite(cue.start) &&
      Number.isFinite(cue.end) &&
      cue.end > cue.start &&
      typeof cue.text === 'string' &&
      cue.text.trim().length > 0,
  );
}

function readCachedCues(key: string): CachedCues | null {
  if (typeof window === 'undefined') return null;
  try {
    const raw = window.sessionStorage.getItem(key);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as CachedCues;
    if (!parsed || Date.now() - parsed.at > CUE_CACHE_TTL_MS) return null;
    const cues = sanitizeCues(parsed.cues);
    if (cues.length === 0) return null;
    return {
      at: parsed.at,
      cues,
      meta: {
        fileName: parsed.meta?.fileName || '',
        source: parsed.meta?.source || '',
        cueCount: cues.length,
        fps: parsed.meta?.fps,
      },
    };
  } catch {
    return null;
  }
}

function writeCachedCues(key: string, cues: SubtitleCue[], meta: SubtitleMeta) {
  if (typeof window === 'undefined') return;
  try {
    window.sessionStorage.setItem(
      key,
      JSON.stringify({ at: Date.now(), cues, meta } satisfies CachedCues),
    );
  } catch {
    // Quota can be tight in private mode; the network path still works.
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

function sourceLabel(source?: string): string {
  if (source === 'opensubtitles') return 'OpenSubtitles';
  if (source === 'stremio') return 'Stremio';
  if (source === 'yifysubtitles') return 'YIFY';
  return '';
}

/**
 * Luma's own subtitle layer for the direct player and iframe overlays.
 *
 * Because the player renders the cues, timing can be corrected live: delay
 * buttons shift every cue, the slider gives fine control, and the optional
 * length fit stretches drifting tracks. Corrections are saved per
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
  playerReady = true,
  onSwitchToLuma,
  onAnchorTime,
}: DirectPlayerSubtitlesProps) {
  const { t, i18n } = useTranslation();
  const isOverlay = variant === 'overlay';
  const uiDirection = i18n.language?.toLowerCase().startsWith('ar')
    ? 'rtl'
    : 'ltr';
  const [language, setLanguage] = useState<SubtitleLanguage>(preferredLanguage);
  const [languageQuery, setLanguageQuery] = useState('');
  const [panelOpen, setPanelOpen] = useState(false);
  const [status, setStatus] = useState<SubtitleStatus>('idle');
  const [enabled, setEnabled] = useState(readEnabledPreference);
  const [cues, setCues] = useState<SubtitleCue[]>([]);
  const [meta, setMeta] = useState<SubtitleMeta | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [offsetMs, setOffsetMs] = useState(0);
  const [scale, setScale] = useState(1);
  const [reloadKey, setReloadKey] = useState(0);
  const [anchorValue, setAnchorValue] = useState('');
  const fileInputRef = useRef<HTMLInputElement>(null);
  const selectedLanguageRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    setLanguage(preferredLanguage);
    setReloadKey(0);
  }, [preferredLanguage]);

  useEffect(() => {
    try {
      window.localStorage.setItem(ENABLED_STORAGE_KEY, enabled ? '1' : '0');
    } catch {
      // Ignore storage failures.
    }
  }, [enabled]);

  // Resolve subtitles only after the player is ready. Cached cues are applied
  // instantly, so a second visit starts with subtitles already in place.
  useEffect(() => {
    if (!playerReady) return;
    const controller = new AbortController();
    const cacheKey = cueCacheKey(mediaType, tmdbId, season, episode, language);

    if (reloadKey === 0) {
      const cached = readCachedCues(cacheKey);
      if (cached) {
        const stored = readStoredTiming(
          timingStorageKey(mediaType, tmdbId, season, episode, language),
        );
        setCues(cached.cues);
        setMeta(cached.meta);
        setOffsetMs(stored.offsetMs);
        setScale(stored.scale);
        setStatus('ready');
        setNotice(null);
        return () => controller.abort();
      }
    }

    setStatus('loading');
    setNotice(null);
    setCues([]);
    setMeta(null);

    const query = new URLSearchParams({
      tmdbId,
      type: mediaType,
      lang: language,
    });
    if (mediaType === 'tv') {
      query.set('season', String(season));
      query.set('episode', String(episode));
    }

    void (async () => {
      try {
        const response = await fetch(
          `/api/player/subtitles?${query.toString()}`,
          { cache: 'no-store', signal: controller.signal },
        );
        if (controller.signal.aborted) return;
        if (response.status === 404) {
          setStatus('empty');
          return;
        }
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const payload = (await response.json()) as SubtitlesResponse | null;
        if (controller.signal.aborted) return;
        const nextCues = sanitizeCues(payload?.cues);
        if (nextCues.length === 0) {
          setStatus('empty');
          return;
        }
        const nextMeta: SubtitleMeta = {
          fileName: payload?.meta?.fileName || '',
          source: payload?.meta?.source || '',
          cueCount: nextCues.length,
          fps:
            Number.isFinite(payload?.meta?.fps) && (payload?.meta?.fps || 0) > 0
              ? Number(payload?.meta?.fps)
              : undefined,
        };
        writeCachedCues(cacheKey, nextCues, nextMeta);
        const stored = readStoredTiming(
          timingStorageKey(mediaType, tmdbId, season, episode, language),
        );
        setCues(nextCues);
        setMeta(nextMeta);
        setOffsetMs(stored.offsetMs);
        setScale(stored.scale);
        setStatus('ready');
      } catch {
        if (!controller.signal.aborted) setStatus('error');
      }
    })();

    return () => controller.abort();
  }, [playerReady, tmdbId, mediaType, season, episode, language, reloadKey]);

  useEffect(() => {
    if (!playerReady) setStatus('idle');
  }, [playerReady]);

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

  const selectLanguage = useCallback((code: SubtitleLanguage) => {
    setLanguage(code);
    setReloadKey(0);
  }, []);

  useEffect(() => {
    if (!panelOpen) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        setPanelOpen(false);
        return;
      }
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

  useEffect(() => {
    if (!panelOpen || typeof document === 'undefined') return;
    const previous = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = previous;
    };
  }, [panelOpen]);

  useEffect(() => {
    if (!panelOpen) return;
    selectedLanguageRef.current?.scrollIntoView({ block: 'nearest' });
  }, [panelOpen, language]);

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
        setMeta({
          fileName: file.name,
          source: 'local',
          cueCount: parsed.length,
        });
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

  const filteredLanguages = useMemo(() => {
    const query = languageQuery.trim().toLowerCase();
    if (!query) return SUBTITLE_LANGUAGES;
    return SUBTITLE_LANGUAGES.filter(
      (entry) =>
        entry.label.toLowerCase().includes(query) ||
        entry.native.toLowerCase().includes(query) ||
        entry.code.toLowerCase().includes(query),
    );
  }, [languageQuery]);

  const languageInfo = resolveSubtitleLanguage(language);
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

  const statusLabel = !playerReady
    ? t('play.subtitlesWaitingForPlayback')
    : status === 'loading'
      ? t('play.subtitlesLoading')
      : status === 'empty'
        ? t('play.subtitlesUnavailableShort')
        : status === 'error'
          ? t('play.subtitlesLoadFailedShort')
          : status === 'ready'
            ? t('play.subtitlesReady')
            : t('play.subtitlesIdle');

  const hasSubtitles = status === 'ready' && cues.length > 0;
  const isLoading = status === 'loading' || (!playerReady && enabled);

  return (
    <>
      {activeCue ? (
        <div
          className={`pointer-events-none absolute inset-x-0 z-[420] flex justify-center px-4 ${
            isOverlay ? 'bottom-[6.5rem]' : 'bottom-[5.5rem] md:bottom-24'
          }`}
        >
          <span dir='auto' className='subtitle-cue-text'>
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
            hasSubtitles && enabled ? 'text-[var(--ui-accent)]' : ''
          }`}
        >
          {isLoading ? (
            <Loader2 className='h-4 w-4 animate-spin' />
          ) : hasSubtitles && enabled ? (
            <Captions className='h-4 w-4' />
          ) : (
            <CaptionsOff className='h-4 w-4' />
          )}
          <span className='hidden sm:inline'>CC</span>
          {hasSubtitles && enabled ? (
            <span className='hidden rounded-full bg-[var(--ui-accent)]/15 px-1.5 py-0.5 text-[9px] font-black uppercase tracking-wide text-[var(--ui-accent)] sm:inline'>
              {languageInfo.code}
            </span>
          ) : null}
        </button>

        {panelOpen ? (
          <div
            className='subtitle-sheet-backdrop'
            role='presentation'
            onMouseDown={(event) => {
              if (event.target === event.currentTarget) setPanelOpen(false);
            }}
          >
            <div
              dir={uiDirection}
              role='dialog'
              aria-modal='true'
              aria-label={t('play.subtitlesTitle')}
              className='subtitle-sheet'
              onMouseDown={(event) => event.stopPropagation()}
            >
              <div className='subtitle-sheet-dragger' />
              <div className='subtitle-sheet-header'>
                <div className='min-w-0'>
                  <p className='subtitle-sheet-eyebrow'>
                    {t('play.subtitlesEyebrow')}
                  </p>
                  <h3 className='subtitle-sheet-title'>
                    {t('play.subtitlesTitle')}
                  </h3>
                  <div className='mt-1.5 flex flex-wrap items-center gap-1.5'>
                    <span className='subtitle-status-pill' data-status={status}>
                      {status === 'loading' ? (
                        <Loader2 className='h-3 w-3 animate-spin' />
                      ) : status === 'ready' ? (
                        <Check className='h-3 w-3' />
                      ) : null}
                      {statusLabel}
                    </span>
                    {hasSubtitles ? (
                      <span className='subtitle-status-pill'>
                        {languageInfo.native}
                      </span>
                    ) : null}
                  </div>
                </div>
                <button
                  type='button'
                  onClick={() => setPanelOpen(false)}
                  aria-label={t('play.subtitlesClose')}
                  title={t('play.subtitlesClose')}
                  className='ui-glass-control inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-full'
                >
                  <X className='h-4 w-4' />
                </button>
              </div>

              <div className='subtitle-sheet-body'>
                {isOverlay && syncEstimated ? (
                  <div className='rounded-2xl border border-amber-300/25 bg-amber-300/10 px-3.5 py-2.5'>
                    <p className='text-[11px] leading-4 text-amber-100/90'>
                      {t('play.subtitlesEstimatedSync')}
                    </p>
                    {onSwitchToLuma ? (
                      <button
                        type='button'
                        onClick={() => {
                          setPanelOpen(false);
                          onSwitchToLuma();
                        }}
                        className='mt-2 inline-flex w-full items-center justify-center gap-1.5 rounded-xl bg-[var(--ui-accent)] px-3 py-2 text-[11px] font-black text-zinc-950 transition hover:brightness-105'
                      >
                        <Sparkles className='h-3.5 w-3.5' />
                        {t('play.subtitlesUseLumaPlayer')}
                      </button>
                    ) : null}
                  </div>
                ) : null}

                <section>
                  <div className='subtitle-section-label'>
                    <span className='inline-flex items-center gap-1.5'>
                      <Languages className='h-3.5 w-3.5' />
                      {t('play.subtitlesLanguage')}
                    </span>
                    <span className='normal-case tracking-normal text-[10px] font-semibold text-zinc-500'>
                      {t('play.subtitlesLanguageCount', {
                        total: SUBTITLE_LANGUAGES.length,
                      })}
                    </span>
                  </div>

                  <div className='subtitle-search mt-2'>
                    <Search className='h-3.5 w-3.5 shrink-0 text-zinc-500' />
                    <input
                      type='search'
                      value={languageQuery}
                      onChange={(event) => setLanguageQuery(event.target.value)}
                      placeholder={t('play.subtitlesSearchLanguage')}
                      aria-label={t('play.subtitlesSearchLanguage')}
                      autoComplete='off'
                    />
                    {languageQuery ? (
                      <button
                        type='button'
                        onClick={() => setLanguageQuery('')}
                        aria-label={t('play.subtitlesClearSearch')}
                        className='shrink-0 text-zinc-500 transition hover:text-white'
                      >
                        <X className='h-3.5 w-3.5' />
                      </button>
                    ) : null}
                  </div>

                  <div className='subtitle-language-grid mt-2'>
                    {filteredLanguages.map((entry) => {
                      const selected = entry.code === language;
                      return (
                        <button
                          key={entry.code}
                          ref={selected ? selectedLanguageRef : undefined}
                          type='button'
                          onClick={() => selectLanguage(entry.code)}
                          aria-pressed={selected}
                          dir={entry.rtl ? 'rtl' : 'ltr'}
                          className={`subtitle-language-option ${
                            selected ? 'is-active' : ''
                          }`}
                        >
                          <span className='subtitle-language-native'>
                            {entry.native}
                          </span>
                          <span className='subtitle-language-label'>
                            {entry.label}
                          </span>
                        </button>
                      );
                    })}
                    {filteredLanguages.length === 0 ? (
                      <p className='col-span-full py-3 text-center text-[11px] text-zinc-500'>
                        {t('play.subtitlesNoLanguageResults')}
                      </p>
                    ) : null}
                  </div>
                </section>

                {hasSubtitles ? (
                  <>
                    <div className='subtitle-card flex items-center justify-between gap-3'>
                      <div className='min-w-0'>
                        <p className='text-xs font-bold text-zinc-100'>
                          {enabled
                            ? t('play.subtitlesEnabled')
                            : t('play.subtitlesDisabled')}
                        </p>
                        <p
                          className='mt-0.5 truncate text-[10px] text-zinc-500'
                          title={meta?.fileName || ''}
                        >
                          {meta?.fileName || t('play.subtitlesUnknownFile')}
                        </p>
                        <div className='mt-1 flex flex-wrap items-center gap-1.5 text-[9px] font-bold uppercase tracking-wide text-zinc-500'>
                          {sourceLabel(meta?.source) ? (
                            <span className='rounded-full border border-white/10 bg-white/[0.05] px-1.5 py-0.5'>
                              {sourceLabel(meta?.source)}
                            </span>
                          ) : null}
                          <span className='inline-flex items-center gap-1'>
                            <FileText className='h-3 w-3' />
                            {t('play.subtitlesCueCount', {
                              total: meta?.cueCount ?? cues.length,
                            })}
                          </span>
                          {meta?.fps ? (
                            <span className='tabular-nums'>
                              {meta.fps.toFixed(2)} fps
                            </span>
                          ) : null}
                        </div>
                      </div>
                      <button
                        type='button'
                        role='switch'
                        aria-checked={enabled}
                        aria-label={t('play.subtitlesEnabled')}
                        onClick={() => setEnabled((value) => !value)}
                        className='subtitle-toggle'
                        data-on={enabled}
                      >
                        <span
                          className='subtitle-toggle-knob'
                          style={
                            enabled
                              ? { right: '0.125rem' }
                              : { left: '0.125rem' }
                          }
                        />
                      </button>
                    </div>

                    <section>
                      <div className='subtitle-section-label'>
                        <span className='inline-flex items-center gap-1.5'>
                          <Timer className='h-3.5 w-3.5' />
                          {t('play.subtitlesOffset')}
                        </span>
                        <span
                          className='text-[11px] font-bold tabular-nums text-zinc-200'
                          dir='ltr'
                        >
                          {formatSubtitleOffset(offsetMs)}s
                        </span>
                      </div>
                      <p className='mt-1 text-[11px] text-zinc-400' dir='auto'>
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
                          setOffsetMs(
                            clampSubtitleOffset(Number(event.target.value)),
                          )
                        }
                        aria-label={t('play.subtitlesOffset')}
                        className='subtitle-range mt-1'
                      />

                      <div className='mt-1.5 grid grid-cols-3 gap-1.5 sm:grid-cols-6'>
                        {[
                          { delta: -5000, label: '-5s' },
                          { delta: -1000, label: '-1s' },
                          { delta: -500, label: '-0.5s' },
                          { delta: 500, label: '+0.5s' },
                          { delta: 1000, label: '+1s' },
                          { delta: 5000, label: '+5s' },
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
                            className='ui-glass-control rounded-xl px-1 py-1.5 text-[11px] font-bold tabular-nums'
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
                          className='ui-glass-control inline-flex w-full items-center justify-center gap-1.5 rounded-xl px-2 py-1.5 text-[11px] font-bold'
                        >
                          <RotateCcw className='h-3 w-3' />
                          {t('play.subtitlesReset')}
                        </button>
                      </div>

                      <div className='subtitle-card mt-2.5'>
                        <div className='flex items-center justify-between gap-2'>
                          <span className='inline-flex items-center gap-1.5 text-[10px] font-bold uppercase tracking-wider text-zinc-500'>
                            <Gauge className='h-3.5 w-3.5' />
                            {t('play.subtitlesDrift')}
                          </span>
                          <span
                            className='text-[11px] font-bold tabular-nums text-zinc-200'
                            dir='ltr'
                          >
                            ×{scale.toFixed(3)}
                          </span>
                        </div>
                        <div className='mt-2 grid grid-cols-2 gap-1.5'>
                          <button
                            type='button'
                            onClick={() => handleDrift(1.04271)}
                            className='ui-glass-control rounded-xl px-2 py-1.5 text-[10px] font-bold'
                            dir='ltr'
                          >
                            {t('play.subtitlesDriftStretch')}
                          </button>
                          <button
                            type='button'
                            onClick={() => handleDrift(0.95904)}
                            className='ui-glass-control rounded-xl px-2 py-1.5 text-[10px] font-bold'
                            dir='ltr'
                          >
                            {t('play.subtitlesDriftShrink')}
                          </button>
                        </div>
                        <p className='mt-1.5 text-[10px] leading-4 text-zinc-500'>
                          {t('play.subtitlesDriftHint', {
                            fps: meta?.fps ? meta.fps.toFixed(2) : '—',
                          })}
                        </p>
                      </div>
                    </section>
                  </>
                ) : isLoading ? (
                  <div className='subtitle-card space-y-2'>
                    <div className='subtitle-skeleton h-3 w-1/2' />
                    <div className='subtitle-skeleton h-3 w-4/5' />
                    <div className='subtitle-skeleton h-3 w-2/3' />
                    <p className='pt-1 text-[11px] leading-5 text-zinc-400'>
                      {playerReady
                        ? t('play.subtitlesLoadingHint')
                        : t('play.subtitlesWaitingHint')}
                    </p>
                  </div>
                ) : (
                  <div className='subtitle-card space-y-2'>
                    <p className='text-[11px] leading-5 text-zinc-400'>
                      {status === 'empty'
                        ? t('play.subtitlesUnavailable')
                        : status === 'error'
                          ? t('play.subtitlesLoadFailed')
                          : t('play.subtitlesWaitingHint')}
                    </p>
                    {playerReady ? (
                      <button
                        type='button'
                        onClick={() => setReloadKey((value) => value + 1)}
                        className='ui-glass-control w-full rounded-xl px-3 py-2 text-xs font-bold'
                      >
                        {t('play.retry')}
                      </button>
                    ) : null}
                  </div>
                )}

                {isOverlay && onAnchorTime ? (
                  <div className='subtitle-card'>
                    <p className='text-[11px] font-bold text-zinc-100'>
                      {t('play.subtitlesAnchorTitle')}
                    </p>
                    <p className='mt-1 text-[10px] leading-4 text-zinc-500'>
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
                        className='ui-glass-control h-9 min-w-0 flex-1 rounded-xl px-2.5 text-xs font-bold tabular-nums text-white outline-none'
                      />
                      <button
                        type='button'
                        onClick={applyAnchor}
                        className='rounded-xl bg-[var(--ui-accent)] px-3 py-1 text-[11px] font-black text-zinc-950'
                      >
                        {t('play.subtitlesAnchorApply')}
                      </button>
                    </div>
                  </div>
                ) : null}

                <div>
                  <input
                    ref={fileInputRef}
                    type='file'
                    accept='.srt,.vtt,.ass,.ssa,.txt,text/vtt,application/x-subrip'
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
                    className='ui-glass-control inline-flex w-full items-center justify-center gap-1.5 rounded-xl px-3 py-2 text-xs font-bold'
                  >
                    <Upload className='h-3.5 w-3.5' />
                    {t('play.subtitlesLoadFile')}
                  </button>
                </div>

                {notice ? (
                  <p
                    role='status'
                    className='text-[11px] leading-4 text-zinc-400'
                  >
                    {notice}
                  </p>
                ) : null}

                {hasSubtitles ? (
                  <p className='text-[10px] leading-4 text-zinc-500'>
                    {t('play.subtitlesKeyboardHint')}
                  </p>
                ) : null}
              </div>
            </div>
          </div>
        ) : null}
      </div>
    </>
  );
}
