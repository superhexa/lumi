/**
 * Minimal bencode decoder used to inspect .torrent files in the browser.
 * Supports the full bencode spec (integers, byte strings, lists, dictionaries).
 */

export type BencodeValue =
  | number
  | Uint8Array
  | BencodeValue[]
  | { [key: string]: BencodeValue };

const MAX_DEPTH = 64;

function isByteStringType(value: unknown): value is Uint8Array {
  return value instanceof Uint8Array;
}

export function isByteString(value: BencodeValue): boolean {
  return isByteStringType(value);
}

function decodeInteger(data: Uint8Array, index: number): {
  value: number;
  next: number;
} {
  let cursor = index + 1; // skip 'i'
  let negative = false;
  if (cursor < data.length && data[cursor] === 0x2d /* - */) {
    negative = true;
    cursor += 1;
  }
  const digitsStart = cursor;
  let value = 0;
  while (cursor < data.length && data[cursor] !== 0x65 /* e */) {
    const byte = data[cursor];
    if (byte < 0x30 || byte > 0x39) {
      throw new RangeError(`Malformed integer at position ${cursor}`);
    }
    value = value * 10 + (byte - 0x30);
    cursor += 1;
  }
  if (
    cursor >= data.length ||
    cursor === digitsStart ||
    (negative && cursor - digitsStart === 1 && value === 0)
  ) {
    throw new RangeError(`Malformed integer at position ${index}`);
  }
  return { value: negative ? -value : value, next: cursor + 1 };
}

function decodeByteString(data: Uint8Array, index: number): {
  value: Uint8Array;
  next: number;
} {
  let cursor = index;
  let length = 0;
  let lengthDigits = 0;
  while (cursor < data.length && data[cursor] !== 0x3a /* : */) {
    const byte = data[cursor];
    if (byte < 0x30 || byte > 0x39) {
      throw new RangeError(`Malformed string length at position ${cursor}`);
    }
    length = length * 10 + (byte - 0x30);
    lengthDigits += 1;
    if (lengthDigits > 16) {
      throw new RangeError(`String length too long at position ${index}`);
    }
    cursor += 1;
  }
  if (cursor === index || cursor >= data.length) {
    throw new RangeError(`Malformed string at position ${index}`);
  }
  cursor += 1; // skip ':'
  if (length < 0 || cursor + length > data.length) {
    throw new RangeError(`String exceeds buffer at position ${index}`);
  }
  return {
    value: data.slice(cursor, cursor + length),
    next: cursor + length,
  };
}

function decodeValue(
  data: Uint8Array,
  index: number,
  depth: number,
): { value: BencodeValue; next: number } {
  if (depth > MAX_DEPTH) {
    throw new RangeError('Bencode nesting depth exceeded');
  }
  if (index >= data.length) {
    throw new RangeError('Unexpected end of bencode data');
  }

  const marker = data[index];
  if (marker === 0x69 /* i */) {
    return decodeInteger(data, index);
  }
  if (marker === 0x6c /* l */) {
    const list: BencodeValue[] = [];
    let cursor = index + 1;
    while (cursor < data.length && data[cursor] !== 0x65 /* e */) {
      const decoded = decodeValue(data, cursor, depth + 1);
      list.push(decoded.value);
      cursor = decoded.next;
    }
    if (cursor >= data.length) {
      throw new RangeError('Unterminated list');
    }
    return { value: list, next: cursor + 1 };
  }
  if (marker === 0x64 /* d */) {
    const dict: { [key: string]: BencodeValue } = {};
    let cursor = index + 1;
    while (cursor < data.length && data[cursor] !== 0x65 /* e */) {
      const keyDecoded = decodeValue(data, cursor, depth + 1);
      if (!isByteStringType(keyDecoded.value)) {
        throw new RangeError('Dictionary keys must be byte strings');
      }
      cursor = keyDecoded.next;
      if (cursor >= data.length) {
        throw new RangeError('Unterminated dictionary');
      }
      const valueDecoded = decodeValue(data, cursor, depth + 1);
      dict[decodeUtf8(keyDecoded.value)] = valueDecoded.value;
      cursor = valueDecoded.next;
    }
    if (cursor >= data.length) {
      throw new RangeError('Unterminated dictionary');
    }
    return { value: dict, next: cursor + 1 };
  }
  if (marker >= 0x30 && marker <= 0x39) {
    return decodeByteString(data, index);
  }
  throw new RangeError(`Invalid bencode marker 0x${marker.toString(16)}`);
}

export function decodeUtf8(bytes: Uint8Array): string {
  // Modern runtimes provide TextDecoder everywhere (browsers, workers, node).
  // A small byte-level fallback keeps jsdom-style environments working too.
  if (typeof TextDecoder === 'function') {
    return new TextDecoder('utf-8', { fatal: false }).decode(bytes);
  }
  let output = '';
  let index = 0;
  while (index < bytes.length) {
    const byte = bytes[index];
    if (byte < 0x80) {
      output += String.fromCharCode(byte);
      index += 1;
    } else if ((byte & 0xe0) === 0xc0 && index + 1 < bytes.length) {
      output += String.fromCharCode(
        ((byte & 0x1f) << 6) | (bytes[index + 1] & 0x3f),
      );
      index += 2;
    } else if (
      (byte & 0xf0) === 0xe0 &&
      index + 2 < bytes.length &&
      (bytes[index + 1] & 0xc0) === 0x80 &&
      (bytes[index + 2] & 0xc0) === 0x80
    ) {
      output += String.fromCharCode(
        ((byte & 0x0f) << 12) |
          ((bytes[index + 1] & 0x3f) << 6) |
          (bytes[index + 2] & 0x3f),
      );
      index += 3;
    } else if (
      (byte & 0xf8) === 0xf0 &&
      index + 3 < bytes.length &&
      (bytes[index + 1] & 0xc0) === 0x80 &&
      (bytes[index + 2] & 0xc0) === 0x80 &&
      (bytes[index + 3] & 0xc0) === 0x80
    ) {
      const codepoint =
        ((byte & 0x07) << 18) |
        ((bytes[index + 1] & 0x3f) << 12) |
        ((bytes[index + 2] & 0x3f) << 6) |
        (bytes[index + 3] & 0x3f);
      output += String.fromCodePoint(codepoint);
      index += 4;
    } else {
      // Invalid byte — substitute so decoding never throws.
      output += '\uFFFD';
      index += 1;
    }
  }
  return output;
}

export function bencodeDecode(data: Uint8Array): BencodeValue {
  const decoded = decodeValue(data, 0, 0);
  // Allow trailing padding that some encoders add, but not new top-level data.
  for (let index = decoded.next; index < data.length; index += 1) {
    if (data[index] !== 0x20 && data[index] !== 0x0a && data[index] !== 0x0d) {
      throw new RangeError('Trailing data after bencode value');
    }
  }
  return decoded.value;
}

export function isBencodeDict(
  value: BencodeValue,
): value is { [key: string]: BencodeValue } {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export interface DecodedTorrentFile {
  path: string;
  length: number;
}

export interface DecodedTorrent {
  name: string;
  announce: string;
  announceList: string[];
  length: number;
  pieceLength: number;
  files: DecodedTorrentFile[];
  private: boolean;
  /** Raw bytes of the bencoded `info` dictionary (for hashing, if ever needed). */
  rawInfoByteLength: number;
}

function readByteString(value: BencodeValue, fallback = ''): string {
  return isByteStringType(value) ? decodeUtf8(value) : fallback;
}

function readListStringArrays(value: BencodeValue | undefined): string[] {
  if (!Array.isArray(value)) return [];
  const output: string[] = [];
  for (const entry of value) {
    if (Array.isArray(entry)) {
      for (const item of entry) {
        if (isByteStringType(item)) {
          const text = decodeUtf8(item);
          if (text) {
            output.push(text);
          }
        }
      }
    } else if (isByteStringType(entry)) {
      const text = decodeUtf8(entry);
      if (text) {
        output.push(text);
      }
    }
  }
  return output;
}

/**
 * Extracts the metadata a browser torrent client needs from a `.torrent`
 * file: display name, trackers, total size and the per-file list.
 */
export function decodeTorrent(data: Uint8Array): DecodedTorrent {
  const root = bencodeDecode(data);
  if (!isBencodeDict(root)) {
    throw new Error('Torrent payload is not a bencoded dictionary');
  }
  const info = root.info;
  if (!isBencodeDict(info)) {
    throw new Error('Torrent payload has no info dictionary');
  }

  const name = readByteString(info.name, 'movie');
  const announce = readByteString(
    root.announce,
  ).trim();
  const announceList = Array.from(
    new Set([announce, ...readListStringArrays(root['announce-list'])]),
  ).filter(Boolean);

  const files: DecodedTorrentFile[] = [];
  let length = 0;
  if (Array.isArray(info.files)) {
    for (const fileEntry of info.files) {
      if (!isBencodeDict(fileEntry)) continue;
      const filePath = Array.isArray(fileEntry.path)
        ? fileEntry.path
            .filter((part) => isByteStringType(part))
            .map((part) => decodeUtf8(part))
            .join('/')
        : '';
      const fileLength = typeof fileEntry.length === 'number' ? fileEntry.length : 0;
      if (!filePath || fileLength <= 0) continue;
      files.push({ path: filePath, length: fileLength });
      length += fileLength;
    }
  }
  if (files.length === 0 && typeof info.length === 'number') {
    files.push({ path: name, length: info.length });
    length = info.length;
  }

  return {
    name,
    announce,
    announceList,
    length,
    pieceLength: typeof info['piece length'] === 'number' ? info['piece length'] : 0,
    files,
    private: info.private === 1,
    rawInfoByteLength: 0,
  };
}

/** Picks the largest video-looking file from a decoded torrent, if any. */
export function findPrimaryVideoFile(
  files: DecodedTorrentFile[],
): DecodedTorrentFile | null {
  const videoExtension =
    /\.(mp4|mkv|avi|webm|mov|m4v|mpg|mpeg|ogv|3gp|m2ts)$/i;
  const candidates = files.filter((file) => videoExtension.test(file.path));
  if (candidates.length === 0) return null;
  return candidates.reduce((largest, current) =>
    current.length > largest.length ? current : largest,
  );
}
