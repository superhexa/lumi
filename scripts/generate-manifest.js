#!/usr/bin/env node
/* eslint-disable */
// 根据 SITE_NAME 动态生成 manifest.json

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

// 获取项目根目录
const projectRoot = path.resolve(__dirname, '..');
const publicDir = path.join(projectRoot, 'public');
const manifestPath = path.join(publicDir, 'manifest.json');
const iconDir = path.join(publicDir, 'icons');

function createPngIcon(size) {
  const scale = size / 512;
  const pixels = Buffer.alloc(size * size * 4);
  const pixel = (x, y, color) => {
    const index = (y * size + x) * 4;
    pixels[index] = color[0];
    pixels[index + 1] = color[1];
    pixels[index + 2] = color[2];
    pixels[index + 3] = 255;
  };
  const insideRoundedRect = (x, y, left, top, right, bottom, radius) => {
    const centerX = Math.max(left + radius, Math.min(x, right - radius));
    const centerY = Math.max(top + radius, Math.min(y, bottom - radius));
    return (x - centerX) ** 2 + (y - centerY) ** 2 <= radius ** 2;
  };
  const strokeLine = (x1, y1, x2, y2, width, color) => {
    const left = Math.max(0, Math.floor(Math.min(x1, x2) - width));
    const right = Math.min(size, Math.ceil(Math.max(x1, x2) + width));
    const top = Math.max(0, Math.floor(Math.min(y1, y2) - width));
    const bottom = Math.min(size, Math.ceil(Math.max(y1, y2) + width));
    const dx = x2 - x1;
    const dy = y2 - y1;
    const lengthSquared = dx * dx + dy * dy;

    for (let y = top; y < bottom; y += 1) {
      for (let x = left; x < right; x += 1) {
        const progress =
          lengthSquared === 0
            ? 0
            : Math.max(
                0,
                Math.min(1, ((x - x1) * dx + (y - y1) * dy) / lengthSquared),
              );
        const distance = Math.hypot(
          x - (x1 + progress * dx),
          y - (y1 + progress * dy),
        );
        if (distance <= width / 2) pixel(x, y, color);
      }
    }
  };

  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const progress = (x + y) / (2 * size);
      const glow = Math.max(
        0,
        1 - Math.hypot(x - size * 0.2, y - size * 0.08) / (size * 0.72),
      );
      pixel(x, y, [
        Math.round(23 * (1 - progress) + 8 * progress + 30 * glow),
        Math.round(37 * (1 - progress) + 13 * progress + 7 * glow),
        Math.round(84 * (1 - progress) + 24 * progress + 13 * glow),
      ]);
    }
  }

  const strokeColor = [199, 210, 224];
  const left = 96 * scale;
  const top = 104 * scale;
  const right = 416 * scale;
  const bottom = 408 * scale;
  const radius = 80 * scale;
  const lineWidth = 10 * scale;

  for (let y = Math.floor(top); y < Math.ceil(bottom); y += 1) {
    for (let x = Math.floor(left); x < Math.ceil(right); x += 1) {
      const outer = insideRoundedRect(
        x + 0.5,
        y + 0.5,
        left,
        top,
        right,
        bottom,
        radius,
      );
      const inner = insideRoundedRect(
        x + 0.5,
        y + 0.5,
        left + lineWidth,
        top + lineWidth,
        right - lineWidth,
        bottom - lineWidth,
        radius - lineWidth,
      );
      if (outer && !inner) pixel(x, y, strokeColor);
    }
  }

  const centerX = 256 * scale;
  const centerY = 336 * scale;
  const sunRadius = 96 * scale;
  for (let y = Math.floor(centerY - sunRadius); y < centerY; y += 1) {
    for (
      let x = Math.floor(centerX - sunRadius);
      x < centerX + sunRadius;
      x += 1
    ) {
      const distance = Math.hypot(x + 0.5 - centerX, y + 0.5 - centerY);
      if (distance <= sunRadius) {
        const progress = (y - (centerY - sunRadius)) / sunRadius;
        pixel(x, y, [
          Math.round(199 * (1 - progress) + 251 * progress),
          Math.round(210 * (1 - progress) + 113 * progress),
          Math.round(224 * (1 - progress) + 133 * progress),
        ]);
      }
    }
  }

  const ray = (x1, y1, x2, y2, width = 8) =>
    strokeLine(
      x1 * scale,
      y1 * scale,
      x2 * scale,
      y2 * scale,
      width * scale,
      strokeColor,
    );
  ray(256, 200, 256, 310);
  ray(184, 214, 168, 198);
  ray(328, 214, 344, 198);
  ray(142, 264, 166, 264);
  ray(370, 264, 394, 264);

  const raw = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y += 1) {
    const rowStart = y * (size * 4 + 1);
    raw[rowStart] = 0;
    pixels.copy(raw, rowStart + 1, y * size * 4, (y + 1) * size * 4);
  }

  const chunk = (type, data) => {
    const output = Buffer.alloc(data.length + 12);
    output.writeUInt32BE(data.length, 0);
    output.write(type, 4);
    data.copy(output, 8);
    let crc = 0xffffffff;
    for (let index = 4; index < data.length + 8; index += 1) {
      crc ^= output[index];
      for (let bit = 0; bit < 8; bit += 1) {
        crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
      }
    }
    output.writeUInt32BE((crc ^ 0xffffffff) >>> 0, data.length + 8);
    return output;
  };

  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0);
  header.writeUInt32BE(size, 4);
  header[8] = 8;
  header[9] = 6;

  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', header),
    chunk('IDAT', zlib.deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

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
      src: '/icons/icon-192x192.png',
      sizes: '192x192',
      type: 'image/png',
      purpose: 'any',
    },
    {
      src: '/icons/icon-512x512.png',
      sizes: '512x512',
      type: 'image/png',
      purpose: 'any maskable',
    },
    {
      src: '/lumi.svg',
      sizes: 'any',
      type: 'image/svg+xml',
      purpose: 'any',
    },
  ],
  shortcuts: [
    {
      name: 'Discover movies',
      short_name: 'Movies',
      url: '/discover?type=movie',
      icons: [
        {
          src: '/icons/icon-192x192.png',
          sizes: '192x192',
          type: 'image/png',
        },
      ],
    },
    {
      name: 'My library',
      short_name: 'Library',
      url: '/my',
      icons: [
        {
          src: '/icons/icon-192x192.png',
          sizes: '192x192',
          type: 'image/png',
        },
      ],
    },
  ],
};

try {
  // 确保 public 目录存在
  if (!fs.existsSync(publicDir)) {
    fs.mkdirSync(publicDir, { recursive: true });
  }

  fs.mkdirSync(iconDir, { recursive: true });
  for (const size of [180, 192, 256, 384, 512]) {
    fs.writeFileSync(
      path.join(iconDir, `icon-${size}x${size}.png`),
      createPngIcon(size),
    );
  }

  // 写入 manifest.json
  fs.writeFileSync(manifestPath, JSON.stringify(manifestTemplate, null, 2));
  console.log(`✅ Generated manifest.json with site name: ${siteName}`);
} catch (error) {
  console.error('❌ Error generating manifest.json:', error);
  process.exit(1);
}
