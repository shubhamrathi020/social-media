# End-to-end encrypted chat

Chats are end-to-end encrypted: only the phones of the people in a conversation can read its messages and photos.
The server stores and relays ciphertext it cannot decrypt. This page describes exactly what that protects and what
it does not, so the app and store listing never over-promise.

## How it works (protocol version 1)

Code: `packages/shared/src/e2e.ts` (used by the app and by the tests; the server never encrypts or decrypts).
Primitives: [TweetNaCl](https://tweetnacl.js.org) (independently audited): X25519 key agreement, XSalsa20-Poly1305
authenticated encryption, SHA-512.

1. **Device keys.** On first sign-in each install generates an X25519 key pair. The private key stays in the phone's
   secure storage (Keychain / Keystore). The public key is registered for the device (`PUT /devices/me/keys`) and can
   never be replaced for that device.
2. **Encrypted conversations.** A new chat or group is encrypted when every member has an encryption-capable device.
   The server then refuses plaintext in it, and refuses any message that does not include a sealed key for **every**
   current device of every member (`409 DEVICES_CHANGED` with the fresh list), so nobody can be silently left out.
3. **Sending.** The app makes a random 32-byte message key, encrypts the message with it, and seals the key separately
   for each recipient device with `box` (sender device secret key + recipient device public key). Each device gets its
   own envelope, including the sender's other devices.
4. **Receiving.** A device opens its envelope with its private key and the sender device's public key, which also
   proves which device sent the message, then decrypts the message. Tampered messages fail authentication.
5. **Photos and files** are encrypted on the phone with a random key before upload. The server stores an opaque blob;
   the key travels inside the encrypted message.
6. **Safety numbers.** Chat info shows a 60-digit code derived from both people's device keys. If two friends compare
   it (in person or on a call) and it matches, nobody, including the server, is in the middle.

What the server stores per encrypted message: ciphertext, one sealed key per device, sender, sending device, time,
message kind (text/photo), reply/delete metadata. Deleting a message for everyone deletes its sealed keys too.

## What this protects against

- Anyone with access to the servers, database, backups or storage bucket reading messages or photos.
- Network observers (also covered by TLS).
- A malicious server silently dropping a member's device from a conversation (sends are refused unless every current
  device is included).
- Tampering with or forging messages.

## Limits (be honest about these)

- **No forward secrecy yet.** Device keys are long-lived. If someone steals a phone's private key, they can decrypt
  past messages that were sent to that phone (if they also have the ciphertext). Signal/WhatsApp avoid this with the
  Double Ratchet. Upgrade path: adopt the Signal protocol (`libsignal`) once the app ships a native crypto module;
  `enc_version` exists so both versions can coexist during migration.
- **Key changes are only caught by comparing safety numbers.** The server distributes public keys; a malicious server
  could add a device it controls to a conversation. The member list is still enforced, and the safety number would
  change, but the app does not yet warn automatically when a contact's code changes.
- **New devices and reinstalls cannot read older messages.** There are no encrypted backups; messages are only sealed
  for devices that existed when they were sent. Signing out and in again creates a new device.
- **Metadata is visible to the server**: who talks to whom, when, group membership, message kind and size.
- **Server-side features do not work inside encrypted chats:** push notifications say only "New message", server-side
  image/video scanning cannot see encrypted attachments (only reports from the people in the chat can surface abuse),
  and the data export contains ciphertext for these messages.
- **Mixed versions:** a chat with someone whose app cannot encrypt stays unencrypted (the app says so in chat info).
  Conversations created before this feature remain unencrypted.
- Encrypted photos are verified end-to-end in the tests; other attachment kinds use the same path but have not been
  exercised on a device.

## Tests

- `apps/api/src/common/e2e.spec.ts`: crypto round trips, tampering, forged senders, files, safety numbers.
- `apps/api/scripts/smoke-e2e.mjs` (31 checks, runs in CI): multi-device, new device, plaintext refused, missing
  device refused, encrypted attachments, groups, story replies, safety numbers, and a database check that only
  ciphertext is stored.
- Manually verified in the app (web build): receiving and decrypting, sending a reply that a separate client
  decrypts, and matching safety numbers on both sides.
