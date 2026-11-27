'use client';

import {
  ArrowLeft,
  Clapperboard,
  HeartPulse,
  Home,
  Origami,
  Search,
  Sparkles,
  Tv,
  UserRound,
} from 'lucide-react';
import Link from 'next/link';
import { usePathname, useSearchParams } from 'next/navigation';
import { createContext, useContext } from 'react';
import { useTranslation } from 'react-i18next';

import { useWarpRouteTransition } from '@/hooks/useWarpRouteTransition';

import WarpLoadingOverlay from '@/components/WarpLoadingOverlay';

interface SidebarContextType {
  isCollapsed: boolean;
}

const SidebarContext = createContext<SidebarContextType>({
  isCollapsed: true,
});

export const useSidebar = () => useContext(SidebarContext);

interface SidebarProps {
  onToggle?: (collapsed: boolean) => void;
  activePath?: string;
  showBackButton?: boolean;
}

const Sidebar = ({
  activePath = '/',
  showBackButton = false,
}: SidebarProps) => {
  const { t } = useTranslation();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const { showWarpLoading, navigateLinkWithWarpLoading } =
    useWarpRouteTransition();

  const active = activePath || pathname;
  const activeType = searchParams.get('type');

  const isActive = (href: string) => {
    const type = href.match(/type=([^&]+)/)?.[1];
    if (type) return pathname === '/discover' && activeType === type;
    return pathname === href || active === href;
  };

  const items = [
    { icon: Home, label: t('common.home'), href: '/' },
    {
      icon: Clapperboard,
      label: t('common.movies'),
      href: '/discover?type=movie',
    },
    { icon: Tv, label: t('common.series'), href: '/discover?type=tv' },
    { icon: Origami, label: t('common.anime'), href: '/discover?type=anime' },
    {
      icon: HeartPulse,
      label: t('common.shows'),
      href: '/discover?type=show',
    },
    { icon: Search, label: t('common.search'), href: '/search' },
    { icon: UserRound, label: t('common.myLibrary'), href: '/my' },
  ];

  return (
    <SidebarContext.Provider value={{ isCollapsed: false }}>
      <WarpLoadingOverlay visible={showWarpLoading} />
      <aside
        aria-label={t('common.menu')}
        className='fixed inset-y-0 start-0 z-[730] hidden w-[4.6rem] md:block'
      >
        <div className='group/rail absolute inset-y-3 start-3 flex w-[4.1rem] flex-col overflow-hidden rounded-[26px] border border-white/15 bg-[linear-gradient(165deg,rgba(32,32,35,.92),rgba(9,9,11,.96))] shadow-[0_24px_70px_rgba(0,0,0,.6),inset_0_1px_0_rgba(255,255,255,.18)] backdrop-blur-2xl transition-[width] duration-300 ease-out hover:w-[14.5rem] focus-within:w-[14.5rem]'>
          <div className='pointer-events-none absolute inset-x-0 top-0 h-24 bg-[radial-gradient(80%_100%_at_50%_0%,rgba(255,255,255,.12),transparent_70%)]' />

          <div className='relative flex h-[4.4rem] shrink-0 items-center gap-3 px-3'>
            <span className='grid h-10 w-10 shrink-0 place-items-center rounded-2xl bg-[linear-gradient(150deg,#f6ead0,#c8b184)] text-zinc-950 shadow-[0_10px_28px_rgba(239,226,196,.24)]'>
              <Sparkles className='h-5 w-5' />
            </span>
            <span className='truncate text-lg font-black tracking-tight text-white opacity-0 transition-opacity duration-200 group-hover/rail:opacity-100 group-focus-within/rail:opacity-100'>
              Lumi
            </span>
          </div>

          <nav className='relative flex-1 space-y-1 overflow-y-auto overflow-x-hidden px-2 pb-3 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden'>
            {items.map((item) => {
              const Icon = item.icon;
              const activeItem = isActive(item.href);
              return (
                <Link
                  key={item.href}
                  href={item.href}
                  aria-current={activeItem ? 'page' : undefined}
                  onClick={(event) =>
                    navigateLinkWithWarpLoading(event, item.href)
                  }
                  className={`group/item relative flex h-12 items-center gap-3 rounded-2xl px-2.5 transition-colors duration-200 ${
                    activeItem
                      ? 'bg-[linear-gradient(100deg,rgba(239,226,196,.18),rgba(255,255,255,.04))] text-white shadow-[inset_0_1px_0_rgba(255,255,255,.16)]'
                      : 'text-zinc-400 hover:bg-white/[0.07] hover:text-white'
                  }`}
                >
                  {activeItem ? (
                    <span className='absolute start-0 top-1/2 h-6 w-[3px] -translate-y-1/2 rounded-full bg-[var(--ui-accent)] shadow-[0_0_12px_rgba(239,226,196,.7)]' />
                  ) : null}
                  <span
                    className={`grid h-9 w-9 shrink-0 place-items-center rounded-xl transition-colors ${
                      activeItem
                        ? 'bg-[var(--ui-accent)] text-zinc-950'
                        : 'bg-white/[0.055] text-zinc-300 group-hover/item:bg-white/[0.1] group-hover/item:text-white'
                    }`}
                  >
                    <Icon className='h-[18px] w-[18px]' />
                  </span>
                  <span className='truncate text-sm font-semibold opacity-0 transition-opacity duration-200 group-hover/rail:opacity-100 group-focus-within/rail:opacity-100'>
                    {item.label}
                  </span>
                </Link>
              );
            })}
          </nav>

          {showBackButton ? (
            <div className='relative shrink-0 border-t border-white/[0.08] p-2'>
              <button
                type='button'
                onClick={() => window.history.back()}
                className='flex h-12 w-full items-center gap-3 rounded-2xl px-2.5 text-zinc-400 transition-colors hover:bg-white/[0.07] hover:text-white'
              >
                <span className='grid h-9 w-9 shrink-0 place-items-center rounded-xl bg-white/[0.055]'>
                  <ArrowLeft className='h-[18px] w-[18px] rtl:rotate-180' />
                </span>
                <span className='truncate text-sm font-semibold opacity-0 transition-opacity duration-200 group-hover/rail:opacity-100 group-focus-within/rail:opacity-100'>
                  {t('common.back')}
                </span>
              </button>
            </div>
          ) : null}
        </div>
      </aside>
    </SidebarContext.Provider>
  );
};

export default Sidebar;
