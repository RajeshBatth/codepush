import { createPrivateKey, sign } from 'node:crypto';
import { verifyManifestBytes } from '@ota/core';
import type { SignerPort } from '../ports.ts';

/** SignerPort with an in-process Ed25519 private key (PEM). Stand-in for KMS: same algorithm, same signature bytes. */
export class LocalEd25519Signer implements SignerPort {
  readonly publicKeyPem: string;
  private key: ReturnType<typeof createPrivateKey>;
  constructor(keys: { privateKeyPem: string; publicKeyPem: string }) {
    this.key = createPrivateKey(keys.privateKeyPem);
    this.publicKeyPem = keys.publicKeyPem;
  }
  sign(bytes: Uint8Array): string {
    return sign(null, bytes, this.key).toString('base64');
  }
  verify(bytes: Uint8Array | string, sigBase64: string): boolean {
    return verifyManifestBytes(bytes, sigBase64, this.publicKeyPem);
  }
}
