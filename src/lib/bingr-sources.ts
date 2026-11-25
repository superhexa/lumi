/**
 * Bingr exposes the streams for every one of its servers through
 * `GET /api/sources`. The response is not encrypted for security; it is only
 * obfuscated with a small rolling XOR cipher so the browser can decode it.
 *
 * Decoding it ourselves is what makes Bingr usable on browsers without HEVC
 * support: the HTML watch page only embeds the first (often HEVC/H.265) server,
 * while `/api/sources` lists H.264 alternatives.
 */

const SEALED_PREFIX = 'v1.';
const SEALED_KEY = 'vY7#qL2!mZ9@wK4$';

export interface BingrSourceServer {
  id?: string;
  label?: string;
  tag?: string;
  hevc?: boolean;
}

export interface BingrSourceStream {
  url?: string;
  type?: string;
  quality?: string;
  label?: string;
  language?: string;
  subtitles?: unknown[];
  thumbnails?: string;
}

export interface BingrSourcesPayload {
  provider?: BingrSourceServer;
  servers?: BingrSourceServer[];
  streams?: BingrSourceStream[];
  at?: number;
}

function base64UrlToBytes(value: string): Uint8Array {
  const normalized = value.replace(/-/g, '+').replace(/_/g, '/');
  const padded =
    normalized.length % 4 === 0
      ? normalized
      : normalized.padEnd(normalized.length + (4 - (normalized.length % 4)), '=');
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index++) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

/**
 * Decodes a `v1.` payload returned by Bingr's `/api/sources` endpoint.
 * Throws when the payload is malformed so callers can fall back gracefully.
 */
export function decodeBingrSealedPayload<T = BingrSourcesPayload>(
  payload: string,
): T {
  if (!payload.startsWith(SEALED_PREFIX)) {
    throw new Error('Unsupported Bingr payload');
  }
  const bytes = base64UrlToBytes(payload.slice(SEALED_PREFIX.length));
  if (bytes.length < 13) throw new Error('Truncated Bingr payload');

  const nonce = bytes.subarray(0, 12);
  const data = bytes.slice(12);

  // Four FNV-1a derived state words keyed by the payload nonce.
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
    data[index] ^= (mask >>> ((index & 3) * 8)) & 255;
  }

  return JSON.parse(new TextDecoder().decode(data)) as T;
}

/**
 * Extracts the signed player token from a Bingr watch page. The token is part
 * of the React Server Component payload, so it can appear escaped.
 */
export function extractBingrWatchToken(html: string): string | null {
  const patterns = [
    // Player token next to the `sealed` payload in the RSC data.
    /"sealed"\s*:\s*"[^"]*"\s*,\s*"token"\s*:\s*"([^"\\]+)"/,
    /\\"sealed\\"\s*:\s*\\"[^"\\]*\\"\s*,\s*\\"token\\"\s*:\s*\\"([^"\\]+)/,
    // Fallback: the player token always contains a dot. This skips the
    // 32-character Cloudflare beacon token that also appears on the page.
    /"token"\s*:\s*"([^"\\]*\.[^"\\]+)"/,
    /\\"token\\"\s*:\s*\\"([^"\\]*\.[^"\\]+)/,
  ];
  for (const pattern of patterns) {
    const match = html.match(pattern);
    if (match?.[1]) return match[1];
  }
  return null;
}

function qualityScore(stream: BingrSourceStream): number {
  const value = `${stream.quality || ''} ${stream.label || ''}`.toLowerCase();
  if (value.includes('2160') || value.includes('4k')) return 5;
  if (value.includes('1080')) return 4;
  if (value.includes('720')) return 3;
  if (value.includes('480')) return 2;
  return 1;
}

function hostScore(url: string): number {
  try {
    const hostname = new URL(url).hostname;
    if (hostname.endsWith('.rousav.tech')) return 5;
    if (hostname.endsWith('.hscow.com')) return 4;
    if (hostname.endsWith('.streamrip.fun')) return 3;
    if (hostname.endsWith('.workers.dev')) return 2;
    return 1;
  } catch {
    return 0;
  }
}

function looksLikeHevc(stream: BingrSourceStream): boolean {
  const haystack = `${stream.url || ''} ${stream.quality || ''} ${
    stream.label || ''
  }`.toLowerCase();
  return /\bhevc\b|\bh\.?265\b|\bh265\b/.test(haystack);
}

/**
 * Orders streams so the most compatible, highest quality H.264 source wins.
 * HEVC is pushed to the end because most Chrome/Firefox builds cannot decode it
 * through Media Source Extensions.
 */
export function rankBingrStreams(
  streams: readonly BingrSourceStream[],
): BingrSourceStream[] {
  return streams
    .filter((stream) => typeof stream?.url === 'string' && stream.url)
    .filter((stream) => {
      const url = stream.url || '';
      if (!url.startsWith('https://')) return false;
      return stream.type === 'hls' || url.includes('.m3u8');
    })
    .slice()
    .sort((a, b) => {
      const hevcDelta = Number(looksLikeHevc(a)) - Number(looksLikeHevc(b));
      if (hevcDelta !== 0) return hevcDelta;
      const qualityDelta = qualityScore(b) - qualityScore(a);
      if (qualityDelta !== 0) return qualityDelta;
      return hostScore(b.url || '') - hostScore(a.url || '');
    });
}
