import sharp from 'sharp';
import { ContentScanner, ScanResult } from './content-scanner';

/**
 * Deterministic stand-in for the NSFW model, for automated tests only: the "explicit" score is how strongly
 * red the image is (mean red minus mean green, scaled to 0..1). A pure red image scores 1, grey scores 0.
 * This lets end-to-end tests exercise the reject and review paths without explicit test images.
 */
export class TestColourScanner extends ContentScanner {
  async scan(image: Buffer): Promise<ScanResult> {
    const { channels } = await sharp(image).stats();
    const [r, g] = channels;
    return { explicit: Math.max(0, Math.min(1, (r.mean - g.mean) / 255)) };
  }
}
