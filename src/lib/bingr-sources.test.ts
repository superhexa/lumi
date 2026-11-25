/** @jest-environment node */

import {
  type BingrSourcesPayload,
  decodeBingrSealedPayload,
  extractBingrWatchToken,
  rankBingrStreams,
} from './bingr-sources';

const TV_PAYLOAD =
  'v1.ReB4_yID-qEO80tlxWEUcGIWdpHF2ItfezA2z4RNpagWYOKaNRtuXq315x1u2uLOosmjx-IeSG4gD_M0_e4j2XtTiPNSN7UNCw9snrNPqynyvSLIDlSVrtc_e0YPSzZ7e7oX5pDhPUYAsMrimQo_Uou-gRewpbhYlT6Cen9Im_BC90bOvVLuYuwGXx5Q0ypvRTag9hwivPYDnpNWNmAdZVlEP6uJqz1vHBWmagzGOGX2i28wRB-Qxm02zW-zbAuuQkoJ8bdQ0HRUVI5TFCx3JK56HRwBe5lEu1YKBTVrvrfEGoQTNGTB61co-w9H6YnMEcXjKvJUO-I4FExLdYIstdez3hB6-GL6VoilcH44GrQpw7ZVUNgUQd2T6ZEMPPH9PRARFks6sZcO5d263bnGWPyywMkbuaRqn8DdLbGiFcUlhIhZZKFJXLTutkl-jYHJyONI4SxHa63cTVqtSqN_-ZHKxORnGlN4glr-SRG7l3dL-D3bWYvQmdCVPUTraR4rzULIlC16B-GFcMYesSz3-vom7HT0ZYVjN0pZsOt_WG_MARcB8Hrd95bLnissu6pyGUunpLNUvJzhia-ONRL7pNWaJU7xLyrWUWJZNX64EaZlC8ANeSTBu8vByiKjODxJvRwUUhtVfmN4zktEN3nEoMPrhyLc9evBLE-dEjXdG8O2fo-mj1rFSxteL4ldvuNZMnQovqX6fODViG9JrzIAYb8E-Bgpfg';

describe('decodeBingrSealedPayload', () => {
  it('decodes the sealed /api/sources response', () => {
    const payload = decodeBingrSealedPayload<BingrSourcesPayload>(TV_PAYLOAD);
    expect(payload.provider?.label).toBe('Edge');
    expect(payload.servers?.map((server) => server.label)).toEqual([
      'Edge',
      'Comet',
      'Flux',
      'Nimbus',
      'Citadel',
    ]);
    expect(payload.streams?.[0]?.url).toContain('rousav.tech');
  });

  it('rejects payloads that are not sealed', () => {
    expect(() => decodeBingrSealedPayload('{"ok":true}')).toThrow();
  });
});

describe('extractBingrWatchToken', () => {
  it('reads a plain JSON token', () => {
    expect(extractBingrWatchToken('{"token":"abc.def"}')).toBe('abc.def');
  });

  it('reads an escaped RSC token', () => {
    expect(
      extractBingrWatchToken('self.__next_f.push(["$","{\\"token\\":\\"xyz.123\\"}"])'),
    ).toBe('xyz.123');
  });

  it('ignores the Cloudflare beacon token', () => {
    expect(
      extractBingrWatchToken(
        `data-cf-beacon='{"token":"bd80b65d65ba429c9030b9418c153372"}'; "sealed":"$22","token":"mwv66643.XAUXsGR5"`,
      ),
    ).toBe('mwv66643.XAUXsGR5');
  });

  it('returns null when no token exists', () => {
    expect(extractBingrWatchToken('<html></html>')).toBeNull();
  });
});

describe('rankBingrStreams', () => {
  it('prefers H.264 1080p streams over HEVC and lower qualities', () => {
    const ranked = rankBingrStreams([
      {
        url: 'https://sacdn.hakunaymatata.com/dash/h265/master.m3u8',
        quality: '1080p',
        label: 'HEVC',
      },
      {
        url: 'https://img.rousav.tech/media/abc/index.m3u8',
        quality: '720p',
        label: 'Edge',
      },
      {
        url: 'https://img1.hscow.com/hls/1080/index.m3u8',
        quality: '1080p',
        label: 'Original',
      },
      { url: 'https://example.com/not-a-playlist.mp4' },
    ]);

    expect(ranked.map((stream) => stream.label)).toEqual([
      'Original',
      'Edge',
      'HEVC',
    ]);
  });
});
