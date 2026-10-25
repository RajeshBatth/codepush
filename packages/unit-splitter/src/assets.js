// Asset rule (Tier 1): the BYTES of an asset (png, font, ...) are in no JS bundle; they live in the binary (Android res/, iOS bundle).
// A patch may therefore only reference assets whose bytes are already in the base build, at the same registered location.
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';

const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');

/** `registerAsset({...})` argument of an asset module's transformed code (Metro prints it as JSON), or null. */
export function parseRegisteredAsset(code) {
  const m = /registerAsset\(\s*(\{[^]*?\})\s*\)/.exec(code);
  if (!m) return null;
  try { return JSON.parse(m[1]); } catch { return null; }
}

/** Android resource id the RN bundling step derives (mirrors @react-native/community-cli-plugin assetPathUtils.getResourceIdentifier). */
export function androidResourceOf(reg) {
  let base = reg.httpServerLocation ?? '';
  if (base[0] === '/') base = base.slice(1);
  return `${base}/${reg.name}`.toLowerCase().replace(/\//g, '_').replace(/([^a-z0-9_])/g, '').replace(/^assets_/, '');
}
/** iOS bundle path of the 1x file (mirrors getAssetDestPathIOS). */
export function iosPathOf(reg) {
  return `${String(reg.httpServerLocation ?? '').slice(1).replace(/\.\.\//g, '_')}/${reg.name}.${reg.type}`;
}

/**
 * All asset modules of the graph: Map<owner, record[]> (unsorted). record =
 * { path, sha256 (of the module's own file), name, type, httpServerLocation, scales, androidResource, iosPath, variants: [{scale, path, sha256}] }
 * `variants` = the scale files found next to it (name.ext, name@2x.ext, name.<platform>.ext ...): every one is a separate file in the binary.
 */
export function collectAssets(mods, ownerOf, key, platform) {
  const out = new Map();
  for (const [p, m] of mods) {
    const out0 = m.output.find((o) => o.type === 'js/module/asset');
    if (!out0) continue;
    const reg = parseRegisteredAsset(out0.data?.code ?? '');
    const o = ownerOf(p);
    const rec = { path: key(p), sha256: sha256(fs.readFileSync(p)) };
    if (reg) {
      const dir = path.dirname(p);
      const variants = [];
      for (const scale of [...(reg.scales ?? [])].sort((a, b) => a - b)) {
        const sfx = scale === 1 ? '' : `@${scale}x`;
        const cands = [platform && `${reg.name}${sfx}.${platform}.${reg.type}`, `${reg.name}${sfx}.native.${reg.type}`, `${reg.name}${sfx}.${reg.type}`].filter(Boolean);
        const f = cands.map((c) => path.join(dir, c)).find((c) => fs.existsSync(c));
        if (f) variants.push({ scale, path: key(f), sha256: f === p ? rec.sha256 : sha256(fs.readFileSync(f)) });
      }
      Object.assign(rec, {
        name: reg.name,
        type: reg.type,
        httpServerLocation: reg.httpServerLocation,
        scales: reg.scales ?? [1],
        androidResource: androidResourceOf(reg),
        iosPath: iosPathOf(reg),
        variants,
      });
    }
    if (!out.has(o)) out.set(o, []);
    out.get(o).push(rec);
  }
  for (const l of out.values()) l.sort((a, b) => (a.path < b.path ? -1 : 1));
  return out;
}

const sigOf = (a) => (a.variants?.length ? JSON.stringify(a.variants.map((v) => [v.scale, v.sha256])) : null);

/**
 * Compare the assets of the units with the base build's.
 * @param unitAssets Map<unitName, record[]>; @param baseAssets record[] (all owners of the base build)
 * @returns [{ rule: 'asset-not-in-base'|'asset-path-changed', message }]
 */
export function compareAssets(unitAssets, baseAssets) {
  const byPath = new Map(baseAssets.map((a) => [a.path, a]));
  const bySha = new Map();
  for (const a of baseAssets) if (!bySha.has(a.sha256)) bySha.set(a.sha256, a);
  const findings = [];
  for (const [unit, list] of [...unitAssets].sort()) {
    for (const a of list) {
      const b = byPath.get(a.path);
      if (b) {
        const bytesSame = a.sha256 === b.sha256 && (sigOf(a) === null || sigOf(b) === null || sigOf(a) === sigOf(b));
        if (!bytesSame) {
          const what = a.sha256 !== b.sha256 ? `sha256 ${b.sha256.slice(0, 12)} in the base, ${a.sha256.slice(0, 12)} now` : `scale variants differ (base ${(b.scales ?? []).join(',')}x, now ${(a.scales ?? []).join(',')}x, or a variant's contents)`;
          findings.push({ rule: 'asset-not-in-base', message: `unit ${unit}: asset ${a.path} is changed: ${what}; the bytes of an asset are not in the unit bundle but in the binary, so the patched unit would still show the old file (or a blank image). Ship the new image with a binary release or use a remote/data-URI image` });
        } else if (a.androidResource !== b.androidResource || a.iosPath !== b.iosPath || a.httpServerLocation !== b.httpServerLocation) {
          findings.push({ rule: 'asset-path-changed', message: `unit ${unit}: asset ${a.path} has the same bytes as in the base but is registered under another location/name (android resource ${b.androidResource} -> ${a.androidResource}, iOS ${b.iosPath} -> ${a.iosPath}); the native resource name derives from it and does not exist in the binary. Keep the registered location (project layout / asset name) unchanged` });
        }
        continue;
      }
      const moved = bySha.get(a.sha256);
      if (moved) {
        findings.push({ rule: 'asset-path-changed', message: `unit ${unit}: asset ${a.path} has the same bytes as base asset ${moved.path} but another path; the native resource name derives from the path (android resource ${moved.androidResource ?? '?'} in the binary, ${a.androidResource ?? '?'} expected now), so the patch would point at a resource that does not exist. Keep the file at its original path` });
      } else {
        findings.push({ rule: 'asset-not-in-base', message: `unit ${unit}: asset ${a.path} is new (not in the base build); the bytes of an asset are not in the unit bundle but in the binary (Android res/drawable-*, iOS bundle), so a patch cannot add one. Ship it with a binary release or use a remote/data-URI image` });
      }
    }
  }
  return findings;
}
