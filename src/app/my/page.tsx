'use client';

import {
  Bookmark,
  Clock3,
  Download,
  Grid2X2,
  Grid3X3,
  Heart,
  History,
  ListFilter,
  Play,
  Search,
  Shuffle,
  Trash2,
  Upload,
  X,
} from 'lucide-react';
import { useRouter } from 'next/navigation';
import {
  type ChangeEvent,
  Suspense,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { useTranslation } from 'react-i18next';

import type { Favorite, PlayRecord } from '@/lib/db.client';
import {
  deleteFavorite,
  deletePlayRecord,
  getAllFavorites,
  getAllPlayRecords,
  saveFavorite,
  savePlayRecord,
  subscribeToDataUpdates,
} from '@/lib/db.client';
import { createLibraryBackup, parseLibraryBackup } from '@/lib/library-backup';
import { normalizeSearchText } from '@/lib/search-normalize';
import { buildTmdbHistoryPlayUrl, parseStorageKey } from '@/lib/tmdb-history';

import PageLayout from '@/components/PageLayout';

interface HistoryItem extends PlayRecord {
  key: string;
}
interface FavoriteItem {
  key: string;
  source: string;
  id: string;
  title: string;
  poster: string;
  year: string;
  episodes: number;
  sourceName: string;
  currentEpisode?: number;
  searchTitle?: string;
}

type LibraryTab = 'continue' | 'favorites' | 'history';
type SortMode = 'latest' | 'title';

function getProgress(record: PlayRecord) {
  if (!record.total_time) return 0;
  return Math.min(
    100,
    Math.max(0, (record.play_time / record.total_time) * 100),
  );
}

function favoriteUrl(item: FavoriteItem) {
  const params = new URLSearchParams({
    title: item.title || item.searchTitle || 'Unknown title',
  });
  if (item.source && item.id) {
    params.set('source', item.source);
    params.set('id', item.id);
  }
  if (item.searchTitle) params.set('stitle', item.searchTitle);
  if (item.year) params.set('year', item.year);
  if (item.episodes > 1) params.set('stype', 'tv');
  return `/play?${params.toString()}`;
}

function LibraryClient() {
  const { t } = useTranslation();
  const router = useRouter();
  const [tab, setTab] = useState<LibraryTab>('continue');
  const [history, setHistory] = useState<HistoryItem[]>([]);
  const [favorites, setFavorites] = useState<FavoriteItem[]>([]);
  const [query, setQuery] = useState('');
  const [sort, setSort] = useState<SortMode>('latest');
  const [format, setFormat] = useState<'all' | 'movie' | 'tv'>('all');
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [compact, setCompact] = useState(false);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [feedback, setFeedback] = useState('');
  const [deleteKeys, setDeleteKeys] = useState<Set<string>>(new Set());
  const [deleteKind, setDeleteKind] = useState<'history' | 'favorites' | null>(
    null,
  );
  const fileRef = useRef<HTMLInputElement>(null);

  const updateHistory = useCallback((records: Record<string, PlayRecord>) => {
    setHistory(
      Object.entries(records)
        .map(([key, record]) => ({ ...record, key }))
        .sort((a, b) => b.save_time - a.save_time),
    );
  }, []);

  const updateFavorites = useCallback(
    async (items: Record<string, Favorite>) => {
      const records = await getAllPlayRecords();
      setFavorites(
        Object.entries(items)
          .sort(([, a], [, b]) => b.save_time - a.save_time)
          .map(([key, item]) => {
            const { source, id } = parseStorageKey(key);
            return {
              key,
              source,
              id,
              title: item.title,
              poster: item.cover,
              year: item.year,
              episodes: item.total_episodes,
              sourceName: item.source_name,
              currentEpisode: records[key]?.index,
              searchTitle: item.search_title,
            };
          }),
      );
    },
    [],
  );

  useEffect(() => {
    let mounted = true;
    void Promise.all([getAllPlayRecords(), getAllFavorites()]).then(
      ([records, items]) => {
        if (!mounted) return;
        updateHistory(records);
        void updateFavorites(items).finally(() => setLoading(false));
      },
    );
    const unsubscribeHistory = subscribeToDataUpdates(
      'playRecordsUpdated',
      updateHistory,
    );
    const unsubscribeFavorites = subscribeToDataUpdates(
      'favoritesUpdated',
      (items: Record<string, Favorite>) => {
        void updateFavorites(items);
      },
    );
    return () => {
      mounted = false;
      unsubscribeHistory();
      unsubscribeFavorites();
    };
  }, [updateFavorites, updateHistory]);

  const continueItems = useMemo(
    () =>
      history.filter((item) => item.play_time > 0 && getProgress(item) < 90),
    [history],
  );
  const completedCount = useMemo(
    () => history.filter((item) => getProgress(item) >= 90).length,
    [history],
  );
  const normalizedQuery = normalizeSearchText(query);

  const visibleHistory = useMemo(() => {
    let items = history.filter((item) => {
      if (format === 'movie' && item.total_episodes > 1) return false;
      if (format === 'tv' && item.total_episodes <= 1) return false;
      if (!normalizedQuery) return true;
      return normalizeSearchText(
        `${item.title} ${item.search_title || ''} ${item.year} ${item.source_name}`,
      ).includes(normalizedQuery);
    });
    if (sort === 'title')
      items = [...items].sort((a, b) => a.title.localeCompare(b.title));
    return items;
  }, [format, history, normalizedQuery, sort]);

  const visibleFavorites = useMemo(() => {
    let items = favorites.filter((item) => {
      if (format === 'movie' && item.episodes > 1) return false;
      if (format === 'tv' && item.episodes <= 1) return false;
      if (!normalizedQuery) return true;
      return normalizeSearchText(
        `${item.title} ${item.searchTitle || ''} ${item.year} ${item.sourceName}`,
      ).includes(normalizedQuery);
    });
    if (sort === 'title')
      items = [...items].sort((a, b) => a.title.localeCompare(b.title));
    return items;
  }, [favorites, format, normalizedQuery, sort]);

  const visibleContinue = useMemo(
    () =>
      continueItems.filter(
        (item) =>
          !normalizedQuery ||
          normalizeSearchText(
            `${item.title} ${item.search_title || ''} ${item.year}`,
          ).includes(normalizedQuery),
      ),
    [continueItems, normalizedQuery],
  );
  const randomPlay = useCallback(() => {
    const pool =
      tab === 'favorites'
        ? visibleFavorites.map((item) => favoriteUrl(item))
        : visibleHistory.map((item) => buildTmdbHistoryPlayUrl(item.key, item));
    if (pool.length) router.push(pool[Math.floor(Math.random() * pool.length)]);
  }, [router, tab, visibleFavorites, visibleHistory]);

  const exportLibrary = useCallback(async () => {
    setBusy(true);
    try {
      const [favoriteData, historyData] = await Promise.all([
        getAllFavorites(),
        getAllPlayRecords(),
      ]);
      const blob = new Blob(
        [
          JSON.stringify(
            createLibraryBackup(favoriteData, historyData),
            null,
            2,
          ),
        ],
        { type: 'application/json' },
      );
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = `lumi-library-${new Date().toISOString().slice(0, 10)}.json`;
      link.click();
      URL.revokeObjectURL(url);
      setFeedback(t('my.backupExported'));
    } catch {
      setFeedback(t('my.backupFailed'));
    } finally {
      setBusy(false);
    }
  }, [t]);

  const importLibrary = useCallback(
    async (event: ChangeEvent<HTMLInputElement>) => {
      const file = event.target.files?.[0];
      event.target.value = '';
      if (!file || file.size > 5 * 1024 * 1024) {
        setFeedback(t('my.backupInvalid'));
        return;
      }
      setBusy(true);
      try {
        const backup = parseLibraryBackup(JSON.parse(await file.text()));
        if (!backup) throw new Error('Invalid backup');
        let count = 0;
        for (const [key, item] of Object.entries(backup.favorites)) {
          const { source, id } = parseStorageKey(key);
          if (source && id) {
            await saveFavorite(source, id, item);
            count++;
          }
        }
        for (const [key, item] of Object.entries(backup.playRecords)) {
          const { source, id } = parseStorageKey(key);
          if (source && id) {
            await savePlayRecord(source, id, item);
            count++;
          }
        }
        setFeedback(t('my.backupImported', { count }));
      } catch {
        setFeedback(t('my.backupFailed'));
      } finally {
        setBusy(false);
      }
    },
    [t],
  );

  const confirmDelete = async () => {
    if (!deleteKind) return;
    setBusy(true);
    try {
      if (deleteKind === 'history') {
        await Promise.all(
          history
            .filter((item) => deleteKeys.has(item.key))
            .map((item) => {
              const { source, id } = parseStorageKey(item.key);
              return deletePlayRecord(source, id);
            }),
        );
      } else {
        await Promise.all(
          favorites
            .filter((item) => deleteKeys.has(item.key))
            .map((item) => deleteFavorite(item.source, item.id)),
        );
      }
      setDeleteKeys(new Set());
      setDeleteKind(null);
    } finally {
      setBusy(false);
    }
  };

  const toggleDelete = (kind: 'history' | 'favorites', key: string) => {
    setDeleteKind(kind);
    setDeleteKeys((current) => {
      const next = new Set(current);
      next.has(key) ? next.delete(key) : next.add(key);
      return next;
    });
  };

  const cards =
    tab === 'favorites'
      ? visibleFavorites.map((item) => (
          <article key={item.key} className='group min-w-0'>
            <button
              type='button'
              onClick={() => router.push(favoriteUrl(item))}
              className='relative block aspect-[2/3] w-full overflow-hidden rounded-[18px] border border-white/[0.08] bg-[#0a0a0a] text-start shadow-[0_14px_35px_rgba(0,0,0,.42)] transition duration-300 hover:-translate-y-1 hover:border-white/25 hover:shadow-[0_18px_45px_rgba(255,255,255,.07)]'
            >
              {item.poster ? (
                <img
                  src={item.poster}
                  alt={item.title}
                  className='h-full w-full object-cover'
                />
              ) : (
                <span className='grid h-full place-items-center text-zinc-600'>
                  <Heart className='h-8 w-8' />
                </span>
              )}
              <span className='absolute inset-x-0 bottom-0 h-2/5 bg-gradient-to-t from-black to-transparent' />
              {item.currentEpisode ? (
                <span className='absolute bottom-3 start-3 rounded-full bg-black/75 px-2.5 py-1 text-[11px] font-bold text-amber-50 backdrop-blur-md'>
                  {t('player.episode', {
                    season: 1,
                    episode: item.currentEpisode,
                  })}
                </span>
              ) : null}
            </button>
            <div className='mt-2 flex items-start gap-1'>
              <button
                type='button'
                onClick={() => router.push(favoriteUrl(item))}
                className='min-w-0 flex-1 text-start'
              >
                <span className='block truncate text-sm font-bold text-white'>
                  {item.title}
                </span>
                <span className='mt-0.5 block text-xs text-zinc-500'>
                  {item.year || item.sourceName}
                </span>
              </button>
              <button
                type='button'
                onClick={() => toggleDelete('favorites', item.key)}
                aria-label={t('common.delete')}
                className='grid h-8 w-8 shrink-0 place-items-center rounded-full text-zinc-600 transition hover:bg-red-500/10 hover:text-red-300'
              >
                <Trash2 className='h-4 w-4' />
              </button>
            </div>
          </article>
        ))
      : visibleHistory.map((item) => (
          <article key={item.key} className='group min-w-0'>
            <button
              type='button'
              onClick={() =>
                router.push(buildTmdbHistoryPlayUrl(item.key, item))
              }
              className='relative block aspect-[2/3] w-full overflow-hidden rounded-[18px] border border-white/[0.08] bg-[#0a0a0a] text-start shadow-[0_14px_35px_rgba(0,0,0,.42)] transition duration-300 hover:-translate-y-1 hover:border-white/25'
            >
              {item.cover ? (
                <img
                  src={item.cover}
                  alt={item.title}
                  className='h-full w-full object-cover'
                />
              ) : (
                <span className='grid h-full place-items-center text-zinc-600'>
                  <Play className='h-8 w-8' />
                </span>
              )}
              <span className='absolute inset-x-0 bottom-0 h-2/5 bg-gradient-to-t from-black to-transparent' />
              <span className='absolute bottom-3 start-3 end-3 h-1 overflow-hidden rounded-full bg-white/15'>
                <span
                  className='block h-full rounded-full bg-[var(--ui-accent)]'
                  style={{ width: `${getProgress(item)}%` }}
                />
              </span>
            </button>
            <div className='mt-2 flex items-start gap-1'>
              <button
                type='button'
                onClick={() =>
                  router.push(buildTmdbHistoryPlayUrl(item.key, item))
                }
                className='min-w-0 flex-1 text-start'
              >
                <span className='block truncate text-sm font-bold text-white'>
                  {item.title}
                </span>
                <span className='mt-0.5 block text-xs text-zinc-500'>
                  {Math.round(getProgress(item))}% ·{' '}
                  {item.year || item.source_name}
                </span>
              </button>
              <button
                type='button'
                onClick={() => toggleDelete('history', item.key)}
                aria-label={t('common.delete')}
                className='grid h-8 w-8 shrink-0 place-items-center rounded-full text-zinc-600 transition hover:bg-red-500/10 hover:text-red-300'
              >
                <Trash2 className='h-4 w-4' />
              </button>
            </div>
          </article>
        ));

  return (
    <PageLayout activePath='/my'>
      <div className='min-h-screen bg-black px-4 pb-28 pt-[calc(env(safe-area-inset-top)+5rem)] sm:px-8 sm:pt-8 md:px-10 md:pb-12 md:pt-6'>
        <div className='mx-auto max-w-[1500px]'>
          <header className='mb-7 flex items-end justify-between gap-4'>
            <div>
              <p className='mb-2 text-[11px] font-black uppercase tracking-[0.22em] text-[var(--ui-accent)]'>
                {t('my.personalCinema')}
              </p>
              <h1 className='text-3xl font-black tracking-tight text-white sm:text-5xl'>
                {t('my.libraryTitle')}
              </h1>
            </div>
            <button
              type='button'
              onClick={randomPlay}
              disabled={
                tab === 'favorites'
                  ? !visibleFavorites.length
                  : !visibleHistory.length
              }
              className='grid h-12 w-12 shrink-0 place-items-center rounded-full bg-[var(--ui-accent)] text-zinc-950 shadow-[0_12px_35px_rgba(239,226,196,.22)] transition active:scale-95 disabled:opacity-40 sm:h-14 sm:w-14'
              aria-label={t('my.shufflePlay')}
            >
              <Shuffle className='h-5 w-5' />
            </button>
          </header>

          <section className='mb-5 grid grid-cols-3 gap-2 sm:max-w-xl sm:gap-3'>
            {[
              {
                label: t('my.continuing'),
                value: continueItems.length,
                icon: Clock3,
              },
              {
                label: t('my.savedTitles'),
                value: favorites.length,
                icon: Bookmark,
              },
              { label: t('my.completed'), value: completedCount, icon: Play },
            ].map((stat) => (
              <div
                key={stat.label}
                className='rounded-2xl border border-white/[0.07] bg-[#090909] p-3 sm:p-4'
              >
                <stat.icon className='mb-2 h-4 w-4 text-[var(--ui-accent)]' />
                <p className='text-xl font-black text-white sm:text-2xl'>
                  {stat.value}
                </p>
                <p className='mt-0.5 truncate text-[11px] font-semibold text-zinc-500 sm:text-xs'>
                  {stat.label}
                </p>
              </div>
            ))}
          </section>

          {continueItems.length > 0 ? (
            <section className='mb-7'>
              <div className='mb-3 flex items-center justify-between'>
                <h2 className='text-lg font-black text-white'>
                  {t('my.pickUpWhereLeftOff')}
                </h2>
                <button
                  type='button'
                  onClick={() => setTab('history')}
                  className='text-xs font-bold text-[var(--ui-accent)]'
                >
                  {t('common.viewAll')}
                </button>
              </div>
              <div className='scrollbar-hide flex gap-3 overflow-x-auto pb-2'>
                {continueItems.slice(0, 12).map((item) => (
                  <button
                    key={item.key}
                    type='button'
                    onClick={() =>
                      router.push(buildTmdbHistoryPlayUrl(item.key, item))
                    }
                    className='relative aspect-[16/10] w-[230px] shrink-0 overflow-hidden rounded-2xl border border-white/[0.08] bg-[#090909] text-start sm:w-[300px]'
                  >
                    {item.cover ? (
                      <img
                        src={item.cover}
                        alt={item.title}
                        className='h-full w-full object-cover'
                      />
                    ) : (
                      <span className='grid h-full place-items-center text-zinc-600'>
                        <Play />
                      </span>
                    )}
                    <span className='absolute inset-x-0 bottom-0 bg-gradient-to-t from-black px-4 pb-3 pt-10'>
                      <span className='block truncate text-sm font-bold text-white'>
                        {item.title}
                      </span>
                      <span className='mt-2 block h-1 overflow-hidden rounded-full bg-white/15'>
                        <span
                          className='block h-full rounded-full bg-[var(--ui-accent)]'
                          style={{ width: `${getProgress(item)}%` }}
                        />
                      </span>
                    </span>
                  </button>
                ))}
              </div>
            </section>
          ) : null}

          <div className='relative mb-4 flex items-center gap-2 rounded-[20px] border border-white/[0.07] bg-[#090909] p-2'>
            <div className='relative min-w-0 flex-1'>
              <Search className='pointer-events-none absolute start-3 top-1/2 h-4 w-4 -translate-y-1/2 text-zinc-500' />
              <input
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder={t('my.searchLibrary')}
                aria-label={t('my.searchLibrary')}
                className='h-12 w-full rounded-xl border-0 bg-white/[0.045] ps-10 pe-10 text-sm text-white outline-none placeholder:text-zinc-600 focus:bg-white/[0.07] focus:ring-1 focus:ring-white/20'
              />
              {query ? (
                <button
                  type='button'
                  onClick={() => setQuery('')}
                  className='absolute end-2 top-1/2 grid h-8 w-8 -translate-y-1/2 place-items-center rounded-full text-zinc-500 hover:text-white'
                >
                  <X className='h-4 w-4' />
                </button>
              ) : null}
            </div>
            <button
              type='button'
              onClick={() => setFiltersOpen((open) => !open)}
              aria-expanded={filtersOpen}
              className={`grid h-12 w-12 shrink-0 place-items-center rounded-xl border transition ${filtersOpen ? 'border-white/30 bg-white/15 text-[var(--ui-accent)]' : 'border-white/[0.07] bg-white/[0.04] text-zinc-300'}`}
            >
              <ListFilter className='h-5 w-5' />
            </button>
          </div>

          {filtersOpen ? (
            <div className='mb-4 w-full rounded-[20px] border border-white/[0.08] bg-[#090909] p-3 shadow-[0_18px_45px_rgba(0,0,0,.55)]'>
              <div className='flex flex-wrap items-center gap-2'>
                {(['all', 'movie', 'tv'] as const).map((value) => (
                  <button
                    key={value}
                    type='button'
                    onClick={() => setFormat(value)}
                    className={`h-10 rounded-full px-4 text-xs font-bold ${format === value ? 'bg-[var(--ui-accent)] text-zinc-950' : 'border border-white/[0.07] bg-white/[0.04] text-zinc-300'}`}
                  >
                    {t(
                      value === 'all'
                        ? 'my.allActivity'
                        : value === 'movie'
                          ? 'my.formatMovie'
                          : 'my.formatTv',
                    )}
                  </button>
                ))}
                <button
                  type='button'
                  onClick={() =>
                    setSort((value) =>
                      value === 'latest' ? 'title' : 'latest',
                    )
                  }
                  className='h-10 rounded-full border border-white/[0.07] bg-white/[0.04] px-4 text-xs font-bold text-zinc-300'
                >
                  {sort === 'latest' ? t('my.latest') : t('my.title')}
                </button>
                <button
                  type='button'
                  onClick={() => setCompact((value) => !value)}
                  className='grid h-10 w-10 place-items-center rounded-full border border-white/[0.07] bg-white/[0.04] text-zinc-300'
                >
                  {compact ? (
                    <Grid2X2 className='h-4 w-4' />
                  ) : (
                    <Grid3X3 className='h-4 w-4' />
                  )}
                </button>
                <button
                  type='button'
                  onClick={() => void exportLibrary()}
                  disabled={busy}
                  className='ms-auto grid h-10 w-10 place-items-center rounded-full border border-white/[0.07] text-zinc-300'
                  aria-label={t('my.exportBackup')}
                >
                  <Download className='h-4 w-4' />
                </button>
                <button
                  type='button'
                  onClick={() => fileRef.current?.click()}
                  disabled={busy}
                  className='grid h-10 w-10 place-items-center rounded-full border border-white/[0.07] text-zinc-300'
                  aria-label={t('my.importBackup')}
                >
                  <Upload className='h-4 w-4' />
                </button>
                <input
                  ref={fileRef}
                  type='file'
                  accept='application/json,.json'
                  className='hidden'
                  onChange={(event) => void importLibrary(event)}
                />
              </div>
            </div>
          ) : null}

          <nav className='mb-5 grid grid-cols-3 rounded-2xl border border-white/[0.07] bg-[#090909] p-1.5'>
            {(
              [
                ['continue', Clock3, t('my.continuing')],
                ['favorites', Heart, t('my.favorites')],
                ['history', History, t('my.watchHistory')],
              ] as const
            ).map(([value, Icon, label]) => (
              <button
                key={value}
                type='button'
                onClick={() => {
                  setTab(value);
                  setDeleteKeys(new Set());
                }}
                className={`flex h-11 items-center justify-center gap-2 rounded-xl text-xs font-black transition sm:text-sm ${tab === value ? 'bg-[var(--ui-accent)] text-zinc-950 shadow-[0_8px_22px_rgba(239,226,196,.16)]' : 'text-zinc-500 hover:text-white'}`}
              >
                <Icon className='h-4 w-4' />
                <span>{label}</span>
              </button>
            ))}
          </nav>

          {feedback ? (
            <p
              aria-live='polite'
              className='mb-3 text-center text-xs text-[var(--ui-accent)]'
            >
              {feedback}
            </p>
          ) : null}

          {loading ? (
            <div className='grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-5 xl:grid-cols-6'>
              {Array.from({ length: 6 }).map((_, index) => (
                <div
                  key={index}
                  className='aspect-[2/3] animate-pulse rounded-[18px] bg-white/[0.05]'
                />
              ))}
            </div>
          ) : tab === 'continue' ? (
            visibleContinue.length ? (
              <div
                className={
                  compact
                    ? 'grid grid-cols-3 gap-2 sm:grid-cols-5 lg:grid-cols-7 xl:grid-cols-8'
                    : 'grid grid-cols-2 gap-3 sm:grid-cols-3 sm:gap-4 lg:grid-cols-5 xl:grid-cols-6'
                }
              >
                {visibleContinue.map((item) => (
                  <article key={item.key}>
                    <button
                      type='button'
                      onClick={() =>
                        router.push(buildTmdbHistoryPlayUrl(item.key, item))
                      }
                      className='relative block aspect-[2/3] w-full overflow-hidden rounded-[18px] border border-white/[0.08] bg-[#090909]'
                    >
                      <img
                        src={item.cover}
                        alt={item.title}
                        className='h-full w-full object-cover'
                      />
                      <span className='absolute inset-x-0 bottom-0 h-2/5 bg-gradient-to-t from-black' />
                      <span className='absolute bottom-3 start-3 end-3 h-1 rounded-full bg-white/15'>
                        <span
                          className='block h-full rounded-full bg-[var(--ui-accent)]'
                          style={{ width: `${getProgress(item)}%` }}
                        />
                      </span>
                    </button>
                    <p className='mt-2 truncate text-sm font-bold text-white'>
                      {item.title}
                    </p>
                  </article>
                ))}
              </div>
            ) : (
              <EmptyLibrary icon={Clock3} title={t('my.emptyHistory')} />
            )
          ) : (
            <>
              {cards.length ? (
                <div
                  className={
                    compact
                      ? 'grid grid-cols-3 gap-2 sm:grid-cols-5 lg:grid-cols-7 xl:grid-cols-8'
                      : 'grid grid-cols-2 gap-3 sm:grid-cols-3 sm:gap-4 lg:grid-cols-5 xl:grid-cols-6'
                  }
                >
                  {cards}
                </div>
              ) : (
                <EmptyLibrary
                  icon={tab === 'favorites' ? Heart : History}
                  title={
                    tab === 'favorites'
                      ? t('my.emptyFavorites')
                      : t('my.emptyHistory')
                  }
                />
              )}
            </>
          )}
        </div>
      </div>

      {deleteKind && deleteKeys.size > 0 ? (
        <div className='fixed inset-x-4 bottom-[max(1rem,env(safe-area-inset-bottom))] z-[800] mx-auto max-w-md rounded-2xl border border-white/[0.09] bg-[#090909] p-3 shadow-[0_24px_70px_rgba(0,0,0,.75)] backdrop-blur-xl sm:inset-x-auto sm:end-6'>
          <div className='flex items-center gap-2'>
            <p className='min-w-0 flex-1 px-2 text-sm font-bold text-white'>
              {deleteKeys.size}
            </p>
            <button
              type='button'
              onClick={() => {
                setDeleteKeys(new Set());
                setDeleteKind(null);
              }}
              className='h-10 rounded-xl border border-white/[0.08] px-4 text-sm font-bold text-zinc-300'
            >
              {t('common.cancel')}
            </button>
            <button
              type='button'
              onClick={() => void confirmDelete()}
              disabled={busy}
              className='h-10 rounded-xl bg-red-500 px-4 text-sm font-bold text-white'
            >
              {t('common.delete')}
            </button>
          </div>
        </div>
      ) : null}
    </PageLayout>
  );
}

function EmptyLibrary({
  icon: Icon,
  title,
}: {
  icon: typeof Clock3;
  title: string;
}) {
  return (
    <div className='grid min-h-[260px] place-items-center rounded-[24px] border border-white/[0.07] bg-[#090909] text-center'>
      <div>
        <Icon className='mx-auto h-9 w-9 text-zinc-700' />
        <p className='mt-3 text-sm font-bold text-zinc-500'>{title}</p>
      </div>
    </div>
  );
}

export default function MyPage() {
  return (
    <Suspense>
      <LibraryClient />
    </Suspense>
  );
}
