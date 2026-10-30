'use client';

// @ts-expect-error Next.js bundles this ESM client dependency; Node16 module checking expects require().
import * as Vidstack from '@vidstack/react';
// @ts-expect-error Next.js bundles this ESM client dependency; Node16 module checking expects require().
import * as VidstackLayout from '@vidstack/react/player/layouts/default';
import { X } from 'lucide-react';
import { useSearchParams } from 'next/navigation';
import { Suspense, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

import '@vidstack/react/player/styles/default/theme.css';
import '@vidstack/react/player/styles/default/layouts/video.css';

const { MediaPlayer, MediaProvider } = Vidstack;
const { DefaultVideoLayout, defaultLayoutIcons } = VidstackLayout;

interface DismissibleMenuElement extends HTMLElement {
  close?: (trigger?: Event) => void;
}

function DirectPlayer() {
  const params = useSearchParams();
  const { t } = useTranslation();
  const player = useRef<Vidstack.MediaPlayerInstance>(null);
  const shell = useRef<HTMLElement>(null);
  const [streamUrl, setStreamUrl] = useState('');
  const [streamType, setStreamType] = useState<
    'application/x-mpegurl' | 'video/mp4' | 'video/webm' | 'video/ogg'
  >('application/x-mpegurl');
  const [title, setTitle] = useState('');
  const [failed, setFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const [menuOpen, setMenuOpen] = useState(false);
  const resumeValue = Number(params.get('t'));
  const resume = Number.isFinite(resumeValue) ? Math.max(0, resumeValue) : 0;
  const provider = params.get('provider') === 'archive' ? 'archive' : 'bingr';
  const query = new URLSearchParams({
    tmdbId: params.get('tmdbId') || '',
    type: params.get('type') || 'movie',
    season: params.get('season') || '1',
    episode: params.get('episode') || '1',
  });
  if (params.get('title')) query.set('title', params.get('title') || '');
  if (params.get('year')) query.set('year', params.get('year') || '');
  const queryString = query.toString();

  useEffect(() => {
    const controller = new AbortController();
    setFailed(false);
    setStreamUrl('');
    void fetch(`/api/player/${provider}?${queryString}`, { signal: controller.signal })
      .then(async (response) => {
        const data = (await response.json()) as {
          streamUrl: string;
          title?: string;
          code?: string;
          contentType?: string;
        };
        if (!response.ok) {
          // eslint-disable-next-line no-console
          console.error(
            `[${provider === 'archive' ? 'Internet Archive' : 'Bingr'}] Source unavailable:`,
            data.code || response.status,
          );
          throw new Error('Unavailable source');
        }
        if (!controller.signal.aborted) {
          setTitle(data.title || '');
          setStreamType(
            (data.contentType === 'video/webm' || data.contentType === 'video/ogg'
              ? data.contentType
              : data.contentType === 'video/mp4'
                ? 'video/mp4'
                : 'application/x-mpegurl') as typeof streamType,
          );
          setStreamUrl(data.streamUrl);
        }
      })
      .catch((error) => {
        if (!controller.signal.aborted) {
          // eslint-disable-next-line no-console
          console.error(
            `[${provider === 'archive' ? 'Internet Archive' : 'Bingr'}] Playback request failed:`,
            error instanceof Error ? error.message : 'Unknown error',
          );
          setFailed(true);
        }
      });
    return () => controller.abort();
  }, [queryString, attempt, provider]);

  useEffect(() => {
    const seek = (event: MessageEvent) => {
      if (
        event.source !== window.parent ||
        event.origin !== window.location.origin
      )
        return;
      if (
        event.data?.type === 'seek' &&
        Number.isFinite(event.data.time) &&
        event.data.time >= 0 &&
        player.current
      ) {
        player.current.currentTime = event.data.time;
      }
    };
    window.addEventListener('message', seek);
    return () => window.removeEventListener('message', seek);
  }, []);

  useEffect(() => {
    const root = shell.current;
    if (!root || !streamUrl) return;

    const syncMenuState = () => {
      setMenuOpen(root.querySelector('media-menu[data-open]') !== null);
    };
    const observer = new MutationObserver(syncMenuState);
    observer.observe(root, {
      attributes: true,
      attributeFilter: ['data-open'],
      childList: true,
      subtree: true,
    });
    syncMenuState();

    return () => observer.disconnect();
  }, [streamUrl]);

  const closePlayerMenus = () => {
    shell.current
      ?.querySelectorAll<DismissibleMenuElement>('media-menu[data-open]')
      .forEach((menu) => menu.close?.());
  };

  const send = (event: string) => {
    if (!player.current) return;
    window.parent.postMessage(
      {
        type: 'PLAYER_EVENT',
        data: {
          event,
          currentTime: player.current.state.currentTime,
          duration: player.current.state.duration,
        },
      },
      window.location.origin,
    );
  };

  return (
    <main
      ref={shell}
      className='direct-player-shell'
      style={{
        position: 'fixed',
        inset: 0,
        height: '100dvh',
        background: '#000',
        color: '#fff',
      }}
    >
      {menuOpen ? (
        <button
          type='button'
          aria-label={t('common.close')}
          title={t('common.close')}
          onClick={closePlayerMenus}
          className='direct-player-menu-close ui-glass-control absolute right-3 top-3 z-[10000000] h-11 w-11 items-center justify-center rounded-full'
        >
          <X className='mx-auto h-5 w-5' />
        </button>
      ) : null}
      {streamUrl && !failed ? (
        <MediaPlayer
          ref={player}
          title={title}
          src={{ src: streamUrl, type: streamType }}
          autoPlay
          playsInline
          currentTime={resume}
          preload='auto'
          style={{ width: '100%', height: '100dvh' }}
          onTimeUpdate={() => send('timeupdate')}
          onPlay={() => send('play')}
          onPause={() => send('pause')}
          onSeeked={() => send('seeked')}
          onEnded={() => send('ended')}
          onError={() => setFailed(true)}
        >
          <MediaProvider />
          <DefaultVideoLayout
            icons={defaultLayoutIcons}
            menuContainer='.direct-player-shell'
          />
        </MediaPlayer>
      ) : (
        <div className='flex h-full flex-col items-center justify-center gap-4 p-6 text-center'>
          <p role='status'>
            {t(failed ? 'play.playerLoadFailed' : 'common.loading')}
          </p>
          {failed ? (
            <button
              className='ui-glass-control px-4 py-2'
              onClick={() => setAttempt((value) => value + 1)}
            >
              {t('play.retry')}
            </button>
          ) : null}
        </div>
      )}
    </main>
  );
}

export default function DirectPlayerPage() {
  return (
    <Suspense>
      <DirectPlayer />
    </Suspense>
  );
}
