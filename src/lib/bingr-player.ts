// Media URLs discovered through Bingr's public API. Keep the relay bounded to
// known media hosts: it must never become an arbitrary URL proxy.
const MEDIA_HOSTS = new Set([
  'futurefocusedentrepreneurs.site',
  'remoteconsultinggroup.site',
  'digitalassetlaunchpad.site',
  'sacdn.hakunaymatata.com',
  'img.rousav.tech',
  'hakunamatata.rousav.tech',
  'lingering-sky-2e99.badrishhmehar.workers.dev',
  'dash-hls-bridge.johndoesdmc.workers.dev',
  'dash-hls-bridge.johndoesfmc.workers.dev',
  'img1.hscow.com',
  'img2.hscow.com',
  'proxy.streamrip.fun',
]);

export function validateBingrMediaUrl(value: string): URL {
  const url = new URL(value);
  const allowedByPattern =
    url.hostname.endsWith('.workers.dev') ||
    url.hostname.endsWith('.streamrip.fun') ||
    url.hostname.endsWith('.bingr.one') ||
    url.hostname.endsWith('.hscow.com') ||
    url.hostname.endsWith('.rousav.tech') ||
    url.hostname.endsWith('.hakunaymatata.com') ||
    url.hostname.endsWith('.cloudfront.net');
  if (
    url.protocol !== 'https:' ||
    url.username ||
    url.password ||
    url.port ||
    (!MEDIA_HOSTS.has(url.hostname) && !allowedByPattern)
  )
    throw new Error('Unsupported media host');
  url.hash = '';
  return url;
}

export function unwrapBingrMediaUrl(value: string): URL {
  let url = new URL(value);
  for (let depth = 0; depth < 4; depth++) {
    if (
      url.hostname !== 'wormhole.filmu.in' &&
      !url.hostname.endsWith('.bingr.one')
    ) break;
    const upstream = url.searchParams.get('url');
    if (!upstream) throw new Error('Missing upstream media URL');
    url = new URL(upstream);
  }
  return validateBingrMediaUrl(url.href);
}

export function bingrMediaProxyUrl(value: string): string {
  return `/api/player/media?url=${encodeURIComponent(validateBingrMediaUrl(value).href)}`;
}

export function rewriteBingrPlaylist(body: string, base: URL): string {
  if (!body.trimStart().startsWith('#EXTM3U'))
    throw new Error('Invalid playlist');
  const rewrite = (uri: string) => bingrMediaProxyUrl(new URL(uri, base).href);
  return body
    .split(/\r?\n/)
    .map((line) => {
      if (!line || !line.trim()) return line;
      if (line.startsWith('#')) {
        let output = line;
        // Luma renders its own subtitle layer with live timing controls. Keep
        // provider subtitle renditions available but never auto-enable them,
        // otherwise the native track and the overlay would both show.
        if (
          output.startsWith('#EXT-X-MEDIA:') &&
          /TYPE=SUBTITLES/i.test(output)
        ) {
          output = output
            .replace(/DEFAULT=YES/gi, 'DEFAULT=NO')
            .replace(/AUTOSELECT=YES/gi, 'AUTOSELECT=NO');
        }
        return output.replace(
          /URI="([^"]+)"/g,
          (_, uri: string) => `URI="${rewrite(uri)}"`,
        );
      }
      return rewrite(line.trim());
    })
    .join('\n');
}
