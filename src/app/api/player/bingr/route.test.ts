/** @jest-environment node */
import { GET } from './route';

const SEALED_KEY = 'vY7#qL2!mZ9@wK4$';

/**
 * Mirrors the decoder in `@/lib/bingr-sources` so the tests can build the
 * obfuscated `/api/sources` responses Bingr really returns.
 */
function sealPayload(value: unknown): string {
  const data = new TextEncoder().encode(JSON.stringify(value));
  const nonce = new Uint8Array(12).fill(7);
  const bytes = new Uint8Array(nonce.length + data.length);
  bytes.set(nonce, 0);
  bytes.set(data, nonce.length);

  const [state0, state1, state2, state3] = [0, 1, 2, 3].map((index) => {
    let hash = (0x811c9dc5 ^ (0x9e3779b9 * index)) >>> 0;
    for (let position = 0; position < SEALED_KEY.length; position++) {
      hash = Math.imul(hash ^ SEALED_KEY.charCodeAt(position), 0x1000193) >>> 0;
    }
    for (let position = 0; position < nonce.length; position++) {
      hash = Math.imul(hash ^ nonce[position], 0x1000193) >>> 0;
    }
    return hash;
  });

  let k0 = state0;
  let k1 = state1;
  let k2 = state2;
  let k3 = state3;
  let mask = 0;

  for (let index = 0; index < data.length; index++) {
    if ((index & 3) === 0) {
      k0 >>>= 0;
      k1 >>>= 0;
      let next = (k0 + k1) | 0;
      k0 = k1 ^ (k1 >>> 9);
      k1 = (k2 + (k2 << 3)) | 0;
      k2 = (k2 << 21) | (k2 >>> 11);
      k3 = (k3 + 1) | 0;
      next = (next + k3) | 0;
      k2 = (k2 + next) | 0;
      mask = next >>> 0;
    }
    bytes[nonce.length + index] ^= (mask >>> ((index & 3) * 8)) & 255;
  }

  return `v1.${Buffer.from(bytes).toString('base64url')}`;
}

const WATCH_HTML =
  '<html><script>self.__next_f.push(["$","{\\"token\\":\\"mwv66643.XAUXsGR5\\"}"])</script></html>';

describe('Bingr resolver', () => {
  const originalFetch = global.fetch;
  const fetchMock = jest.fn();
  beforeEach(() => {
    global.fetch = fetchMock;
    fetchMock.mockReset();
  });
  afterAll(() => {
    global.fetch = originalFetch;
  });

  it('rejects invalid content IDs before querying a provider', async () => {
    const response = await GET(
      new Request(
        'https://luma.example/api/player/bingr?tmdbId=1%2F..%2Fadmin',
      ),
    );
    expect(response.status).toBe(400);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('resolves an H.264 stream from the sealed source list', async () => {
    fetchMock
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ title: 'Westworld', year: '2016' })),
      )
      .mockResolvedValueOnce(new Response(WATCH_HTML))
      .mockResolvedValueOnce(
        new Response(
          sealPayload({
            provider: { id: 's31', label: 'Edge' },
            servers: [{ id: 's40', label: 'Comet' }],
            streams: [
              {
                url: 'https://sacdn.hakunaymatata.com/dash/h265/master.m3u8',
                type: 'hls',
                quality: '1080p',
                label: 'HEVC',
              },
              {
                url: 'https://img.rousav.tech/media/abc/index.m3u8',
                type: 'hls',
                quality: '1080p',
                label: 'Edge',
              },
            ],
          }),
        ),
      )
      .mockResolvedValueOnce(
        new Response('#EXTM3U\n#EXT-X-VERSION:3\n', {
          headers: { 'Content-Type': 'application/vnd.apple.mpegurl' },
        }),
      );

    const response = await GET(
      new Request(
        'https://luma.example/api/player/bingr?tmdbId=63247&type=tv&season=2&episode=1',
      ),
    );

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.title).toBe('Westworld');
    expect(body.streamUrl).toContain('/api/player/media?url=');
    expect(decodeURIComponent(body.streamUrl)).toContain(
      'https://img.rousav.tech/media/abc/index.m3u8',
    );

    const calls = fetchMock.mock.calls.map((call) => String(call[0]));
    expect(calls[0]).toBe('https://api.bingr.one/api/details/tv/63247');
    expect(calls[1]).toBe('https://bingr.one/watch/tv/63247/2/1');
    expect(calls[2]).toContain('https://bingr.one/api/sources?');
    expect(calls[2]).toContain('hevc=0');
    expect(calls[3]).toBe('https://img.rousav.tech/media/abc/index.m3u8');
  });

  it('reports a failure without exposing the provider response', async () => {
    fetchMock.mockResolvedValue(
      new Response('private upstream body', { status: 403 }),
    );
    const response = await GET(
      new Request('https://luma.example/api/player/bingr?tmdbId=550'),
    );
    const data = await response.json();
    expect(response.status).toBe(502);
    expect(typeof data.code).toBe('string');
    expect(JSON.stringify(data)).not.toContain('private upstream body');
  });

  it('rejects provider results that point to private or unknown hosts', async () => {
    fetchMock
      .mockResolvedValueOnce(new Response(JSON.stringify({ title: 'Test' })))
      .mockResolvedValueOnce(new Response(WATCH_HTML))
      .mockResolvedValueOnce(
        new Response(
          sealPayload({
            provider: { id: 's31', label: 'Edge' },
            servers: [{ id: 's40', label: 'Comet' }],
            streams: [
              { url: 'https://127.0.0.1/master.m3u8', type: 'hls' },
            ],
          }),
        ),
      )
      .mockResolvedValue(new Response('nope', { status: 404 }));

    const response = await GET(
      new Request('https://luma.example/api/player/bingr?tmdbId=550'),
    );
    expect(response.status).toBe(502);
    expect(fetchMock.mock.calls.length).toBeGreaterThanOrEqual(3);
    const body = JSON.stringify(await response.json());
    expect(body).not.toContain('127.0.0.1');
  });
});
