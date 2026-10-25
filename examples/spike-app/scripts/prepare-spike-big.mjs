#!/usr/bin/env node
// node scripts/prepare-spike-big.mjs [android|ios]  (run AFTER prepare-spike-assets.mjs; adds the S18 assets + a `big` record to spike.json)
// S18 (realistic unit size): a 4th unit `biglib` built from real npm packages (lodash, dayjs, semver, ajv) through the real splitter/ota-build.
// Separate script because the app's metro.config.js require()s units.config.json once per process (a temporary 4th unit needs a fresh process).
import fs from 'node:fs';
import path from 'node:path';
import { APP, WORK, createPatches, bundle, sha256, rm, mkdirp, withEdits, swap } from './lib.mjs';

const platform = process.argv[2] ?? 'android';
const out = path.join(APP, '.spike-assets', platform);
const spikeJson = JSON.parse(fs.readFileSync(path.join(out, 'spike.json'), 'utf8'));
const work = path.join(WORK, 'spike-big', platform);
rm(work); mkdirp(work);
const base = { build: { host: { hash: spikeJson.host.hash } } };
const copy = (from, to) => { mkdirp(path.dirname(path.join(out, to))); fs.copyFileSync(from, path.join(out, to)); };
  // ---- S18 (realistic unit size): a 4th unit `biglib` built from real npm packages (lodash, dayjs, semver, ajv) through the real splitter/ota-build.
  // Its own base build (config edit is temporary), a one-string edit built in DELTA and plain mode, patch + sizes; assets go to big/.
  const BIG_ENTRY = (label) => `import {AppRegistry, Text} from 'react-native';
import React from 'react';
import _ from 'lodash';
import dayjs from 'dayjs';
import semver from 'semver';
import Ajv from 'ajv';

const LABEL = '${label}';
const ajv = new Ajv();
const ok = ajv.validate({type: 'object', properties: {n: {type: 'number'}}, required: ['n']}, {n: 3});
const value = [LABEL, _.sum(_.map(_.range(1, 11), n => n * n)), dayjs('2024-03-05T00:00:00Z').add(2, 'day').format('YYYY-MM-DD'), semver.gt('1.10.0', '1.9.0'), ok].join('|');
globalThis.__otaProbe.units.biglib = value;
export const Root = () => React.createElement(Text, null, 'BIGLIB:' + LABEL);
AppRegistry.registerComponent('biglib', () => Root);
`;
  const BIG_EXPECTED = (label) => `${label}|385|2024-03-07|true|true`;
  const bigDir = path.join(APP, 'src/units/biglib');
  const cfgEdit = [['units.config.json', swap('"entry": "src/units/travelplex/entry.js" }',
    '"entry": "src/units/travelplex/entry.js" },\n    { "name": "biglib", "roots": ["src/units/biglib", "lodash", "dayjs", "semver", "ajv", "fast-deep-equal", "fast-json-stable-stringify", "json-schema-traverse", "uri-js", "punycode"], "entry": "src/units/biglib/entry.js" }')]];
  // the splitter only sees units reachable through a host import(): temporarily reference biglib from the host (big builds only;
  // the unit is run on the real embedded host on the device, only the unit file matters)
  const hostRef = ['src/host/SpikeHost.js', swap("const Travelplex = lazyUnit('travelplex', () => import('../units/travelplex/entry'));",
    "const Travelplex = lazyUnit('travelplex', () => import('../units/travelplex/entry'));\nexport const Biglib = lazyUnit('biglib', () => import('../units/biglib/entry'));")];
  const buildBig = async (label, name, extra) => {
    mkdirp(bigDir);
    fs.writeFileSync(path.join(bigDir, 'entry.js'), BIG_ENTRY(label));
    try { return await withEdits([...cfgEdit, hostRef], () => bundle({ project: APP, platform, out: path.join(work, name), appVersion: '0.0.1', ...extra })); }
    finally { rm(bigDir); }
  };
  console.log(`[${platform}] biglib base / v2 (delta) / v2 (plain)`);
  const bigBase = await buildBig('b1', 'big-base');
  const bigBB = path.join(work, 'big-base');
  const bigV2 = await buildBig('b2', 'big-v2', { baseBuild: bigBB, delta: 'on' });
  const bigV2p = await buildBig('b2', 'big-v2-plain', { baseBuild: bigBB, delta: 'off' });
  const bigPatch = createPatches({ base: bigBB, new: path.join(work, 'big-v2'), out: path.join(work, 'patches-big'), fullThreshold: 100 });
  const bigPatchP = createPatches({ base: bigBB, new: path.join(work, 'big-v2-plain'), out: path.join(work, 'patches-big-plain'), fullThreshold: 100 });
  const bdi = bigPatch.items.find((i) => i.unit === 'biglib'), bpi = bigPatchP.items.find((i) => i.unit === 'biglib');
  if (!bdi || bdi.updateType !== 'patch') throw new Error('no biglib patch');
  if (bigPatch.hostChanged || bigPatch.changedUnits.join() !== 'biglib') throw new Error(`biglib patch must be unit-only: ${bigPatch.hostChanged} ${bigPatch.changedUnits}`);
  const bigHostSame = base.build.host.hash === bigBase.build.host.hash;
  console.log(`[${platform}] biglib: unit ${bigBase.build.units.biglib.size} B (host same as main base: ${bigHostSame}); one-string edit: plain-built patch ${bpi.patchSize} B, delta-built ${bdi.patchSize} B; hostChanged=${bigPatch.hostChanged}`);

  mkdirp(path.join(out, 'big'));
  copy(path.join(bigBB, 'units/biglib.hbc'), 'big/biglib-b1.hbc');
  copy(path.join(work, 'big-v2/units/biglib.hbc'), 'big/biglib-b2.hbc');
  copy(path.join(work, 'patches-big', bdi.patchFile), 'big/biglib.hdiff');
  spikeJson.big = {
      baseFile: 'big/biglib-b1.hbc', builtFile: 'big/biglib-b2.hbc', patchFile: 'big/biglib.hdiff',
      baseHash: sha256(fs.readFileSync(path.join(out, 'big/biglib-b1.hbc'))), builtHash: bdi.builtHash,
      entryId: bigBase.build.units.biglib.entryModuleId, size: bigBase.build.units.biglib.size, builtSize: bigV2.build.units.biglib.size,
      patchSize: bdi.patchSize, plainBuiltPatchSize: bpi.patchSize, newZstdSize: bdi.newZstdSize, deltaBuilt: bigV2.build.delta.enabled === true,
      hostChanged: bigPatch.hostChanged, changedUnits: bigPatch.changedUnits, hostSameAsMainBase: bigHostSame,
      packages: ["lodash", "dayjs", "semver", "ajv", "fast-deep-equal", "fast-json-stable-stringify", "json-schema-traverse", "uri-js", "punycode"], probe: { b1: BIG_EXPECTED('b1'), b2: BIG_EXPECTED('b2') },
    };
  fs.writeFileSync(path.join(out, 'spike.json'), JSON.stringify(spikeJson, null, 2) + '\n');
  if (!process.env.KEEP_WORK) rm(work);
  console.log('biglib assets written');
