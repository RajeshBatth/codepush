import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, sign, verify } from 'node:crypto';
import type { Entry, Hash, Manifest } from './types.ts';
import { PLATFORMS } from './types.ts';
import { isEmpty, rangeOf } from './ranges.ts';

const HASH_RE = /^sha256:[0-9a-f]{64}$/;

export function isHash(s: unknown): s is Hash {
  return typeof s === 'string' && HASH_RE.test(s);
}

export function sha256(data: Uint8Array | string): Hash {
  return 'sha256:' + createHash('sha256').update(data).digest('hex');
}

/**
 * Deterministic JSON: object keys sorted recursively, no whitespace, arrays in order.
 * Used for signatures and the audit hash chain. Native verifiers must reproduce this exactly,
 * which is why the SDK verifies a signature over the *bytes served* plus a detached canonical form
 * (see verifyManifestSignature): only the server needs to canonicalize.
 */
export function canonicalize(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    if (typeof value === 'number' && !Number.isFinite(value)) throw new Error('non-finite number');
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return '[' + value.map(canonicalize).join(',') + ']';
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).filter((k) => obj[k] !== undefined).sort();
  return '{' + keys.map((k) => JSON.stringify(k) + ':' + canonicalize(obj[k])).join(',') + '}';
}

function validateEntries(path: string, entries: Entry[], seenIds: Set<string>, hostIds: Set<string>, errors: string[]): void {
  if (!Array.isArray(entries)) {
    errors.push(`${path}.entries must be an array`);
    return;
  }
  const nonEmpty: { id: string; r: [number, number] }[] = [];
  entries.forEach((e, i) => {
    const p = `${path}.entries[${i}]`;
    if (typeof e.id !== 'string' || !e.id) errors.push(`${p}.id missing`);
    else if (seenIds.has(e.id)) errors.push(`${p}.id duplicate: ${e.id}`);
    else seenIds.add(e.id);
    if (typeof e.patchUrl !== 'string' || !e.patchUrl) errors.push(`${p}.patchUrl missing`);
    if (!isHash(e.hash)) errors.push(`${p}.hash must be sha256:<64 hex>`);
    if (!Number.isInteger(e.size) || e.size <= 0) errors.push(`${p}.size must be a positive integer`);
    if (e.updateType !== 'patch' && e.updateType !== 'full') errors.push(`${p}.updateType must be patch|full`);
    if (e.range !== undefined) {
      const r = e.range;
      if (!Array.isArray(r) || r.length !== 2 || !r.every((n) => typeof n === 'number' && Number.isFinite(n))) {
        errors.push(`${p}.range must be [start,end]`);
      } else if (r[0] < 0 || r[1] > 1 || r[0] > r[1]) {
        errors.push(`${p}.range must satisfy 0 <= start <= end <= 1`);
      }
    }
    if (e.requiresHost != null && !hostIds.has(e.requiresHost)) {
      errors.push(`${p}.requiresHost "${e.requiresHost}" does not match a mainBundle entry id`);
    }
    const r = rangeOf(e);
    if (!isEmpty(r)) nonEmpty.push({ id: e.id, r });
  });
  nonEmpty.sort((a, b) => a.r[0] - b.r[0]);
  for (let i = 1; i < nonEmpty.length; i++) {
    if (nonEmpty[i].r[0] < nonEmpty[i - 1].r[1]) {
      errors.push(`${path}: ranges of ${nonEmpty[i - 1].id} and ${nonEmpty[i].id} overlap (sum of shares must be <= 1)`);
    }
  }
}

/** Integrity validation of a manifest. Returns a list of errors (empty = valid). */
export function validateManifest(m: Manifest): string[] {
  const errors: string[] = [];
  if (m.schema !== 1) errors.push('schema must be 1');
  if (!PLATFORMS.includes(m.platform)) errors.push('platform must be android|ios');
  if (typeof m.appVersion !== 'string' || !m.appVersion) errors.push('appVersion missing');
  if (typeof m.patchAlgoVer !== 'string' || !m.patchAlgoVer) errors.push('patchAlgoVer missing');
  if (!Number.isInteger(m.version) || m.version < 1) errors.push('version must be an integer >= 1');
  if (!Number.isInteger(m.ttlSec) || m.ttlSec < 1 || m.ttlSec > 86400) errors.push('ttlSec must be 1..86400');
  if (!m.mainBundle) {
    errors.push('mainBundle missing');
    return errors;
  }
  if (!isHash(m.mainBundle.baseHash)) errors.push('mainBundle.baseHash invalid');
  const seen = new Set<string>();
  validateEntries('mainBundle', m.mainBundle.entries, seen, new Set(), errors);
  const hostIds = new Set((m.mainBundle.entries ?? []).map((e) => e.id));
  if (!Array.isArray(m.units)) {
    errors.push('units must be an array');
    return errors;
  }
  const names = new Set<string>();
  m.units.forEach((u, i) => {
    const p = `units[${i}](${u.unitName})`;
    if (!u.unitName) errors.push(`${p}.unitName missing`);
    else if (names.has(u.unitName)) errors.push(`${p} duplicate unit`);
    else names.add(u.unitName);
    if (!isHash(u.baseHash)) errors.push(`${p}.baseHash invalid`);
    validateEntries(p, u.entries, seen, hostIds, errors);
  });
  return errors;
}

// ---- signing (Ed25519; production uses a KMS-held key, same algorithm) ----

export interface KeyPair {
  privateKeyPem: string;
  publicKeyPem: string;
}

export function generateKeyPair(): KeyPair {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  return {
    privateKeyPem: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
    publicKeyPem: publicKey.export({ type: 'spki', format: 'pem' }).toString(),
  };
}

/**
 * Serialized form of a manifest: canonical JSON (sorted keys, no whitespace). These exact bytes are what is
 * stored, served as manifest.json, and signed. Devices verify the detached signature over the received bytes,
 * so they never need to canonicalize JSON themselves.
 */
export function serializeManifest(m: Manifest): string {
  return canonicalize(m);
}

export interface SignedManifest {
  /** exact bytes of manifest.json */
  json: string;
  /** base64 Ed25519 signature over `json` (UTF-8), served as manifest.json.sig */
  sig: string;
}

export function signManifest(m: Manifest, privateKeyPem: string): SignedManifest {
  const json = serializeManifest(m);
  const sig = sign(null, Buffer.from(json, 'utf8'), createPrivateKey(privateKeyPem)).toString('base64');
  return { json, sig };
}

/** Verify the detached signature over the exact bytes received; then (and only then) parse. */
export function verifyManifestBytes(json: string | Uint8Array, sigBase64: string, publicKeyPem: string): boolean {
  try {
    return verify(null, Buffer.from(json), createPublicKey(publicKeyPem), Buffer.from(sigBase64.trim(), 'base64'));
  } catch {
    return false;
  }
}
