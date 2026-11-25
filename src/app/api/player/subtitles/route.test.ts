/** @jest-environment node */
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
      new Request(
        'http://localhost/api/player/subtitles?tmdbId=27205&lang=ar',
      ),
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
});
