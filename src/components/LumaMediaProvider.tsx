'use client';

// @ts-expect-error Next.js bundles this ESM client dependency; Node16 module checking expects require().
import { canPlayHLSNatively, HLSProviderLoader, isHLSSrc, MediaProvider } from '@vidstack/react';
import Hls from 'hls.js';

// Vidstack loads hls.js from a CDN by default. Bundling it removes that network
// dependency and makes playback work on networks that block public CDNs.
const mseHlsSupported = HLSProviderLoader.supported;

// Disable the default loader so the custom loader below (which injects the
// locally bundled hls.js build) is the one Vidstack selects.
HLSProviderLoader.supported = false;

class LumaHLSProviderLoader extends HLSProviderLoader {
  static supported = mseHlsSupported;

  canPlay(src: Parameters<HLSProviderLoader['canPlay']>[0]) {
    return (
      LumaHLSProviderLoader.supported &&
      !canPlayHLSNatively() &&
      isHLSSrc(src)
    );
  }

  async load(
    context: Parameters<HLSProviderLoader['load']>[0],
  ): Promise<Awaited<ReturnType<HLSProviderLoader['load']>>> {
    const provider = await super.load(context);
    provider.library = Hls as unknown as typeof provider.library;
    return provider;
  }
}

/**
 * Media provider used by Luma's direct player. Native HLS is still preferred
 * on Safari, while Chrome/Firefox use the bundled hls.js instance.
 */
export function LumaMediaProvider() {
  return <MediaProvider loaders={[LumaHLSProviderLoader]} />;
}
