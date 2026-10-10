import { BadRequestException } from '@nestjs/common';
import { MAX_BYTES, validateUploadRequest } from './media.rules';

describe('validateUploadRequest', () => {
  it('accepts a normal jpeg for a post', () => {
    expect(() => validateUploadRequest('image', 'post', 'image/jpeg', 1_000_000)).not.toThrow();
  });

  it('rejects a video as an avatar', () => {
    expect(() => validateUploadRequest('video', 'avatar', 'video/mp4', 1000)).toThrow(BadRequestException);
  });

  it('rejects mime types outside the whitelist', () => {
    expect(() => validateUploadRequest('image', 'post', 'image/svg+xml', 1000)).toThrow(BadRequestException);
    expect(() => validateUploadRequest('image', 'post', 'text/html', 1000)).toThrow(BadRequestException);
  });

  it('rejects oversize and empty files', () => {
    expect(() => validateUploadRequest('image', 'post', 'image/png', MAX_BYTES.image + 1)).toThrow(
      BadRequestException,
    );
    expect(() => validateUploadRequest('image', 'post', 'image/png', 0)).toThrow(BadRequestException);
  });

  it('only lets chat carry audio and files', () => {
    expect(() => validateUploadRequest('audio', 'chat', 'audio/mpeg', 1000)).not.toThrow();
    expect(() => validateUploadRequest('file', 'post', 'application/pdf', 1000)).toThrow(BadRequestException);
  });
});
