import { createHash } from 'node:crypto';

/**
 * Stable per-device, per-unit bucket in [0,1).
 * Portable definition (native ports must match; see vectors/bucket.json):
 *   h = SHA-256( UTF-8(deviceId) || 0x0A || UTF-8(unitName) )
 *   bucket = uint32_big_endian(h[0..4]) / 2^32
 * 2^32 divisor keeps the result exactly representable as a double on every platform.
 */
export function bucket(deviceId: string, unitName: string): number {
  const h = createHash('sha256').update(deviceId, 'utf8').update('\n').update(unitName, 'utf8').digest();
  return h.readUInt32BE(0) / 4294967296;
}
