import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { checkDeterminism } from '../src/determinism.js';
import { build } from '../src/build.js';
import { DEMO, tmp } from './helpers.js';

test('two builds in different absolute paths / TZ / LANG are byte-identical (serializer approach)', () => {
  const r = checkDeterminism({ project: DEMO });
  assert.deepEqual(r, { ...r, identical: true, diffs: [], leaks: [] });
});

test('post-process approach is byte-identical across paths too', () => {
  const r = checkDeterminism({ project: DEMO, approach: 'postprocess' });
  assert.equal(r.identical, true, JSON.stringify(r));
});

test('approach (a) serializer and approach (c) post-process produce identical files', async () => {
  const a = await build({ projectRoot: DEMO, outDir: tmp('a-') });
  const c = await build({ projectRoot: DEMO, outDir: tmp('c-'), approach: 'postprocess' });
  assert.deepEqual(a.files, c.files);
});
