import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import sharp from 'sharp';
import { Worker } from 'worker_threads';

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
 * Runs in a worker thread. Pure-JS TensorFlow is CPU-bound and synchronous: on the main thread, loading the model
 * (seconds) and each classification (about a second) would freeze every HTTP request and chat socket.
 * Plain JavaScript (not compiled TypeScript) so it can be started with `eval` both from dist and under Jest.
 */
const WORKER_SOURCE = `
const { parentPort, workerData } = require('worker_threads');
const tf = require(workerData.tfjs);
const nsfwjs = require(workerData.nsfwjs);
let model;
async function ready() {
  if (!model) {
    await tf.setBackend('cpu');
    model = await nsfwjs.load('MobileNetV2');
  }
  return model;
}
parentPort.on('message', async ({ id, pixels }) => {
  try {
    const m = await ready();
    const input = tf.tensor3d(new Uint8Array(pixels), [224, 224, 3], 'int32');
    try {
      const preds = await m.classify(input, 5);
      const p = (name) => (preds.find((x) => x.className === name) || {}).probability || 0;
      parentPort.postMessage({ id, explicit: p('Porn') + p('Hentai') });
    } finally {
      input.dispose();
    }
  } catch (e) {
    parentPort.postMessage({ id, error: String((e && e.message) || e) });
  }
});
`;

const SCAN_TIMEOUT_MS = 60_000;

/**
 * Open-source NSFW classifier (nsfwjs, MobileNetV2 bundled with the package) on pure-JS TensorFlow, so it needs no
 * native build, GPU, network or paid API. Treat it as a first filter: it misses things and produces false positives,
 * which is why mid-range scores go to human review instead of being rejected.
 */
@Injectable()
export class NsfwJsScanner extends ContentScanner implements OnModuleDestroy {
  private readonly log = new Logger('ContentScanner');
  private worker: Worker | null = null;
  private seq = 0;
  private readonly pending = new Map<
    number,
    { resolve: (r: ScanResult | null) => void; timer: NodeJS.Timeout }
  >();

  private start(): Worker {
    if (this.worker) return this.worker;
    const w = new Worker(WORKER_SOURCE, {
      eval: true,
      // Resolved here so the worker finds the same packages regardless of its working directory.
      workerData: { tfjs: require.resolve('@tensorflow/tfjs'), nsfwjs: require.resolve('nsfwjs') },
      // Keep tfjs' console banner out of the server log; failures come back as messages or 'error' events.
      stdout: true,
      stderr: true,
    });
    w.unref();
    w.on('message', (msg: { id: number; explicit?: number; error?: string }) => {
      const job = this.pending.get(msg.id);
      if (!job) return;
      clearTimeout(job.timer);
      this.pending.delete(msg.id);
      if (msg.error) this.log.warn(`scan failed: ${msg.error}`);
      job.resolve(msg.error ? null : { explicit: msg.explicit ?? 0 });
    });
    const fail = (why: string) => {
      this.log.warn(`scanner worker stopped: ${why}`);
      for (const [, job] of this.pending) {
        clearTimeout(job.timer);
        job.resolve(null);
      }
      this.pending.clear();
      this.worker = null; // the next scan starts a fresh worker
    };
    w.on('error', (e) => fail(e.message));
    w.on('exit', (code) => code !== 0 && fail(`exit ${code}`));
    this.worker = w;
    return w;
  }

  async scan(image: Buffer): Promise<ScanResult | null> {
    let pixels: Buffer;
    try {
      // sharp works off the main thread too, so preprocessing does not block either.
      pixels = (await sharp(image).resize(224, 224, { fit: 'fill' }).removeAlpha().raw().toBuffer({ resolveWithObject: true })).data;
    } catch (e) {
      // Scanning must never block uploads because of an unreadable image; it simply goes unscanned.
      this.log.warn(`scan skipped: ${(e as Error).message}`);
      return null;
    }
    const worker = this.start();
    const id = ++this.seq;
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        this.log.warn('scan timed out');
        resolve(null);
      }, SCAN_TIMEOUT_MS);
      this.pending.set(id, { resolve, timer });
      const copy = new Uint8Array(pixels); // transfer a standalone buffer, not sharp's pooled one
      worker.postMessage({ id, pixels: copy.buffer }, [copy.buffer]);
    });
  }

  async onModuleDestroy() {
    await this.worker?.terminate();
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
