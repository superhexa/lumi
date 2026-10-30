'use client';

import { Download, RefreshCw, WifiOff, X } from 'lucide-react';
import Image from 'next/image';
import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

interface InstallPromptEvent extends Event {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed'; platform: string }>;
}

export function PwaManager() {
  const { t } = useTranslation();
  const registrationRef = useRef<ServiceWorkerRegistration | null>(null);
  const installPromptRef = useRef<InstallPromptEvent | null>(null);
  const updateRequestedRef = useRef(false);
  const [installAvailable, setInstallAvailable] = useState(false);
  const [installDismissed, setInstallDismissed] = useState(false);
  const [isIosInstall, setIsIosInstall] = useState(false);
  const [iosInstructionsOpen, setIosInstructionsOpen] = useState(false);
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
    const isStandalone =
      window.matchMedia('(display-mode: standalone)').matches ||
      (
        navigator as Navigator & {
          standalone?: boolean;
        }
      ).standalone === true;
    const isIos =
      /iPad|iPhone|iPod/.test(navigator.userAgent) ||
      (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);

    setIsOffline(!navigator.onLine);
    setIsIosInstall(isIos && !isStandalone);

    const handleInstallPrompt = (event: Event) => {
      event.preventDefault();
      installPromptRef.current = event as InstallPromptEvent;
      setInstallAvailable(true);
    };
    const handleAppInstalled = () => {
      installPromptRef.current = null;
      setInstallAvailable(false);
      setIsIosInstall(false);
      setInstallDismissed(true);
    };
    const handleOnline = () => setIsOffline(false);
    const handleOffline = () => setIsOffline(true);
    const handleControllerChange = () => {
      if (updateRequestedRef.current) {
        setUpdateAvailable(false);
        setReloadForUpdate(true);
      }
    };

    window.addEventListener('beforeinstallprompt', handleInstallPrompt);
    window.addEventListener('appinstalled', handleAppInstalled);
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
      window.removeEventListener('beforeinstallprompt', handleInstallPrompt);
      window.removeEventListener('appinstalled', handleAppInstalled);
      window.removeEventListener('online', handleOnline);
      window.removeEventListener('offline', handleOffline);
      navigator.serviceWorker?.removeEventListener(
        'controllerchange',
        handleControllerChange,
      );
      registration?.removeEventListener('updatefound', handleUpdateFound);
    };
  }, []);

  const installApp = async () => {
    const prompt = installPromptRef.current;
    if (!prompt) return;

    installPromptRef.current = null;
    setInstallAvailable(false);
    try {
      await prompt.prompt();
      await prompt.userChoice;
    } catch (error) {
      // eslint-disable-next-line no-console
      console.error('[PWA] App installation prompt failed:', error);
    }
  };

  const activateUpdate = () => {
    const waitingWorker = registrationRef.current?.waiting;
    if (!waitingWorker) {
      setUpdateAvailable(false);
      return;
    }

    updateRequestedRef.current = true;
    waitingWorker.postMessage({ type: 'SKIP_WAITING' });
  };

  const showInstallCard =
    !installDismissed && (installAvailable || isIosInstall);
  if (isPlaybackRoute) return null;
  if (!isOffline && !showInstallCard && !updateAvailable && !reloadForUpdate)
    return null;

  return (
    <aside aria-live='polite' className='pwa-manager'>
      {isOffline ? (
        <div className='pwa-status-card flex items-start gap-2.5 text-white'>
          <WifiOff className='mt-0.5 h-5 w-5 shrink-0 text-cyan-300' />
          <div className='min-w-0'>
            <p className='font-semibold'>{t('pwa.offlineTitle')}</p>
            <p className='mt-1 text-sm text-slate-300'>
              {t('pwa.offlineDescription')}
            </p>
          </div>
        </div>
      ) : null}

      {showInstallCard ? (
        <div className='pwa-card pwa-install-card'>
          <button
            type='button'
            onClick={() => setInstallDismissed(true)}
            aria-label={t('common.close')}
            className='pwa-close ui-glass-control'
          >
            <X className='h-4 w-4' />
          </button>
          <div className='pwa-install-heading'>
            <span className='pwa-icon-wrap overflow-hidden'>
              <Image
                src='/icons/icon-192x192.png'
                alt=''
                width={44}
                height={44}
                priority
              />
            </span>
            <div className='min-w-0'>
              <p className='text-base font-semibold tracking-tight'>
                {t('pwa.installTitle')}
              </p>
              <p className='mt-1 text-sm leading-relaxed text-slate-300'>
                {isIosInstall
                  ? t('pwa.iosInstallDescription')
                  : t('pwa.installDescription')}
              </p>
            </div>
          </div>
          {installAvailable ? (
            <button
              type='button'
              onClick={() => void installApp()}
              className='pwa-primary-action'
            >
              <Download aria-hidden='true' className='h-4 w-4' />
              {t('pwa.install')}
            </button>
          ) : (
            <>
              <button
                type='button'
                onClick={() => setIosInstructionsOpen((open) => !open)}
                className='pwa-primary-action'
                aria-expanded={iosInstructionsOpen}
                aria-controls='pwa-ios-instructions'
              >
                {iosInstructionsOpen
                  ? t('common.close')
                  : t('pwa.howToInstall')}
              </button>
              {iosInstructionsOpen ? (
                <p id='pwa-ios-instructions' className='pwa-ios-instructions'>
                  {t('pwa.iosInstructions')}
                </p>
              ) : null}
            </>
          )}
        </div>
      ) : null}

      {updateAvailable ? (
        <div className='pwa-status-card flex items-center gap-2.5 text-white'>
          <RefreshCw className='h-5 w-5 shrink-0 text-cyan-300' />
          <p className='min-w-0 flex-1 text-sm font-medium'>
            {t('pwa.updateAvailable')}
          </p>
          <button
            type='button'
            onClick={activateUpdate}
            className='pwa-status-action shrink-0 rounded-lg bg-cyan-400 px-3 py-2 text-sm font-semibold text-slate-950 transition hover:bg-cyan-300'
          >
            {t('pwa.update')}
          </button>
        </div>
      ) : null}

      {reloadForUpdate ? (
        <div className='pwa-status-card flex items-center gap-2.5 text-white'>
          <RefreshCw className='h-5 w-5 shrink-0 text-cyan-300' />
          <p className='min-w-0 flex-1 text-sm font-medium'>
            {t('pwa.updateReady')}
          </p>
          <button
            type='button'
            onClick={() => window.location.reload()}
            className='pwa-status-action shrink-0 rounded-lg bg-cyan-400 px-3 py-2 text-sm font-semibold text-slate-950 transition hover:bg-cyan-300'
          >
            {t('pwa.reload')}
          </button>
        </div>
      ) : null}
    </aside>
  );
}
