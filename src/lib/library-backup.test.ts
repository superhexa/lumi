import { createLibraryBackup, parseLibraryBackup } from './library-backup';

const favorite = {
  title: 'Arrival',
  source_name: 'TMDB',
  year: '2016',
  cover: '/arrival.jpg',
  total_episodes: 1,
  save_time: 100,
};

const playRecord = {
  ...favorite,
  index: 1,
  play_time: 120,
  total_time: 7200,
};

describe('Lumi library backup', () => {
  it('creates and parses a valid versioned backup', () => {
    const backup = createLibraryBackup(
      { 'tmdb+329865': favorite },
      { 'tmdb+329865': playRecord },
      '2026-10-30T12:00:00.000Z',
    );

    expect(parseLibraryBackup(backup)).toEqual(backup);
  });

  it.each([
    null,
    [],
    {},
    { format: 'other', version: 1 },
    {
      format: 'lumi-library',
      version: 2,
      exportedAt: '2026-10-30T12:00:00.000Z',
      favorites: {},
      playRecords: {},
    },
    {
      format: 'lumi-library',
      version: 1,
      exportedAt: 'not-a-date',
      favorites: {},
      playRecords: {},
    },
    {
      format: 'lumi-library',
      version: 1,
      exportedAt: '2026-10-30T12:00:00.000Z',
      favorites: { 'tmdb+': favorite },
      playRecords: {},
    },
    {
      format: 'lumi-library',
      version: 1,
      exportedAt: '2026-10-30T12:00:00.000Z',
      favorites: {},
      playRecords: { 'tmdb+329865': { ...playRecord, play_time: -1 } },
    },
  ])('rejects invalid backups', (backup) => {
    expect(parseLibraryBackup(backup)).toBeNull();
  });

  it('rejects collections larger than the import limit', () => {
    const favorites = Object.fromEntries(
      Array.from({ length: 10001 }, (_, index) => [
        `tmdb+${index + 1}`,
        favorite,
      ]),
    );
    expect(
      parseLibraryBackup({
        ...createLibraryBackup({}, {}),
        favorites,
      }),
    ).toBeNull();
  });
});
