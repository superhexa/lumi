/* eslint-disable react-hooks/exhaustive-deps, no-console */

'use client';

import { ShieldAlert } from 'lucide-react';
import { Suspense, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { DEFAULT_ANNOUNCEMENT } from '@/lib/legal';

import ContinueWatching from '@/components/ContinueWatching';
import {
  glassDialogPrimaryActionClass,
  glassDisclaimerDialogContentClass,
} from '@/components/dialogStyles';
import HomeCuratedRows from '@/components/HomeCuratedRows';
import HomeRecommendedHero from '@/components/HomeRecommendedHero';
import PageLayout from '@/components/PageLayout';
import { useSite } from '@/components/SiteProvider';
import TopRatedRankedRows from '@/components/TopRatedRankedRows';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';

function splitAnnouncementParagraphs(text: string) {
  const normalized = text.trim();
  if (!normalized) return [];

  if (normalized.includes('\n')) {
    return normalized
      .split(/\n{2,}|\n/)
      .map((item) => item.trim())
      .filter(Boolean);
  }

  const sentences = normalized.match(
    /[^\u3002\uff01\uff1f.!?]+[\u3002\uff01\uff1f.!?]?/g,
  ) || [normalized];
  if (sentences.length <= 2) return [normalized];

  const paragraphs: string[] = [];
  for (let i = 0; i < sentences.length; i += 2) {
    paragraphs.push(sentences.slice(i, i + 2).join(''));
  }
  return paragraphs;
}

function HomeClient() {
  const { t } = useTranslation();
  const { announcement, siteName } = useSite();
  const [showAnnouncement, setShowAnnouncement] = useState(false);
  const announcementText =
    announcement === DEFAULT_ANNOUNCEMENT
      ? t('legal.defaultAnnouncement')
      : announcement;
  const announcementParagraphs = splitAnnouncementParagraphs(
    announcementText || '',
  );

  useEffect(() => {
    if (typeof window !== 'undefined' && announcement) {
      const hasSeenAnnouncement = localStorage.getItem('hasSeenAnnouncement');
      if (hasSeenAnnouncement !== announcement) {
        setShowAnnouncement(true);
      } else {
        setShowAnnouncement(Boolean(!hasSeenAnnouncement && announcement));
      }
    }
  }, [announcement]);

  const handleCloseAnnouncement = (value: string) => {
    setShowAnnouncement(false);
    localStorage.setItem('hasSeenAnnouncement', value);
  };

  return (
    <PageLayout showDesktopTopSearch disableMobileTopPadding>
      <div className='overflow-visible px-0 pb-4 sm:px-10 sm:pb-8'>
        <div className='px-2 sm:px-0'>
          <HomeRecommendedHero />
        </div>

        <div className='mt-8 px-4 sm:px-0'>
          <ContinueWatching />
          <TopRatedRankedRows />
          <HomeCuratedRows />
        </div>
      </div>

      <footer className='mx-4 flex flex-col gap-3 border-t border-[var(--ui-glass-divider)] px-2 py-7 text-sm sm:mx-10 sm:flex-row sm:items-center sm:justify-between sm:px-0'>
        <div>
          <p className='font-semibold tracking-wide text-[var(--ui-text-primary)]'>
            {siteName}
          </p>
          <p className='mt-1 text-xs text-[var(--ui-text-muted)]'>
            {t('common.homeTagline')}
          </p>
        </div>
        <a
          href='https://t.me/decimalvalue'
          target='_blank'
          rel='noreferrer'
          className='inline-flex w-fit items-center gap-1.5 text-xs text-[var(--ui-text-muted)] transition-colors hover:text-[var(--ui-highlight)]'
        >
          <span>{t('common.developedBy')}</span>
          <span className='font-semibold text-[var(--ui-highlight)]'>Bit</span>
          <span>@decimalvalue</span>
        </a>
      </footer>

      {announcement && (
        <AlertDialog
          open={showAnnouncement}
          onOpenChange={(open) => {
            if (!open) handleCloseAnnouncement(announcement);
          }}
        >
          <AlertDialogContent className={glassDisclaimerDialogContentClass}>
            <AlertDialogHeader className='space-y-3'>
              <div className='flex items-center gap-3'>
                <span className='inline-flex h-10 w-10 items-center justify-center rounded-[var(--ui-radius-row)] bg-red-500/15 text-red-400'>
                  <ShieldAlert className='h-5 w-5' />
                </span>
                <AlertDialogTitle className='text-xl text-[var(--ui-text-strong)]'>
                  {t('common.disclaimer')}
                </AlertDialogTitle>
              </div>
              <AlertDialogDescription asChild>
                <div className='max-h-[46vh] space-y-3 overflow-y-auto pr-1 text-sm leading-6 text-[var(--ui-text-muted)]'>
                  {announcementParagraphs.map((paragraph, index) => (
                    <p key={`announcement-${index}`}>{paragraph}</p>
                  ))}
                </div>
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter className='mt-2 flex-col gap-2 sm:flex-col sm:gap-2'>
              <AlertDialogAction
                onClick={() => handleCloseAnnouncement(announcement)}
                className={`w-full ${glassDialogPrimaryActionClass}`}
              >
                {t('common.iUnderstand')}
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      )}
    </PageLayout>
  );
}

export default function Home() {
  return (
    <Suspense>
      <HomeClient />
    </Suspense>
  );
}
