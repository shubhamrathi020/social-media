import sharp from 'sharp';
import { NsfwJsScanner, decide, scanPolicy } from './content-scanner';
import { TestColourScanner } from './test-scanner';

const image = (background: { r: number; g: number; b: number }) =>
  sharp({ create: { width: 320, height: 240, channels: 3, background } }).png().toBuffer();

describe('decide', () => {
  const policy = { reject: 0.9, review: 0.6 };

  it('allows unscanned and low-scoring content', () => {
    expect(decide(null, policy)).toBe('allow');
    expect(decide(0.59, policy)).toBe('allow');
  });

  it('queues borderline content for review and rejects clear cases', () => {
    expect(decide(0.6, policy)).toBe('review');
    expect(decide(0.89, policy)).toBe('review');
    expect(decide(0.9, policy)).toBe('reject');
  });

  it('reads thresholds from the environment', () => {
    expect(scanPolicy({ CONTENT_SCAN_REJECT: '0.8', CONTENT_SCAN_REVIEW: '0.5' })).toEqual({ reject: 0.8, review: 0.5 });
    expect(scanPolicy({})).toEqual({ reject: 0.9, review: 0.6 });
  });
});

describe('TestColourScanner', () => {
  it('scores by redness', async () => {
    const s = new TestColourScanner();
    expect((await s.scan(await image({ r: 255, g: 0, b: 0 }))).explicit).toBeCloseTo(1, 1);
    expect((await s.scan(await image({ r: 120, g: 120, b: 120 }))).explicit).toBe(0);
  });
});

describe('NsfwJsScanner (real open-source model)', () => {
  const scanner = new NsfwJsScanner();
  afterAll(() => scanner.onModuleDestroy());

  it('loads offline and does not flag an ordinary image', async () => {
    const result = await scanner.scan(await image({ r: 60, g: 120, b: 200 }));
    expect(result).not.toBeNull();
    expect(result!.explicit).toBeLessThan(scanPolicy().review);
  }, 120_000);

  it('does not block the event loop while the model loads and scans', async () => {
    const fresh = new NsfwJsScanner(); // cold start: model load happens during this test
    let last = Date.now();
    let worstGap = 0;
    const timer = setInterval(() => {
      const now = Date.now();
      worstGap = Math.max(worstGap, now - last);
      last = now;
    }, 20);
    try {
      await fresh.scan(await image({ r: 200, g: 180, b: 40 }));
      await fresh.scan(await image({ r: 20, g: 40, b: 60 }));
    } finally {
      clearInterval(timer);
      await fresh.onModuleDestroy();
    }
    // On the main thread the model load alone stalls for seconds; in the worker the loop stays responsive.
    expect(worstGap).toBeLessThan(300);
  }, 120_000);

  it('returns null instead of throwing on garbage input', async () => {
    await expect(scanner.scan(Buffer.from('not an image'))).resolves.toBeNull();
  }, 120_000);
});
