import {
  buildBridgeReleaseUrl,
  buildBridgeStatusUrl,
  buildBridgeStreamUrl,
  buildMagnetFromTorrent,
  computeTorrentSaveFileName,
  formatBytes,
  getTorrentDisplayName,
} from '@/lib/movie-download.client';

// jsdom lacks TextEncoder; charCodeAt is sufficient for ASCII torrent
// fixtures (the bencode decode tests cover non-ASCII separately).
function bytes(input: string): Uint8Array {
  return Uint8Array.from(input, (char) => char.charCodeAt(0));
}

const TORRENT_FIXTURE =
  'd13:announce-listll20:udp://alpha.com:696920:udp://bravo.com:6969ee4:infod4:name16:Inception (2010)12:piece lengthi1024e5:filesld6:lengthi10e4:pathl9:movie.mkveeeee';

describe('buildMagnetFromTorrent', () => {
  it('includes the info hash, uri-encoded name and every tracker', () => {
    const magnet = buildMagnetFromTorrent(
      bytes(TORRENT_FIXTURE),
      '224BF45881252643DFC2E71ABC7B2660A21C68C4',
      'fallback',
    );
    expect(magnet).toBe(
      'magnet:?xt=urn:btih:224BF45881252643DFC2E71ABC7B2660A21C68C4' +
        '&dn=Inception%20(2010)' +
        '&tr=udp%3A%2F%2Falpha.com%3A6969' +
        '&tr=udp%3A%2F%2Fbravo.com%3A6969',
    );
  });

  it('falls back to the provided name and omits xt when no hash is known', () => {
    const magnet = buildMagnetFromTorrent(
      bytes(''),
      undefined,
      'Inception (2010) 1080p',
    );
    expect(magnet).toBe(
      'magnet:?dn=Inception%20(2010)%201080p',
    );
  });

  it('still builds a usable magnet without the hash but with trackers', () => {
    const magnet = buildMagnetFromTorrent(
      bytes(TORRENT_FIXTURE),
      undefined,
      'fallback',
    );
    expect(magnet).toContain('magnet:?dn=Inception%20(2010)');
    expect(magnet).toContain('&tr=udp%3A%2F%2Falpha.com%3A6969');
  });
});

describe('computeTorrentSaveFileName', () => {
  it('combines title and quality into a safe .torrent name', () => {
    expect(computeTorrentSaveFileName('Inception', '1080p')).toBe(
      'Inception 1080p.torrent',
    );
  });

  it('sanitizes characters unusable in file pickers', () => {
    expect(computeTorrentSaveFileName('Movie: The/Prequel')).toBe(
      'Movie_ The_Prequel.torrent',
    );
  });

  it('falls back to a generic name when everything is empty', () => {
    expect(computeTorrentSaveFileName('  ')).toBe('movie.torrent');
  });
});

describe('getTorrentDisplayName', () => {
  it('prefers the largest video file inside the torrent', () => {
    const name = getTorrentDisplayName(bytes(TORRENT_FIXTURE), 'fallback');
    expect(name).toBe('movie.mkv');
  });

  it('returns the fallback for unreadable payload', () => {
    expect(getTorrentDisplayName(bytes('nonsense'), 'fallback')).toBe(
      'fallback',
    );
  });
});

describe('formatBytes', () => {
  it('formats human sizes', () => {
    expect(formatBytes(0)).toBe('0 MB');
    expect(formatBytes(1024)).toBe('1.0 KB');
    expect(formatBytes(1_572_864)).toBe('1.5 MB');
    expect(formatBytes(1_991_346_871)).toBe('1.9 GB');
  });
});

describe('bridge url builders', () => {
  it('targets the relay bridge endpoints with the given info hash', () => {
    const hash = '224BF45881252643DFC2E71ABC7B2660A21C68C4';
    expect(buildBridgeStreamUrl(hash)).toBe(
      `/api/download/bridge?hash=${hash}&act=stream`,
    );
    expect(buildBridgeStatusUrl(hash)).toBe(
      `/api/download/bridge?hash=${hash}&act=status`,
    );
    expect(buildBridgeReleaseUrl(hash)).toBe(
      `/api/download/bridge?hash=${hash}&act=release`,
    );
  });
});
