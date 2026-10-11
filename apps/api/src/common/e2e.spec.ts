import {
  decryptFile,
  decryptMessage,
  encryptFile,
  encryptMessage,
  fromBase64,
  generateDeviceKeys,
  isValidPublicKey,
  safetyNumber,
  toBase64,
} from '@social/shared';

describe('shared E2E crypto', () => {
  it('base64 matches Node for every length', () => {
    for (let n = 0; n < 70; n++) {
      const bytes = new Uint8Array(n).map((_, i) => (i * 37 + n) & 255);
      expect(toBase64(bytes)).toBe(Buffer.from(bytes).toString('base64'));
      expect(Buffer.from(fromBase64(toBase64(bytes)))).toEqual(Buffer.from(bytes));
    }
  });

  it('every recipient device decrypts; others cannot', () => {
    const alice = generateDeviceKeys();
    const bob = generateDeviceKeys();
    const bob2 = generateDeviceKeys();
    const eve = generateDeviceKeys();
    const msg = encryptMessage({ text: 'hi bob 👋' }, alice, [
      { deviceId: 'b1', identityKey: bob.publicKey },
      { deviceId: 'b2', identityKey: bob2.publicKey },
      { deviceId: 'a1', identityKey: alice.publicKey },
    ]);
    const env = (id: string) => msg.keys.find((k) => k.deviceId === id)!.box;
    expect(decryptMessage(msg.ciphertext, env('b1'), alice.publicKey, bob)).toEqual({ text: 'hi bob 👋' });
    expect(decryptMessage(msg.ciphertext, env('b2'), alice.publicKey, bob2)).toEqual({ text: 'hi bob 👋' });
    expect(decryptMessage(msg.ciphertext, env('a1'), alice.publicKey, alice)).toEqual({ text: 'hi bob 👋' });
    expect(decryptMessage(msg.ciphertext, env('b1'), alice.publicKey, eve)).toBeNull();
    expect(JSON.stringify(msg)).not.toContain('hi bob');
  });

  it('rejects tampering and forged senders', () => {
    const alice = generateDeviceKeys();
    const bob = generateDeviceKeys();
    const mallory = generateDeviceKeys();
    const msg = encryptMessage({ text: 'pay 10' }, alice, [{ deviceId: 'b', identityKey: bob.publicKey }]);
    const ct = fromBase64(msg.ciphertext);
    ct[ct.length - 1] ^= 1;
    expect(decryptMessage(toBase64(ct), msg.keys[0].box, alice.publicKey, bob)).toBeNull();
    // Envelope claims to be from alice but was made by mallory.
    const forged = encryptMessage({ text: 'pay 1000' }, mallory, [{ deviceId: 'b', identityKey: bob.publicKey }]);
    expect(decryptMessage(forged.ciphertext, forged.keys[0].box, alice.publicKey, bob)).toBeNull();
  });

  it('encrypts files', () => {
    const bytes = new Uint8Array(5000).map((_, i) => i & 255);
    const enc = encryptFile(bytes);
    expect(Buffer.from(enc.data).includes(Buffer.from(bytes.slice(0, 64)))).toBe(false);
    expect(decryptFile(enc.data, enc.fileKey, enc.fileNonce)).toEqual(bytes);
    enc.data[10] ^= 1;
    expect(decryptFile(enc.data, enc.fileKey, enc.fileNonce)).toBeNull();
  });

  it('safety numbers match on both sides and change with any key', () => {
    const a = { userId: 'u-a', keys: [generateDeviceKeys().publicKey] };
    const b = { userId: 'u-b', keys: [generateDeviceKeys().publicKey, generateDeviceKeys().publicKey] };
    const n = safetyNumber(a, b);
    expect(n).toMatch(/^(\d{5} ){11}\d{5}$/);
    expect(safetyNumber(b, a)).toBe(n);
    expect(safetyNumber(a, { ...b, keys: [...b.keys].reverse() })).toBe(n);
    expect(safetyNumber(a, { ...b, keys: [generateDeviceKeys().publicKey] })).not.toBe(n);
  });

  it('validates public keys', () => {
    expect(isValidPublicKey(generateDeviceKeys().publicKey)).toBe(true);
    expect(isValidPublicKey('abc')).toBe(false);
  });
});
