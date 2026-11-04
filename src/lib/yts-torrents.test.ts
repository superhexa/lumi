import {
  buildMagnetUri,
  fetchYtsTorrents,
  normalizeTorrentHash,
  pickBestMovieMatch,
} from '@/lib/yts-torrents';

const moviePayload = {
  status: 'ok',
  data: {
    movie: {
      title_long: 'Inception (2010)',
      title: 'Inception',
      year: 2010,
      imdb_code: 'tt1375666',
      medium_cover_image: 'https://yts.gg/medium-cover.jpg',
      torrents: [
        {
          quality: '1080p',
          size: '1.85 GB',
          filesize_bytes: 1986000000,
          hash: '224BF45881252643DFC2E71ABC7B2660A21C68C4',
          name: 'Inception.2010.1080p.BluRay',
          seeds: 1200,
          peers: 90,
          url: 'https://yts.gg/torrent/download/224BF45881252643DFC2E71ABC7B2660A21C68C4',
        },
        { quality: '2160p', size: '6.6 GB', hash: 'invalid', seeds: 5 },
      ],
    },
  },
};

describe('normalizeTorrentHash', () => {
  it('accepts 40-char hex hashes and preserves their case', () => {
    expect(normalizeTorrentHash('ABCDEF0123456789ABCDEF0123456789ABCDEF01')).toBe(
      'ABCDEF0123456789ABCDEF0123456789ABCDEF01',
    );
    expect(normalizeTorrentHash('abcdef0123456789abcdef0123456789abcdef01')).toBe(
      'abcdef0123456789abcdef0123456789abcdef01',
    );
  });

  it('rejects invalid hashes', () => {
    expect(normalizeTorrentHash('short')).toBe('');
    expect(normalizeTorrentHash('')).toBe('');
    expect(normalizeTorrentHash(undefined)).toBe('');
    expect(normalizeTorrentHash('g123456789012345678901234567890123456789')).toBe('');
  });
});

describe('buildMagnetUri', () => {
  it('builds a display-name magnet', () => {
    expect(buildMagnetUri('abc123'.padEnd(40, '0'), 'Inception (2010)')).toBe(
      `magnet:?xt=urn:btih:${'abc123'.padEnd(40, '0')}&dn=Inception%20(2010)`,
    );
  });
});

describe('pickBestMovieMatch', () => {
  const movies = [
    { title: 'Inception', year: 2010 },
    { title: 'Inception', year: 1995 },
    { title: 'Inception', year: 2015 },
  ];

  it('prefers the exact year', () => {
    expect(pickBestMovieMatch(movies, '2010')?.year).toBe(2010);
  });

  it('falls back to the nearest year and then the first item', () => {
    expect(pickBestMovieMatch(movies, '2012')?.year).toBe(2010);
    expect(pickBestMovieMatch(movies, '')?.year).toBe(2010);
  });
});

describe('fetchYtsTorrents', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('uses movie_details.json with an imdb id and normalizes torrents', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve(moviePayload),
    });

    const result = await fetchYtsTorrents({ imdbId: 'tt1375666' });
    expect(global.fetch).toHaveBeenCalledTimes(1);
    expect(String((global.fetch as jest.Mock).mock.calls[0][0])).toContain(
      'movie_details.json?imdb_id=tt1375666',
    );

    expect(result).not.toBeNull();
    expect(result?.title).toBe('Inception (2010)');
    expect(result?.imdbCode).toBe('tt1375666');
    // Invalid hashes are dropped.
    expect(result?.torrents).toHaveLength(1);
    expect(result?.torrents[0]).toMatchObject({
      quality: '1080p',
      sizeBytes: 1986000000,
      hash: '224BF45881252643DFC2E71ABC7B2660A21C68C4',
      downloadUrl:
        'https://yts.gg/torrent/download/224BF45881252643DFC2E71ABC7B2660A21C68C4',
      seeds: 1200,
    });
  });

  it('falls back to list_movies and applies the year match', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: () =>
        Promise.resolve({
          status: 'ok',
          data: {
            movies: [
              { ...moviePayload.data.movie, year: 1995 },
              { ...moviePayload.data.movie, year: 2010 },
            ],
          },
        }),
    });

    const result = await fetchYtsTorrents({ title: 'Inception', year: '2010' });
    expect(String((global.fetch as jest.Mock).mock.calls[0][0])).toContain(
      'list_movies.json?query_term=Inception',
    );
    expect(result?.title).toBe('Inception (2010)');
  });

  it('returns null when every strategy fails', async () => {
    global.fetch = jest.fn().mockRejectedValue(new Error('network down'));
    const result = await fetchYtsTorrents({ title: 'Anything', year: '2010' });
    expect(result).toBeNull();
  });

  it('returns null without any usable input', async () => {
    expect(await fetchYtsTorrents({})).toBeNull();
  });

  it('skips list_movies when only an unusable imdbId is given', async () => {
    global.fetch = jest.fn();
    expect(await fetchYtsTorrents({ imdbId: 'not-a-code' })).toBeNull();
    expect(global.fetch).not.toHaveBeenCalled();
  });
});
