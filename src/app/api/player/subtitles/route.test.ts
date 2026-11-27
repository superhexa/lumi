/** @jest-environment node */
import { deflateRawSync } from 'node:zlib';

import { GET } from '@/app/api/player/subtitles/route';

const SRT = [
  '1',
  '00:00:01,000 --> 00:00:03,000',
  'First line',
  '',
  '2',
  '00:00:04,500 --> 00:00:06,000',
  'Second line',
  '',
].join('\n');

const originalFetch = global.fetch;
const originalTmdbKey = process.env.TMDB_API_KEY;
const originalPublicTmdbKey = process.env.NEXT_PUBLIC_TMDB_API_KEY;
let fetchMock: jest.Mock;

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

async function gzip(text: string): Promise<ArrayBuffer> {
  const stream = new Blob([text])
    .stream()
    .pipeThrough(new CompressionStream('gzip'));
  return new Response(stream).arrayBuffer();
}

function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (let index = 0; index < bytes.length; index++) {
    crc ^= bytes[index];
    for (let bit = 0; bit < 8; bit++) {
      crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

/** Builds a minimal single-file ZIP using deflate, like YIFY serves. */
function buildZip(name: string, content: string): Uint8Array {
  const encoder = new TextEncoder();
  const nameBytes = encoder.encode(name);
  const raw = encoder.encode(content);
  const compressed = new Uint8Array(deflateRawSync(raw));
  const crc = crc32(raw);

  const local = new Uint8Array(30 + nameBytes.length + compressed.length);
  const localView = new DataView(local.buffer);
  localView.setUint32(0, 0x04034b50, true);
  localView.setUint16(4, 20, true);
  localView.setUint16(6, 0, true);
  localView.setUint16(8, 8, true);
  localView.setUint16(10, 0, true);
  localView.setUint16(12, 0, true);
  localView.setUint32(14, crc, true);
  localView.setUint32(18, compressed.length, true);
  localView.setUint32(22, raw.length, true);
  localView.setUint16(26, nameBytes.length, true);
  localView.setUint16(28, 0, true);
  local.set(nameBytes, 30);
  local.set(compressed, 30 + nameBytes.length);

  const central = new Uint8Array(46 + nameBytes.length);
  const centralView = new DataView(central.buffer);
  centralView.setUint32(0, 0x02014b50, true);
  centralView.setUint16(4, 20, true);
  centralView.setUint16(6, 20, true);
  centralView.setUint16(8, 0, true);
  centralView.setUint16(10, 8, true);
  centralView.setUint16(12, 0, true);
  centralView.setUint16(14, 0, true);
  centralView.setUint32(16, crc, true);
  centralView.setUint32(20, compressed.length, true);
  centralView.setUint32(24, raw.length, true);
  centralView.setUint16(28, nameBytes.length, true);
  centralView.setUint16(30, 0, true);
  centralView.setUint16(32, 0, true);
  centralView.setUint16(34, 0, true);
  centralView.setUint16(36, 0, true);
  centralView.setUint32(38, 0, true);
  centralView.setUint32(42, 0, true);
  central.set(nameBytes, 46);

  const eocd = new Uint8Array(22);
  const eocdView = new DataView(eocd.buffer);
  eocdView.setUint32(0, 0x06054b50, true);
  eocdView.setUint16(4, 0, true);
  eocdView.setUint16(6, 0, true);
  eocdView.setUint16(8, 1, true);
  eocdView.setUint16(10, 1, true);
  eocdView.setUint32(12, central.length, true);
  eocdView.setUint32(16, local.length, true);
  eocdView.setUint16(20, 0, true);

  const archive = new Uint8Array(local.length + central.length + eocd.length);
  archive.set(local, 0);
  archive.set(central, local.length);
  archive.set(eocd, local.length + central.length);
  return archive;
}

beforeEach(() => {
  fetchMock = jest.fn();
  global.fetch = fetchMock as unknown as typeof fetch;
  process.env.TMDB_API_KEY = '';
  process.env.NEXT_PUBLIC_TMDB_API_KEY = '';
});

afterAll(() => {
  global.fetch = originalFetch;
  process.env.TMDB_API_KEY = originalTmdbKey;
  process.env.NEXT_PUBLIC_TMDB_API_KEY = originalPublicTmdbKey;
});

describe('subtitle route', () => {
  it('rejects invalid TMDB ids', async () => {
    const response = await GET(
      new Request('http://localhost/api/player/subtitles?tmdbId=abc'),
    );
    expect(response.status).toBe(400);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('returns 404 when the title has no IMDb mapping', async () => {
    const response = await GET(
      new Request('http://localhost/api/player/subtitles?tmdbId=27205&lang=ar'),
    );
    expect(response.status).toBe(404);
  });

  it('returns parsed cues from the OpenSubtitles catalog', async () => {
    fetchMock.mockImplementation(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.startsWith('https://rest.opensubtitles.org/search')) {
        return jsonResponse([
          {
            SubFileName: 'Inception.2010.1080p.BluRay.srt',
            SubFormat: 'srt',
            SubDownloadLink: 'https://dl.opensubtitles.org/test-1.gz',
            SubDownloadsCnt: '120000',
            SubLanguageID: 'ara',
          },
        ]);
      }
      if (url.startsWith('https://opensubtitles-v3.strem.io')) {
        return jsonResponse({ subtitles: [] });
      }
      if (url === 'https://dl.opensubtitles.org/test-1.gz') {
        return new Response(await gzip(SRT), { status: 200 });
      }
      return new Response('not found', { status: 404 });
    });

    const response = await GET(
      new Request(
        'http://localhost/api/player/subtitles?tmdbId=27205&lang=ar&imdbId=tt1375666',
      ),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      ok: true,
      language: 'ar',
      cues: [
        { start: 1, end: 3, text: 'First line' },
        { start: 4.5, end: 6, text: 'Second line' },
      ],
      meta: { fileName: 'Inception.2010.1080p.BluRay.srt' },
    });
  });

  it('falls back to the Stremio catalog when REST has no matches', async () => {
    fetchMock.mockImplementation(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.startsWith('https://rest.opensubtitles.org/search')) {
        return jsonResponse([]);
      }
      if (url.startsWith('https://opensubtitles-v3.strem.io')) {
        return jsonResponse({
          subtitles: [
            {
              url: 'https://subs5.strem.io/en/download/test.srt',
              lang: 'eng',
              subtitleFileName: 'Inception.BluRay.srt',
              SubEncoding: 'UTF-8',
              g: '42',
            },
          ],
        });
      }
      if (url === 'https://subs5.strem.io/en/download/test.srt') {
        return new Response(SRT, { status: 200 });
      }
      return new Response('not found', { status: 404 });
    });

    const response = await GET(
      new Request(
        'http://localhost/api/player/subtitles?tmdbId=27205&lang=en&imdbId=tt1375667',
      ),
    );

    expect(response.status).toBe(200);
    const payload = (await response.json()) as {
      cues: unknown[];
      meta: { source: string };
    };
    expect(payload.cues).toHaveLength(2);
    expect(payload.meta.source).toBe('stremio');
  });

  it('returns 404 when no subtitle track can be read', async () => {
    fetchMock.mockImplementation(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.startsWith('https://rest.opensubtitles.org/search')) {
        return jsonResponse([
          {
            SubFileName: 'broken.srt',
            SubFormat: 'srt',
            SubDownloadLink: 'https://dl.opensubtitles.org/broken.gz',
            SubDownloadsCnt: '5',
          },
        ]);
      }
      if (url.startsWith('https://opensubtitles-v3.strem.io')) {
        return jsonResponse({ subtitles: [] });
      }
      if (url === 'https://dl.opensubtitles.org/broken.gz') {
        return new Response('this is not a subtitle file', { status: 200 });
      }
      return new Response('not found', { status: 404 });
    });

    const response = await GET(
      new Request(
        'http://localhost/api/player/subtitles?tmdbId=27205&lang=ar&imdbId=tt1375668',
      ),
    );
    expect(response.status).toBe(404);
  });

  it('ignores downloads from untrusted hosts', async () => {
    fetchMock.mockImplementation(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.startsWith('https://rest.opensubtitles.org/search')) {
        return jsonResponse([
          {
            SubFileName: 'evil.srt',
            SubFormat: 'srt',
            SubDownloadLink: 'https://evil.example.com/movie.gz',
            SubDownloadsCnt: '9',
          },
        ]);
      }
      if (url.startsWith('https://opensubtitles-v3.strem.io')) {
        return jsonResponse({ subtitles: [] });
      }
      return new Response(SRT, { status: 200 });
    });

    const response = await GET(
      new Request(
        'http://localhost/api/player/subtitles?tmdbId=27205&lang=en&imdbId=tt1375669',
      ),
    );
    expect(response.status).toBe(404);
  });

  it('extracts a ZIP subtitle from YIFY when the other catalogs are empty', async () => {
    const zip = buildZip('Test.Movie.2010.English.srt', SRT);

    fetchMock.mockImplementation((input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('rest.opensubtitles.org')) {
        return Promise.resolve(jsonResponse([]));
      }
      if (url.includes('opensubtitles-v3.strem.io')) {
        return Promise.resolve(jsonResponse({ subtitles: [] }));
      }
      if (url.includes('/movie-imdb/tt1234567')) {
        return Promise.resolve(
          new Response(
            '<a href="/subtitles/test-movie-2010-english-yify-123">English</a>',
            { status: 200, headers: { 'Content-Type': 'text/html' } },
          ),
        );
      }
      if (url.endsWith('/subtitle/test-movie-2010-english-yify-123.zip')) {
        return Promise.resolve(
          new Response(zip.buffer as ArrayBuffer, {
            status: 200,
            headers: { 'Content-Type': 'application/zip' },
          }),
        );
      }
      return Promise.resolve(new Response('not found', { status: 404 }));
    });

    const response = await GET(
      new Request(
        'https://luma.example/api/player/subtitles?tmdbId=123&type=movie&lang=en&imdbId=tt1234567',
      ),
    );

    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      cues: Array<{ text: string }>;
      meta: { source: string; fileName: string };
    };
    expect(body.meta.source).toBe('yifysubtitles');
    expect(body.meta.fileName).toContain('test-movie-2010-english');
    expect(body.cues.map((cue) => cue.text)).toEqual([
      'First line',
      'Second line',
    ]);
  });
});
