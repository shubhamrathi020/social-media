import { orderPair } from '../friends/friends.service';

describe('orderPair', () => {
  const a = '0b1f7c0e-1111-4111-8111-111111111111';
  const b = 'f2a9d3c4-2222-4222-8222-222222222222';

  it('puts the smaller id first regardless of argument order', () => {
    expect(orderPair(a, b)).toEqual([a, b]);
    expect(orderPair(b, a)).toEqual([a, b]);
  });
});
