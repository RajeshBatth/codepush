// SINGLE pin table for the external hermesc binary. Pure data + pure selection logic (no I/O), unit-tested in test/pins.test.ts.
// The pins are the sha256 of `sdks/hermesc/<dir>/<binary>` inside the `react-native@RN_VERSION` npm tarball
// (obtained with `npm pack`, hashed only; the linux64/win64 binaries were never executed on the machine that recorded them).
import { BuildError } from './util.ts';

export const RN_VERSION = '0.78.3';
/** Contents of `sdks/.hermesversion` of that tarball; the trailing hash is the Hermes commit hermesc was built from. */
export const HERMES_VERSION_TAG = 'hermes-2025-01-13-RNv0.78.0-a942ef374897d85da38e9c8904574f8376555388';
export const HERMES_COMMIT = 'a942ef374897d85da38e9c8904574f8376555388';
export const EXPECTED_HBC_VERSION = 96;

export type PinKey = 'osx' | 'linux64' | 'win64';
export const PIN_KEYS: readonly PinKey[] = ['osx', 'linux64', 'win64'];

export interface HermescPin {
  key: PinKey;
  /** `process.platform` value this pin serves */
  nodePlatform: NodeJS.Platform;
  /** `process.arch` values the binary runs on */
  arches: readonly string[];
  /** directory under `sdks/hermesc/` in the RN tarball */
  dir: string;
  /** file name of the compiler inside `dir` */
  binary: string;
  sha256: string;
  /** other files of `dir` the binary needs at run time (hashes pinned too) */
  companions: Readonly<Record<string, string>>;
}

export const HERMESC_PIN_TABLE: Readonly<Record<PinKey, HermescPin>> = {
  osx: {
    key: 'osx', nodePlatform: 'darwin', arches: ['arm64', 'x64'], dir: 'osx-bin', binary: 'hermesc',
    sha256: 'sha256:a82e519e1fa3737f6b95554cdb9edaaf37458fb03abcdc2144f039fa0b3302ab', companions: {},
  },
  linux64: {
    key: 'linux64', nodePlatform: 'linux', arches: ['x64'], dir: 'linux64-bin', binary: 'hermesc',
    sha256: 'sha256:028225889c34216961579c54223e7686b32ad6b9fbc5820fbdf508650ffd9a42', companions: {},
  },
  win64: {
    key: 'win64', nodePlatform: 'win32', arches: ['x64'], dir: 'win64-bin', binary: 'hermesc.exe',
    sha256: 'sha256:4d7185efa1f594a85d36420bcd033fb0bf03e504e3ffd7d98d4d86e97b1b4a0e',
    companions: {
      'icudt64.dll': 'sha256:a622e206805898280243cc9efadd38fcb0c5054635965b2d01588f320984b4f1',
      'icuin64.dll': 'sha256:7f85455d31e4d131be8a62181e75c3b36192497e3ee3fa64963af704ad9d3e3f',
      'icuio64.dll': 'sha256:90e1913098bef58db660425c3228605ded65db89a481a39d6601216e6dcc4a6e',
      'icutest64.dll': 'sha256:4d925c3f651902cd542e404ab47b93e0ac9a18c27b76b810105f6d8f257a7313',
      'icutu64.dll': 'sha256:da93c111ab187d9953b82fc5f239efa8b6a9586130e08cae2ccd24db278fde12',
      'icuuc64.dll': 'sha256:c809d1ae462119a1586a6091018bf18d505a398727c60e429a978403b782cb7b',
      'msvcp140.dll': 'sha256:8f141b4454fa78db34bc1f28c571b4da0e00cd2c43f7ad0e282f313036826aae',
      'vcruntime140_1.dll': 'sha256:963e45edd064545962e216c12d68071ced94dc8e11862a18f07f14eb2690a57c',
      'vcruntime140.dll': 'sha256:0205071c36c17f1efbd70178c852cb7d49985c484202752b8704b7ac6b184e60',
    },
  },
};

/** The pin for the machine we run on (by `process.platform` + `process.arch`), or null (e.g. linux arm64). */
export function pinKeyForHost(platform: string = process.platform, arch: string = process.arch): PinKey | null {
  for (const k of PIN_KEYS) {
    const p = HERMESC_PIN_TABLE[k];
    if (p.nodePlatform === platform && p.arches.includes(arch)) return k;
  }
  return null;
}

export function parsePinKey(s: string): PinKey {
  if ((PIN_KEYS as readonly string[]).includes(s)) return s as PinKey;
  throw new BuildError('USAGE', `unknown hermesc platform "${s}"; expected one of ${PIN_KEYS.join(', ')}`);
}

/** Legacy view keyed by `process.platform` (darwin / linux / win32), used by doctor and tests. */
export const HERMESC_PINS: Record<string, { dir: string; binary: string; sha256: string } | undefined> = Object.fromEntries(
  PIN_KEYS.map((k) => [HERMESC_PIN_TABLE[k].nodePlatform, { dir: HERMESC_PIN_TABLE[k].dir, binary: HERMESC_PIN_TABLE[k].binary, sha256: HERMESC_PIN_TABLE[k].sha256 }]),
);
