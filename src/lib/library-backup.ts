import type { Favorite, PlayRecord } from './db.client';

export interface LibraryBackup {
  format: 'lumi-library';
  version: 1;
  exportedAt: string;
  favorites: Record<string, Favorite>;
  playRecords: Record<string, PlayRecord>;
}

const MAX_BACKUP_ENTRIES = 10000;

function isObjectRecord(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    Object.getPrototypeOf(value) === Object.prototype
  );
}

function isValidStorageKey(value: string): boolean {
  const separator = value.indexOf('+');
  return (
    separator > 0 &&
    separator < value.length - 1 &&
    !value.slice(0, separator).includes('+')
  );
}

function hasValidMediaFields(value: Record<string, unknown>): boolean {
  return (
    typeof value.title === 'string' &&
    typeof value.source_name === 'string' &&
    typeof value.year === 'string' &&
    typeof value.cover === 'string' &&
    typeof value.save_time === 'number' &&
    Number.isFinite(value.save_time) &&
    value.save_time >= 0 &&
    typeof value.total_episodes === 'number' &&
    Number.isFinite(value.total_episodes) &&
    value.total_episodes >= 0 &&
    (value.search_title === undefined || typeof value.search_title === 'string')
  );
}

function isValidMediaItem(value: unknown): value is Favorite {
  return isObjectRecord(value) && hasValidMediaFields(value);
}

function isValidPlayRecord(value: unknown): value is PlayRecord {
  return (
    isObjectRecord(value) &&
    hasValidMediaFields(value) &&
    typeof value.index === 'number' &&
    Number.isFinite(value.index) &&
    value.index >= 0 &&
    typeof value.play_time === 'number' &&
    Number.isFinite(value.play_time) &&
    value.play_time >= 0 &&
    typeof value.total_time === 'number' &&
    Number.isFinite(value.total_time) &&
    value.total_time >= 0
  );
}

function isValidCollection<Item>(
  value: unknown,
  validateItem: (item: unknown) => item is Item,
): value is Record<string, Item> {
  if (!isObjectRecord(value) || Object.keys(value).length > MAX_BACKUP_ENTRIES)
    return false;
  return Object.entries(value).every(
    ([key, item]) => isValidStorageKey(key) && validateItem(item),
  );
}

export function createLibraryBackup(
  favorites: Record<string, Favorite>,
  playRecords: Record<string, PlayRecord>,
  exportedAt = new Date().toISOString(),
): LibraryBackup {
  return {
    format: 'lumi-library',
    version: 1,
    exportedAt,
    favorites,
    playRecords,
  };
}

export function parseLibraryBackup(value: unknown): LibraryBackup | null {
  if (!isObjectRecord(value)) return null;
  if (value.format !== 'lumi-library' || value.version !== 1) return null;
  if (
    typeof value.exportedAt !== 'string' ||
    !Number.isFinite(Date.parse(value.exportedAt))
  )
    return null;
  if (
    !isValidCollection(value.favorites, isValidMediaItem) ||
    !isValidCollection(value.playRecords, isValidPlayRecord)
  )
    return null;

  return {
    format: 'lumi-library',
    version: 1,
    exportedAt: value.exportedAt,
    favorites: value.favorites,
    playRecords: value.playRecords,
  };
}
