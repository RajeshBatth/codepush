// Preloaded with `node --import` by gen-schema-fixtures.mjs so `new Date()` / Date.now() are constant in the ota-cli child
// processes: audit.json timestamps (and therefore the audit hash chain) become reproducible.
const FIXED = Date.parse('2026-01-01T00:00:00.000Z');
const RealDate = Date;
globalThis.Date = class extends RealDate {
  constructor(...args) {
    if (args.length === 0) super(FIXED);
    else super(...args);
  }
  static now() {
    return FIXED;
  }
};
