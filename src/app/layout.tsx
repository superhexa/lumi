import { Analytics } from '@vercel/analytics/next';
import type { Metadata, Viewport } from 'next';
import { Inter } from 'next/font/google';

import './globals.css';
import 'sweetalert2/dist/sweetalert2.min.css';

import { getConfig } from '@/lib/config';
import { DEFAULT_ANNOUNCEMENT } from '@/lib/legal';
import { DEFAULT_SITE_NAME } from '@/lib/project';

import { GlobalErrorIndicator } from '../components/GlobalErrorIndicator';
import { I18nProvider } from '../components/I18nProvider';
import { PwaManager } from '../components/PwaManager';
import { SiteProvider } from '../components/SiteProvider';
import { ThemeProvider } from '../components/ThemeProvider';

const inter = Inter({ subsets: ['latin'] });

// Generate metadata from the active site configuration.
export async function generateMetadata(): Promise<Metadata> {
  let siteName = process.env.SITE_NAME || DEFAULT_SITE_NAME;
  if (
    process.env.NEXT_PUBLIC_STORAGE_TYPE !== 'd1' &&
    process.env.NEXT_PUBLIC_STORAGE_TYPE !== 'upstash'
  ) {
    const config = await getConfig();
    siteName = config.SiteConfig.SiteName;
  }

  return {
    title: siteName,
    description: 'Movie and TV discovery',
    manifest: '/manifest.json',
    icons: {
      icon: [
        {
          url: '/icons/icon-192x192.png',
          sizes: '192x192',
          type: 'image/png',
        },
        { url: '/lumi.svg', type: 'image/svg+xml' },
      ],
      apple: [
        {
          url: '/icons/icon-180x180.png',
          sizes: '180x180',
          type: 'image/png',
        },
      ],
    },
    appleWebApp: {
      capable: true,
      statusBarStyle: 'black-translucent',
      title: siteName,
    },
  };
}

export const viewport: Viewport = {
  themeColor: '#080d18',
  viewportFit: 'cover',
};

export default async function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  let siteName = process.env.SITE_NAME || DEFAULT_SITE_NAME;
  let announcement = process.env.ANNOUNCEMENT || DEFAULT_ANNOUNCEMENT;
  if (
    process.env.NEXT_PUBLIC_STORAGE_TYPE !== 'd1' &&
    process.env.NEXT_PUBLIC_STORAGE_TYPE !== 'upstash'
  ) {
    const config = await getConfig();
    siteName = config.SiteConfig.SiteName;
    announcement = config.SiteConfig.Announcement;
  }

  const runtimeConfig = {
    STORAGE_TYPE: process.env.NEXT_PUBLIC_STORAGE_TYPE || 'localstorage',
  };

  return (
    <html lang='en' suppressHydrationWarning>
      <head>
        <meta
          name='viewport'
          content='width=device-width, initial-scale=1.0, viewport-fit=cover'
        />
        {/* Serialize runtime flags directly into the initial document. */}
        {/* eslint-disable-next-line @next/next/no-sync-scripts */}
        <script
          dangerouslySetInnerHTML={{
            __html: `window.RUNTIME_CONFIG = ${JSON.stringify(runtimeConfig)};`,
          }}
        />
      </head>
      <body
        className={`${inter.className} min-h-screen bg-[#080d18] text-slate-100`}
      >
        <ThemeProvider
          attribute='class'
          defaultTheme='dark'
          enableSystem={false}
          forcedTheme='dark'
          disableTransitionOnChange
        >
          <I18nProvider>
            <SiteProvider siteName={siteName} announcement={announcement}>
              {children}
              <GlobalErrorIndicator />
              <PwaManager />
            </SiteProvider>
          </I18nProvider>
        </ThemeProvider>
        <Analytics />
      </body>
    </html>
  );
}
