import { BadRequestException } from '@nestjs/common';
import { MAX_TEXT_LENGTH, directKey, normalisePayload } from './chat.rules';

describe('directKey', () => {
  it('is the same for both directions', () => {
    expect(directKey('b', 'a')).toBe(directKey('a', 'b'));
  });
});

describe('normalisePayload', () => {
  it('trims text and rejects empty or oversize text', () => {
    expect(normalisePayload('text', { text: '  hi  ' })).toEqual({ text: 'hi' });
    expect(() => normalisePayload('text', { text: '   ' })).toThrow(BadRequestException);
    expect(() => normalisePayload('text', { text: 'x'.repeat(MAX_TEXT_LENGTH + 1) })).toThrow(
      BadRequestException,
    );
  });

  it('drops unknown fields from text messages', () => {
    expect(normalisePayload('text', { text: 'hi', mediaId: 'x', evil: true })).toEqual({ text: 'hi' });
  });

  it('requires a uuid mediaId for media messages', () => {
    expect(() => normalisePayload('image', { text: 'hi' })).toThrow(BadRequestException);
    expect(() => normalisePayload('image', { mediaId: 'nope' })).toThrow(BadRequestException);
    const id = '0b1f7c0e-1111-4111-8111-111111111111';
    expect(normalisePayload('image', { mediaId: id, caption: ' hey ' })).toEqual({
      mediaId: id,
      caption: 'hey',
    });
  });
});
