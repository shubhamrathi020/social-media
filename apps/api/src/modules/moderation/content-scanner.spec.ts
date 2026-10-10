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
  it('loads offline and does not flag an ordinary image', async () => {
    const s = new NsfwJsScanner();
    const result = await s.scan(await image({ r: 60, g: 120, b: 200 }));
    expect(result).not.toBeNull();
    expect(result!.explicit).toBeLessThan(scanPolicy().review);
  }, 120_000);

  it('returns null instead of throwing on garbage input', async () => {
    const s = new NsfwJsScanner();
    await expect(s.scan(Buffer.from('not an image'))).resolves.toBeNull();
  }, 120_000);
});
