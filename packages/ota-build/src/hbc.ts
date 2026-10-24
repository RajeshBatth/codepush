import { BuildError } from './util.ts';
import { PLATFORMS, type Platform } from './types.ts';

/** Hermes bytecode header: u64 magic 0x1F1903C103BC1FC6 (LE bytes c6 1f bc 03 c1 03 19 1f), then u32 version. */
export const HBC_MAGIC = Buffer.from([0xc6, 0x1f, 0xbc, 0x03, 0xc1, 0x03, 0x19, 0x1f]);
export function readHbcHeader(data: Uint8Array): { magicOk: boolean; version: number | null } {
  if (data.length < 128) return { magicOk: false, version: null };
  const b = Buffer.from(data.buffer, data.byteOffset, 12);
  return { magicOk: b.subarray(0, 8).equals(HBC_MAGIC), version: b.readUInt32LE(8) };
}
export function validateHbc(data: Uint8Array, expectedVersion: number, label: string): void {
  const h = readHbcHeader(data);
  if (!h.magicOk) throw new BuildError('BAD_HBC', `${label}: not Hermes bytecode (magic mismatch or file < 128 bytes)`);
  if (h.version !== expectedVersion) throw new BuildError('BAD_HBC', `${label}: bytecode version ${h.version}, toolchain says ${expectedVersion}`);
}
export function assertPlatform(p: string): asserts p is Platform {
  if (!(PLATFORMS as readonly string[]).includes(p)) throw new BuildError('BAD_ARG', `--platform must be android or ios (got ${p})`);
}
