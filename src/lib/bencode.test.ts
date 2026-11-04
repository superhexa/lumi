import {
  bencodeDecode,
  decodeTorrent,
  decodeUtf8,
  findPrimaryVideoFile,
  isByteString,
} from '@/lib/bencode';

function bytes(input: string): Uint8Array {
  // jsdom may lack TextEncoder; charCodeAt is sufficient for ASCII fixtures.
  return Uint8Array.from(input, (char) => char.charCodeAt(0));
}

describe('bencode decoder', () => {
  it('decodes integers including negatives', () => {
    expect(bencodeDecode(bytes('i42e'))).toBe(42);
    expect(bencodeDecode(bytes('i-7e'))).toBe(-7);
    expect(bencodeDecode(bytes('i0e'))).toBe(0);
  });

  it('rejects malformed integers', () => {
    expect(() => bencodeDecode(bytes('ie'))).toThrow(RangeError);
    expect(() => bencodeDecode(bytes('iblah'))).toThrow(RangeError);
    expect(() => bencodeDecode(bytes('i2'))).toThrow(RangeError);
  });

  it('decodes byte strings and lists', () => {
    const value = bencodeDecode(bytes('4:spam'));
    expect(isByteString(value as never)).toBe(true);
    expect(decodeUtf8(value as Uint8Array)).toBe('spam');

    const list = bencodeDecode(bytes('l4:spami42ee')) as unknown[];
    expect(decodeUtf8(list[0] as Uint8Array)).toBe('spam');
    expect(list[1]).toBe(42);
  });

  it('decodes nested dictionaries', () => {
    const dict = bencodeDecode(bytes('d3:bar4:spam3:foeli1ei2eee')) as {
      [key: string]: unknown;
    };
    expect(decodeUtf8(dict.bar as Uint8Array)).toBe('spam');
    expect(dict.foe).toEqual([1, 2]);
  });

  it('rejects trailing non-padding data', () => {
    expect(() => bencodeDecode(bytes('i1ei2e'))).toThrow(RangeError);
  });

  it('allows zero padding after the root value', () => {
    expect(bencodeDecode(bytes('i5e  \n'))).toBe(5);
  });
});

describe('decodeTorrent', () => {
  it('extracts name, tracker and total length from a single-file torrent', () => {
    const payload =
      'd8:announce17:udp://tracker.com4:infod4:name10:Sintel.mp412:piece lengthi262144e6:lengthi900000eee';
    const torrent = decodeTorrent(bytes(payload));
    expect(torrent.name).toBe('Sintel.mp4');
    expect(torrent.announce).toBe('udp://tracker.com');
    expect(torrent.length).toBe(900000);
    expect(torrent.pieceLength).toBe(262144);
    expect(torrent.files).toEqual([{ path: 'Sintel.mp4', length: 900000 }]);
    expect(torrent.private).toBe(false);
  });

  it('reads announce-list trackers and multi-file entries', () => {
    const payload =
      'd13:announce-listll15:udp://alpha.com15:udp://bravo.comee4:infod4:name6:movies12:piece lengthi1024e5:filesld6:lengthi10e4:pathl9:movie.mkveed6:lengthi8e4:pathl8:subs.srteeeee';
    const torrent = decodeTorrent(bytes(payload));
    expect(torrent.announceList).toEqual(['udp://alpha.com', 'udp://bravo.com']);
    expect(torrent.files).toEqual([
      { path: 'movie.mkv', length: 10 },
      { path: 'subs.srt', length: 8 },
    ]);
    expect(torrent.length).toBe(18);
  });

  it('marks private torrents', () => {
    const payload =
      'd8:announce17:udp://tracker.com4:infod4:name10:Sintel.mp412:piece lengthi1024e6:lengthi9e7:privatei1eee';
    expect(decodeTorrent(bytes(payload)).private).toBe(true);
  });

  it('throws on non-metainfo payloads', () => {
    expect(() => decodeTorrent(bytes('garbage'))).toThrow();
    expect(() => decodeTorrent(new Uint8Array())).toThrow();
  });

  it('picks the largest video file via findPrimaryVideoFile', () => {
    const files = [
      { path: 'subs/eng.srt', length: 100 },
      { path: 'movie.mp4', length: 5000 },
      { path: 'extra.mkv', length: 800 },
    ];
    expect(findPrimaryVideoFile(files)?.path).toBe('movie.mp4');
    expect(findPrimaryVideoFile([{ path: 'doc.pdf', length: 1 }])).toBeNull();
  });
});
