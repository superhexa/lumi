'use client';

import { Languages } from 'lucide-react';
import { useCallback } from 'react';
import { useTranslation } from 'react-i18next';

import { persistLanguage } from '@/i18n/client';
import type { AppLanguage } from '@/i18n/resources';

interface LanguageSwitcherProps {
  className?: string;
  variant?: 'control' | 'menuItem';
}

function LanguageBadge({ language }: { language: AppLanguage }) {
  return (
    <span
      aria-hidden='true'
      dir='auto'
      className='grid h-7 min-w-7 place-items-center rounded-full border border-rose-200/20 bg-gradient-to-br from-rose-300/20 to-violet-300/10 px-1 text-[11px] font-bold tracking-wide text-rose-100 shadow-inner shadow-white/10'
    >
      {language === 'ar' ? 'ع' : 'EN'}
    </span>
  );
}

export default function LanguageSwitcher({
  className = '',
  variant = 'control',
}: LanguageSwitcherProps) {
  const { i18n, t } = useTranslation();
  const currentLanguage: AppLanguage = i18n.language?.startsWith('ar')
    ? 'ar'
    : 'en';

  const nextLanguage: AppLanguage = currentLanguage === 'ar' ? 'en' : 'ar';
  const label =
    currentLanguage === 'ar' ? t('language.english') : t('language.arabic');
  const accessibleLabel = `${t('language.switcherLabel')}: ${label}`;

  const changeLanguage = useCallback(() => {
    void i18n.changeLanguage(nextLanguage);
    persistLanguage(nextLanguage);
  }, [i18n, nextLanguage]);

  if (variant === 'menuItem') {
    return (
      <button
        type='button'
        aria-label={accessibleLabel}
        title={accessibleLabel}
        onClick={changeLanguage}
        className={`ui-glass-row flex w-full items-center justify-between gap-2 px-2.5 py-2 text-left text-[13px] text-zinc-200 hover:text-white ${className}`}
      >
        <span className='inline-flex min-w-0 items-center gap-2'>
          <Languages className='h-3.5 w-3.5 shrink-0 text-zinc-400' />
          <span className='font-medium'>{t('common.language')}</span>
        </span>
        <LanguageBadge language={nextLanguage} />
      </button>
    );
  }

  return (
    <button
      type='button'
      aria-label={accessibleLabel}
      title={accessibleLabel}
      onClick={changeLanguage}
      className={`ui-glass-control inline-flex h-11 min-w-11 items-center justify-center px-1.5 ${className}`}
    >
      <LanguageBadge language={nextLanguage} />
    </button>
  );
}
