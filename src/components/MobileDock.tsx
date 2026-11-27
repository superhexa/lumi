'use client';

import { Clapperboard, HeartPulse, Home, Origami, Tv } from 'lucide-react';
import Link from 'next/link';
import { usePathname, useSearchParams } from 'next/navigation';
import { useTranslation } from 'react-i18next';

import { useWarpRouteTransition } from '@/hooks/useWarpRouteTransition';

export default function MobileDock() {
  const { t } = useTranslation();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const { navigateLinkWithWarpLoading } = useWarpRouteTransition();
  const activeType = searchParams.get('type');

  if (pathname === '/play' || pathname.startsWith('/player/')) return null;

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
  ];

  const isActive = (href: string) => {
    const type = href.match(/type=([^&]+)/)?.[1];
    if (type) return pathname === '/discover' && activeType === type;
    return pathname === href;
  };

  return (
    <nav aria-label={t('common.menu')} className='mobile-glass-dock md:hidden'>
      <div className='mobile-glass-dock-inner'>
        {items.map((item) => {
          const Icon = item.icon;
          const active = isActive(item.href);
          return (
            <Link
              key={item.href}
              href={item.href}
              aria-current={active ? 'page' : undefined}
              data-active={active}
              onClick={(event) => navigateLinkWithWarpLoading(event, item.href)}
              className='mobile-glass-dock-item'
            >
              <Icon className='h-[19px] w-[19px]' strokeWidth={2.2} />
              <span className='mobile-glass-dock-label'>{item.label}</span>
            </Link>
          );
        })}
      </div>
    </nav>
  );
}
