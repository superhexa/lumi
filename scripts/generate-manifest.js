#!/usr/bin/env node
/* eslint-disable */
// 根据 SITE_NAME 动态生成 manifest.json

const fs = require('fs');
const path = require('path');

// 获取项目根目录
const projectRoot = path.resolve(__dirname, '..');
const publicDir = path.join(projectRoot, 'public');
const manifestPath = path.join(publicDir, 'manifest.json');

// 从环境变量获取站点名称
const siteName = process.env.SITE_NAME || 'Lumi';

// manifest.json 模板
const manifestTemplate = {
  id: '/',
  name: siteName,
  short_name: 'Lumi',
  description: 'Movie and TV discovery',
  start_url: '/',
  scope: '/',
  display_override: ['standalone', 'minimal-ui', 'browser'],
  display: 'standalone',
  background_color: '#080d18',
  theme_color: '#080d18',
  orientation: 'any',
  categories: ['entertainment', 'movies', 'lifestyle'],
  prefer_related_applications: false,
  'apple-mobile-web-app-capable': 'yes',
  'apple-mobile-web-app-status-bar-style': 'black-translucent',
  icons: [
    {
      src: '/lumi.svg',
      sizes: 'any',
      type: 'image/svg+xml',
      purpose: 'any maskable',
    },
  ],
  shortcuts: [
    {
      name: 'Discover movies',
      short_name: 'Movies',
      url: '/discover?type=movie',
      icons: [{ src: '/lumi.svg', sizes: 'any', type: 'image/svg+xml' }],
    },
    {
      name: 'My library',
      short_name: 'Library',
      url: '/my',
      icons: [{ src: '/lumi.svg', sizes: 'any', type: 'image/svg+xml' }],
    },
  ],
};

try {
  // 确保 public 目录存在
  if (!fs.existsSync(publicDir)) {
    fs.mkdirSync(publicDir, { recursive: true });
  }

  // 写入 manifest.json
  fs.writeFileSync(manifestPath, JSON.stringify(manifestTemplate, null, 2));
  console.log(`✅ Generated manifest.json with site name: ${siteName}`);
} catch (error) {
  console.error('❌ Error generating manifest.json:', error);
  process.exit(1);
}
