/** @type {import('next').NextConfig} */
/* eslint-disable @typescript-eslint/no-var-requires */
const nextConfig = {
  output: 'standalone',
  eslint: {
    dirs: ['src'],
  },

  reactStrictMode: false,
  compiler: {
    styledComponents: true,
  },

  // Uncoment to add domain whitelist
  images: {
    unoptimized: true,
    remotePatterns: [
      {
        protocol: 'https',
        hostname: '**',
      },
      {
        protocol: 'http',
        hostname: '**',
      },
    ],
  },

  webpack(config) {
    // Grab the existing rule that handles SVG imports
    const fileLoaderRule = config.module.rules.find((rule) =>
      rule.test?.test?.('.svg'),
    );

    config.module.rules.push(
      // Reapply the existing rule, but only for svg imports ending in ?url
      {
        ...fileLoaderRule,
        test: /\.svg$/i,
        resourceQuery: /url/, // *.svg?url
      },
      // Convert all other *.svg imports to React components
      {
        test: /\.svg$/i,
        issuer: { not: /\.(css|scss|sass)$/ },
        resourceQuery: { not: /url/ }, // exclude if *.svg?url
        loader: '@svgr/webpack',
        options: {
          dimensions: false,
          titleProp: true,
        },
      },
    );

    // Modify the file loader rule to ignore *.svg, since we have it handled now.
    fileLoaderRule.exclude = /\.svg$/i;

    config.resolve.fallback = {
      ...config.resolve.fallback,
      net: false,
      tls: false,
      crypto: false,
    };

    return config;
  },
};

const defaultRuntimeCaching = require('next-pwa/cache');
const runtimeCaching = [
  {
    urlPattern: ({ request, url }) =>
      request.mode === 'navigate' && url.origin === self.location.origin,
    handler: 'NetworkFirst',
    options: {
      cacheName: 'lumi-pages',
      networkTimeoutSeconds: 3,
      expiration: {
        maxEntries: 50,
        maxAgeSeconds: 7 * 24 * 60 * 60,
      },
      plugins: [
        {
          handlerDidError: async () =>
            (await caches.match('/offline.html', { ignoreSearch: true })) ||
            Response.error(),
        },
      ],
    },
  },
  {
    urlPattern: ({ url, request }) =>
      request.destination === 'video' ||
      /\.(?:m3u8|mpd|m4s|ts|mp4|webm|aac|mp3)$/i.test(url.pathname),
    handler: 'NetworkOnly',
    options: {},
  },
  {
    urlPattern: ({ url }) =>
      url.origin === self.location.origin &&
      url.pathname.startsWith('/api/'),
    handler: 'NetworkOnly',
    options: {},
  },
  ...defaultRuntimeCaching,
];

const withPWA = require('next-pwa')({
  dest: 'public',
  disable: process.env.NODE_ENV === 'development',
  register: false,
  skipWaiting: false,
  clientsClaim: true,
  cleanupOutdatedCaches: true,
  cacheOnFrontEndNav: true,
  reloadOnOnline: false,
  publicExcludes: [
    '!noprecache/**/*',
    '!screenshot*.png',
    '!readme-login.png',
  ],
  maximumFileSizeToCacheInBytes: 2 * 1024 * 1024,
  runtimeCaching,
});

module.exports = withPWA(nextConfig);
