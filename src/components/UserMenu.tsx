/* eslint-disable no-console */

'use client';

import { AnimatePresence, motion, useReducedMotion } from 'framer-motion';
import { Clapperboard, ExternalLink } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';

import { checkForUpdates, UpdateStatus } from '@/lib/version';

import LanguageSwitcher from '@/components/LanguageSwitcher';
import { useSite } from '@/components/SiteProvider';

const MENU_PANEL_GAP = 8;

type UserAvatarSize = 'default' | 'compact';

interface UserMenuProps {
  triggerClassName?: string;
  avatarSize?: UserAvatarSize;
}

export const UserMenu: React.FC<UserMenuProps> = ({
  triggerClassName,
  avatarSize = 'default',
}) => {
  const { t } = useTranslation();
  const { siteName } = useSite();
  const shouldReduceMotion = useReducedMotion();
  const triggerRef = useRef<HTMLDivElement | null>(null);
  const panelRef = useRef<HTMLDivElement | null>(null);
  const [isOpen, setIsOpen] = useState(false);
  const [mounted, setMounted] = useState(false);
  const [hasUpdate, setHasUpdate] = useState(false);
  const [menuPosition, setMenuPosition] = useState({ top: 58, left: 12 });

  useEffect(() => {
    setMounted(true);
    checkForUpdates()
      .then((status) => setHasUpdate(status === UpdateStatus.HAS_UPDATE))
      .catch((error) => console.warn('Version check failed:', error));
  }, []);

  const updateMenuPosition = useCallback(() => {
    const rect = triggerRef.current?.getBoundingClientRect();
    if (!rect || typeof window === 'undefined') return;

    const viewportPadding = 12;
    const panelWidth =
      window.innerWidth < 640 ? window.innerWidth - viewportPadding * 2 : 280;
    const preferredLeft =
      window.innerWidth < 640
        ? viewportPadding
        : Math.min(
            rect.right - panelWidth,
            window.innerWidth - panelWidth - viewportPadding,
          );

    const preferredTop = Math.max(
      viewportPadding + 56,
      rect.bottom + MENU_PANEL_GAP,
    );
    setMenuPosition({
      top: Math.min(
        preferredTop,
        Math.max(viewportPadding + 56, window.innerHeight - 190),
      ),
      left: Math.max(viewportPadding, preferredLeft),
    });
  }, []);

  const toggleMenu = () => {
    updateMenuPosition();
    setIsOpen((open) => !open);
  };

  useEffect(() => {
    if (!isOpen) return;

    const handlePointerDown = (event: PointerEvent) => {
      const target = event.target as Node;
      if (triggerRef.current?.contains(target)) return;
      if (!panelRef.current?.contains(target)) setIsOpen(false);
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setIsOpen(false);
    };

    window.addEventListener('pointerdown', handlePointerDown);
    window.addEventListener('keydown', handleKeyDown);
    window.addEventListener('resize', updateMenuPosition);
    window.addEventListener('scroll', updateMenuPosition, true);
    return () => {
      window.removeEventListener('pointerdown', handlePointerDown);
      window.removeEventListener('keydown', handleKeyDown);
      window.removeEventListener('resize', updateMenuPosition);
      window.removeEventListener('scroll', updateMenuPosition, true);
    };
  }, [isOpen, updateMenuPosition]);

  const menuPanel = (
    <motion.div
      ref={panelRef}
      role='dialog'
      aria-label={t('common.siteMenu')}
      className='ui-glass-panel fixed z-[1001] max-h-[calc(100dvh-24px)] w-[calc(100vw-24px)] max-w-[280px] overflow-y-auto rounded-[20px] border border-white/15 p-2 shadow-[0_24px_70px_rgba(0,0,0,.68),0_8px_30px_rgba(255,255,255,.05)] sm:w-[280px]'
      style={{ top: menuPosition.top, left: menuPosition.left }}
      initial={
        shouldReduceMotion ? { opacity: 0 } : { opacity: 0, y: -8, scale: 0.96 }
      }
      animate={{ opacity: 1, y: 0, scale: 1 }}
      exit={
        shouldReduceMotion ? { opacity: 0 } : { opacity: 0, y: -6, scale: 0.97 }
      }
      transition={{ duration: shouldReduceMotion ? 0 : 0.16 }}
    >
      <div className='border-b border-[var(--ui-glass-divider)] px-2 pb-2'>
        <p className='break-words text-sm font-semibold leading-5 text-[var(--ui-text-strong)]'>
          {siteName}
        </p>
        <p className='mt-0.5 text-xs text-[var(--ui-text-muted)]'>
          {t('common.developedBy')}
        </p>
        <a
          href='https://t.me/decimalvalue'
          target='_blank'
          rel='noreferrer'
          className='mt-1 inline-flex items-center gap-1 text-sm font-medium text-[var(--ui-highlight)] transition-colors hover:text-white'
        >
          Bit <span className='text-[var(--ui-text-muted)]'>@decimalvalue</span>
          <ExternalLink className='h-3 w-3' />
        </a>
      </div>
      <div className='pt-1'>
        <LanguageSwitcher variant='menuItem' />
      </div>
    </motion.div>
  );

  return (
    <>
      <div
        ref={triggerRef}
        className={`relative m-0 flex items-center justify-center ${
          avatarSize === 'compact' ? 'h-full w-11' : ''
        }`}
      >
        <button
          type='button'
          onClick={toggleMenu}
          aria-expanded={isOpen}
          aria-haspopup='dialog'
          aria-label={t('common.siteMenu')}
          className={`${
            triggerClassName ||
            `ui-glass-control ${isOpen ? 'ui-glass-control-active' : ''}`
          } m-0 inline-flex h-11 w-11 items-center justify-center p-0 outline-none focus-visible:outline-none`}
        >
          <Clapperboard className='h-5 w-5 shrink-0' />
        </button>
        {hasUpdate ? (
          <span className='absolute right-[2px] top-[2px] h-2 w-2 rounded-full bg-[var(--ui-highlight)]' />
        ) : null}
      </div>
      {mounted
        ? createPortal(
            <AnimatePresence>{isOpen ? menuPanel : null}</AnimatePresence>,
            document.body,
          )
        : null}
    </>
  );
};
