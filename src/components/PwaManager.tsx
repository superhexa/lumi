'use client';

import { RefreshCw, WifiOff } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

export function PwaManager() {
  const { t } = useTranslation();
  const registrationRef = useRef<ServiceWorkerRegistration | null>(null);
  const updateRequestedRef = useRef(false);
  const [isOffline, setIsOffline] = useState(false);
  const [updateAvailable, setUpdateAvailable] = useState(false);
  const [reloadForUpdate, setReloadForUpdate] = useState(false);
  const [isPlaybackRoute, setIsPlaybackRoute] = useState(false);

  useEffect(() => {
    const syncPlaybackRoute = () => {
      const pathname = window.location.pathname;
      setIsPlaybackRoute(
        pathname === '/play' ||
          pathname.startsWith('/play/') ||
          pathname === '/player/direct' ||
          pathname.startsWith('/player/direct/') ||
          document.fullscreenElement !== null,
      );
    };
    syncPlaybackRoute();
    window.addEventListener('popstate', syncPlaybackRoute);
    document.addEventListener('fullscreenchange', syncPlaybackRoute);
    return () => {
      window.removeEventListener('popstate', syncPlaybackRoute);
      document.removeEventListener('fullscreenchange', syncPlaybackRoute);
    };
  }, []);

  useEffect(() => {
    setIsOffline(!navigator.onLine);

    const handleOnline = () => setIsOffline(false);
    const handleOffline = () => setIsOffline(true);
    const handleControllerChange = () => {
      if (updateRequestedRef.current) {
        setUpdateAvailable(false);
        setReloadForUpdate(true);
      }
    };

    window.addEventListener('online', handleOnline);
    window.addEventListener('offline', handleOffline);
    navigator.serviceWorker?.addEventListener(
      'controllerchange',
      handleControllerChange,
    );

    let disposed = false;
    let registration: ServiceWorkerRegistration | null = null;
    const handleUpdateFound = () => {
      const installing = registration?.installing;
      if (!installing) return;

      installing.addEventListener('statechange', () => {
        if (
          installing.state === 'installed' &&
          navigator.serviceWorker.controller
        ) {
          setUpdateAvailable(true);
        }
      });
    };

    if ('serviceWorker' in navigator) {
      void navigator.serviceWorker
        .register('/sw.js', { scope: '/' })
        .then((registered) => {
          if (disposed) return;
          registration = registered;
          registrationRef.current = registered;
          if (registered.waiting && navigator.serviceWorker.controller)
            setUpdateAvailable(true);
          registered.addEventListener('updatefound', handleUpdateFound);

          if (navigator.onLine) {
            void registered.update().catch((error: unknown) => {
              // eslint-disable-next-line no-console
              console.error('[PWA] Service worker update check failed:', error);
            });
          }
        })
        .catch((error: unknown) => {
          // eslint-disable-next-line no-console
          console.error('[PWA] Service worker registration failed:', error);
        });
    }

    return () => {
      disposed = true;
      window.removeEventListener('online', handleOnline);
      window.removeEventListener('offline', handleOffline);
      navigator.serviceWorker?.removeEventListener(
        'controllerchange',
        handleControllerChange,
      );
      registration?.removeEventListener('updatefound', handleUpdateFound);
    };
  }, []);

  const activateUpdate = () => {
    const waitingWorker = registrationRef.current?.waiting;
    if (!waitingWorker) {
      setUpdateAvailable(false);
      return;
    }

    updateRequestedRef.current = true;
    waitingWorker.postMessage({ type: 'SKIP_WAITING' });
  };

  if (isPlaybackRoute) return null;
  if (!isOffline && !updateAvailable && !reloadForUpdate) return null;

  return (
    <aside aria-live='polite' className='pwa-manager'>
      {isOffline ? (
        <div className='pwa-status-card flex items-start gap-2.5 text-white'>
          <WifiOff className='mt-0.5 h-5 w-5 shrink-0 text-[var(--ui-accent)]' />
          <div className='min-w-0'>
            <p className='font-semibold'>{t('pwa.offlineTitle')}</p>
            <p className='mt-1 text-sm text-zinc-300'>
              {t('pwa.offlineDescription')}
            </p>
          </div>
        </div>
      ) : null}

      {updateAvailable ? (
        <div className='pwa-status-card flex items-center gap-2.5 text-white'>
          <RefreshCw className='h-5 w-5 shrink-0 text-[var(--ui-accent)]' />
          <p className='min-w-0 flex-1 text-sm font-medium'>
            {t('pwa.updateAvailable')}
          </p>
          <button
            type='button'
            onClick={activateUpdate}
            className='pwa-status-action shrink-0 rounded-lg bg-[var(--ui-accent)] px-3 py-2 text-sm font-semibold text-zinc-950 transition hover:brightness-110'
          >
            {t('pwa.update')}
          </button>
        </div>
      ) : null}

      {reloadForUpdate ? (
        <div className='pwa-status-card flex items-center gap-2.5 text-white'>
          <RefreshCw className='h-5 w-5 shrink-0 text-[var(--ui-accent)]' />
          <p className='min-w-0 flex-1 text-sm font-medium'>
            {t('pwa.updateReady')}
          </p>
          <button
            type='button'
            onClick={() => window.location.reload()}
            className='pwa-status-action shrink-0 rounded-lg bg-[var(--ui-accent)] px-3 py-2 text-sm font-semibold text-zinc-950 transition hover:brightness-110'
          >
            {t('pwa.reload')}
          </button>
        </div>
      ) : null}
    </aside>
  );
}
