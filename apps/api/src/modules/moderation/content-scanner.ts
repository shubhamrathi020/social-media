import { Injectable, Logger } from '@nestjs/common';
import sharp from 'sharp';

export interface ScanResult {
  /** Probability (0..1) that the image is explicit (porn or hentai classes). */
  explicit: number;
}

export abstract class ContentScanner {
  abstract scan(image: Buffer): Promise<ScanResult | null>;
}

/** Used when scanning is switched off (CONTENT_SCAN=off). */
export class NoopScanner extends ContentScanner {
  async scan() {
    return null;
  }
}

/**
 * Open-source NSFW classifier (nsfwjs, MobileNetV2 bundled with the package) running on pure-JS TensorFlow,
 * so it needs no native build, GPU, network or paid API. Roughly a second per image on a laptop CPU; it runs in
 * the background media worker, not on the request path. Treat it as a first filter: it misses things and
 * produces false positives, which is why mid-range scores go to human review instead of being rejected.
 */
@Injectable()
export class NsfwJsScanner extends ContentScanner {
  private readonly log = new Logger('ContentScanner');
  private model: Promise<any> | null = null;

  private load() {
    this.model ??= (async () => {
      const tf = await import('@tensorflow/tfjs');
      await tf.setBackend('cpu');
      const nsfwjs = await import('nsfwjs');
      const m = await nsfwjs.load('MobileNetV2');
      this.log.log('NSFW model loaded');
      return { tf, m };
    })().catch((e) => {
      this.model = null; // allow a retry later
      throw e;
    });
    return this.model;
  }

  async scan(image: Buffer): Promise<ScanResult | null> {
    try {
      const { tf, m } = await this.load();
      const { data } = await sharp(image)
        .resize(224, 224, { fit: 'fill' })
        .removeAlpha()
        .raw()
        .toBuffer({ resolveWithObject: true });
      const input = tf.tensor3d(new Uint8Array(data), [224, 224, 3], 'int32');
      try {
        const preds: { className: string; probability: number }[] = await m.classify(input, 5);
        const p = (name: string) => preds.find((x) => x.className === name)?.probability ?? 0;
        return { explicit: p('Porn') + p('Hentai') };
      } finally {
        input.dispose();
      }
    } catch (e) {
      // Scanning must never block uploads because the model failed; the item simply goes unscanned.
      this.log.warn(`scan failed: ${(e as Error).message}`);
      return null;
    }
  }
}

export interface ScanPolicy {
  /** At or above this, the upload is rejected outright. */
  reject: number;
  /** At or above this (and below reject), content using the media is hidden and queued for review. */
  review: number;
}

export function scanPolicy(env: NodeJS.ProcessEnv = process.env): ScanPolicy {
  return {
    reject: Number(env.CONTENT_SCAN_REJECT ?? 0.9),
    review: Number(env.CONTENT_SCAN_REVIEW ?? 0.6),
  };
}

export function decide(score: number | null, policy: ScanPolicy): 'allow' | 'review' | 'reject' {
  if (score === null) return 'allow';
  if (score >= policy.reject) return 'reject';
  if (score >= policy.review) return 'review';
  return 'allow';
}
