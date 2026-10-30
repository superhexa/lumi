/* eslint-disable @typescript-eslint/no-explicit-any */
'use client';

import { AnimatePresence, motion, useReducedMotion } from 'framer-motion';
import {
  ArrowLeft,
  ChevronLeft,
  Film,
  HeartPulse,
  Home,
  Origami,
  Search,
  Tv,
  UserRound,
  X,
} from 'lucide-react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useEffect } from 'react';
import { useTranslation } from 'react-i18next';

import { useWarpRouteTransition } from '@/hooks/useWarpRouteTransition';
import WarpLoadingOverlay from '@/components/WarpLoadingOverlay';

interface MobileBottomNavProps {
  activePath?: string;
  isOpen: boolean;
  onClose: () => void;
  onMenuToggle?: () => void;
  showBackButton?: boolean;
  useHeroHeaderStyle?: boolean;
}

export default function MobileBottomNav({
  activePath,
  isOpen,
  onClose,
  onMenuToggle,
  showBackButton = false,
}: MobileBottomNavProps) {
  const { t } = useTranslation();
  const pathname = usePathname();
  const shouldReduceMotion = useReducedMotion();
  const { showWarpLoading, navigateLinkWithWarpLoading } =
    useWarpRouteTransition();
  const currentActive = activePath ?? pathname;
  const isRtl =
    typeof document !== 'undefined' && document.documentElement.dir === 'rtl';

  const navItems = [
    { icon: Home, label: t('common.home'), href: '/' },
    { icon: UserRound, label: t('common.myLibrary'), href: '/my' },
    { icon: Search, label: t('common.search'), href: '/search' },
  ];
  const categoryItems = [
    { icon: Film, label: t('common.movies'), href: '/discover?type=movie' },
    { icon: Tv, label: t('common.series'), href: '/discover?type=tv' },
    { icon: Origami, label: t('common.anime'), href: '/discover?type=anime' },
    { icon: HeartPulse, label: t('common.shows'), href: '/discover?type=show' },
  ];

  useEffect(() => onClose(), [onClose, pathname]);
  useEffect(() => {
    document.body.style.overflow = isOpen ? 'hidden' : '';
    return () => {
      document.body.style.overflow = '';
    };
  }, [isOpen]);

  const isActive = (href: string) => {
    if (href.includes('?type='))
      return (
        currentActive.startsWith('/discover') &&
        currentActive.includes(href.split('?type=')[1])
      );
    return href === currentActive;
  };

  const renderItem = (item: {
    icon: typeof Home;
    label: string;
    href: string;
  }) => {
    const Icon = item.icon;
    const active = isActive(item.href);
    return (
      <Link
        key={item.href}
        href={item.href}
        onClick={(event) =>
          navigateLinkWithWarpLoading(event, item.href, {
            onBeforeNavigate: onClose,
          })
        }
        className={`group flex min-h-[58px] items-center gap-3 rounded-2xl border px-3 py-2 transition duration-200 active:scale-[.98] ${active ? 'border-cyan-300/25 bg-cyan-400/[0.12] text-white' : 'border-white/[0.06] bg-white/[0.035] text-zinc-200 hover:border-cyan-300/15 hover:bg-white/[0.07]'}`}
      >
        <span
          className={`grid h-10 w-10 shrink-0 place-items-center rounded-xl ${active ? 'bg-cyan-400 text-slate-950' : 'bg-white/[0.06] text-cyan-300'}`}
        >
          <Icon className='h-[19px] w-[19px]' />
        </span>
        <span className='min-w-0 flex-1 break-words text-[15px] font-bold leading-snug'>
          {item.label}
        </span>
        <ChevronLeft
          className={`h-4 w-4 rtl:rotate-180 ${active ? 'text-cyan-300' : 'text-zinc-600'}`}
        />
      </Link>
    );
  };

  return (
    <>
      <WarpLoadingOverlay visible={showWarpLoading} />
      <AnimatePresence>
        {isOpen ? (
          <motion.div
            className='fixed inset-0 z-[700] md:hidden'
            initial={false}
            animate={{}}
            exit={{}}
          >
            <motion.button
              type='button'
              aria-label={t('common.closeMenu')}
              onClick={onClose}
              className='absolute inset-0 h-full w-full bg-black/75 backdrop-blur-md'
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
            />
            <motion.aside
              dir={undefined}
              role='dialog'
              aria-modal='true'
              aria-label={t('common.menu')}
              className={`absolute inset-y-0 flex w-[min(88vw,360px)] flex-col border-e border-white/[0.08] bg-[linear-gradient(145deg,#08111b_0%,#05070a_42%,#020304_100%)] text-white shadow-[28px_0_80px_rgba(0,0,0,.78)] ${isRtl ? 'inset-inline-end-0' : 'inset-inline-start-0'}`}
              style={{
                paddingTop: 'env(safe-area-inset-top)',
                paddingBottom: 'env(safe-area-inset-bottom)',
              }}
              initial={
                shouldReduceMotion
                  ? { opacity: 0 }
                  : { x: isRtl ? '100%' : '-100%', opacity: 0.8 }
              }
              animate={{ x: 0, opacity: 1 }}
              exit={
                shouldReduceMotion
                  ? { opacity: 0 }
                  : { x: isRtl ? '100%' : '-100%', opacity: 0.6 }
              }
              transition={{ type: 'spring', stiffness: 480, damping: 38 }}
            >
              <div className='flex h-[72px] shrink-0 items-center justify-between border-b border-white/[0.07] px-4'>
                <div className='flex items-center gap-2'>
                  <span className='grid h-10 w-10 place-items-center rounded-xl bg-gradient-to-br from-cyan-400 to-blue-500 text-slate-950 shadow-[0_8px_24px_rgba(34,211,238,.2)]'>
                    <Film className='h-5 w-5' />
                  </span>
                  <span className='text-lg font-black tracking-tight'>
                    Lumi
                  </span>
                </div>
                <button
                  type='button'
                  onClick={onMenuToggle || onClose}
                  aria-label={t('common.closeMenu')}
                  className='grid h-11 w-11 place-items-center rounded-full border border-white/[0.08] bg-white/[0.05] text-zinc-300 active:bg-white/[0.1]'
                >
                  <X className='h-5 w-5' />
                </button>
              </div>

              <nav className='scrollbar-hide flex-1 overflow-y-auto px-4 py-5 sm:px-5'>
                <p className='mb-2 px-2 text-[11px] font-black uppercase tracking-[0.2em] text-cyan-300/60'>
                  {t('common.menu')}
                </p>
                <div className='grid gap-2'>{navItems.map(renderItem)}</div>
                <p className='mb-2 mt-6 px-2 text-[11px] font-black uppercase tracking-[0.2em] text-cyan-300/60'>
                  {t('common.categories')}
                </p>
                <div className='grid grid-cols-1 gap-2 min-[380px]:grid-cols-2'>
                  {categoryItems.map(renderItem)}
                </div>
              </nav>

              {showBackButton ? (
                <div className='border-t border-white/[0.07] p-3'>
                  <button
                    type='button'
                    onClick={() => window.history.back()}
                    className='flex h-12 w-full items-center justify-center gap-2 rounded-2xl border border-white/[0.08] bg-white/[0.04] text-sm font-bold text-white'
                  >
                    <ArrowLeft className='h-4 w-4 rtl:rotate-180' />
                    {t('common.back')}
                  </button>
                </div>
              ) : null}
            </motion.aside>
          </motion.div>
        ) : null}
      </AnimatePresence>
    </>
  );
}
