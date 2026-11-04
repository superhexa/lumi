/** @jest-environment node */
jest.mock('@/lib/torrent-bridge.server', () => {
  const BridgeUnavailable = class extends Error {
    constructor() {
      super('unavailable');
      this.name = 'BridgeUnavailableError';
    }
  };
  return {
    BridgeUnavailableError: BridgeUnavailable,
    ensureBridgeTorrent: jest.fn(async () => undefined),
    getBridgeStatus: jest.fn(() => null),
    hasBridgeTorrent: jest.fn(() => true),
    waitForBridgeMetadata: jest.fn(async () => undefined),
    openBridgeVideoStream: jest.fn(() => ({})),
    releaseBridgeTorrent: jest.fn(),
  };
});

jest.mock('@/lib/yts-torrents', () => ({
  fetchTorrentFile: jest.fn(async () => ({
    bytes: Uint8Array.from([0x64, 0x34, 0x3a, 0x69, 0x6e, 0x66, 0x6f]),
    filename: 'fake.torrent',
  })),
  fetchYtsTorrents: jest.fn(async () => null),
}));

import {
  BridgeUnavailableError,
  ensureBridgeTorrent,
  openBridgeVideoStream,
  releaseBridgeTorrent,
  waitForBridgeMetadata,
} from '@/lib/torrent-bridge.server';
import { fetchTorrentFile } from '@/lib/yts-torrents';

import { GET } from '@/app/api/download/bridge/route';

const HASH = '224BF45881252643DFC2E71ABC7B2660A21C68C4';
const mockedTorrentFetch = fetchTorrentFile as jest.MockedFunction<
  typeof fetchTorrentFile
>;
const mockedOpen = openBridgeVideoStream as jest.MockedFunction<
  typeof openBridgeVideoStream
>;
const mockedEnsure = ensureBridgeTorrent as jest.MockedFunction<
  typeof ensureBridgeTorrent
>;
const mockedWait = waitForBridgeMetadata as jest.MockedFunction<
  typeof waitForBridgeMetadata
>;

function jsonOf(payload: unknown): string {
  return JSON.stringify(payload);
}

describe('bridge route', () => {
  it('rejects invalid info hashes', async () => {
    const response = await GET(new Request('http://localhost/api/download/bridge?hash=zzz'));
    expect(response.status).toBe(400);
  });

  it('releases an active relay torrent', async () => {
    const response = await GET(
      new Request(`http://localhost/api/download/bridge?hash=${HASH}&act=release`),
    );
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ ok: true });
    expect(releaseBridgeTorrent).toHaveBeenCalledWith(HASH);
  });

  it('returns 502 when the .torrent metadata cannot be relayed', async () => {
    mockedTorrentFetch.mockResolvedValueOnce(null);
    const response = await GET(
      new Request(`http://localhost/api/download/bridge?hash=${HASH}&act=status`),
    );
    expect(response.status).toBe(502);
  });

  it('returns 503 when the bridge engine is unavailable', async () => {
    mockedTorrentFetch.mockResolvedValueOnce({
      bytes: new Uint8Array([0x64]),
      filename: 'fake.torrent',
    });
    mockedEnsure.mockRejectedValueOnce(new BridgeUnavailableError());
    const response = await GET(
      new Request(`http://localhost/api/download/bridge?hash=${HASH}&act=status`),
    );
    expect(response.status).toBe(503);
    expect(jsonOf(await response.json())).toContain('engine-unavailable');
  });

  it('answers status after the bridge torrent is ensured', async () => {
    mockedTorrentFetch.mockResolvedValueOnce({
      bytes: new Uint8Array([0x64]),
      filename: 'fake.torrent',
    });
    const response = await GET(
      new Request(`http://localhost/api/download/bridge?hash=${HASH}&act=status`),
    );
    expect(response.status).toBe(200);
    expect(mockedEnsure).toHaveBeenCalled();
    const payload = (await response.json()) as { ok: boolean; status: unknown };
    expect(payload.ok).toBe(true);
  });

  it('streams the video with download headers once metadata lands', async () => {
    mockedTorrentFetch.mockResolvedValueOnce({
      bytes: Uint8Array.from(
        'd8:announce11:udp://t.com4:infod4:name16:Inception (2010)12:piece lengthi262144e6:lengthi900000eee',
        (char) => char.charCodeAt(0),
      ),
      filename: 'fake.torrent',
    });
    const fakeStream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(Uint8Array.from([1, 2, 3]));
        controller.close();
      },
    });
    const encoded = (fakeStream as { fileName?: string }) as {
      stream: ReadableStream<Uint8Array>;
      fileName: string;
      length: number;
    };
    mockedOpen.mockImplementationOnce(
      () =>
        encoded &&
        ({
          stream: fakeStreamView(),
          fileName: 'Inception.2010.1080p.BrRip.x264.YIFY.mp4',
          length: 1_991_346_871,
        } as unknown as ReturnType<typeof openBridgeVideoStream>),
    );
    function fakeStreamView(): unknown {
      return fakeStream;
    }
    const response = await GET(
      new Request(`http://localhost/api/download/bridge?hash=${HASH}`),
    );
    expect(response.status).toBe(200);
    expect(mockedWait).toHaveBeenCalled();
    expect(response.headers.get('Content-Length')).toBe('1991346871');
    expect(response.headers.get('Content-Disposition')).toContain(
      encodeURIComponent('Inception (2010)'),
    );
    expect((await response.arrayBuffer()).byteLength).toBe(3);
  });

  it('returns 504 when metadata never lands on the swarm', async () => {
    mockedTorrentFetch.mockResolvedValueOnce({
      bytes: new Uint8Array([0x64]),
      filename: 'fake.torrent',
    });
    mockedWait.mockRejectedValueOnce(new Error('Timeout'));
    const response = await GET(
      new Request(`http://localhost/api/download/bridge?hash=${HASH}`),
    );
    expect(response.status).toBe(504);
  });
});
