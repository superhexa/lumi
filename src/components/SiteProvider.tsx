'use client';

import { createContext, ReactNode, useContext } from 'react';

import { DEFAULT_ANNOUNCEMENT } from '@/lib/legal';
import { DEFAULT_SITE_NAME } from '@/lib/project';

const SiteContext = createContext<{ siteName: string; announcement?: string }>({
  // 默认值
  siteName: DEFAULT_SITE_NAME,
  announcement: DEFAULT_ANNOUNCEMENT,
});

export const useSite = () => useContext(SiteContext);

export function SiteProvider({
  children,
  siteName,
  announcement,
}: {
  children: ReactNode;
  siteName: string;
  announcement?: string;
}) {
  return (
    <SiteContext.Provider value={{ siteName, announcement }}>
      {children}
    </SiteContext.Provider>
  );
}
