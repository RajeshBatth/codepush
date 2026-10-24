import fs from 'node:fs';
import path from 'node:path';

const read = (p) => (fs.existsSync(p) ? fs.readFileSync(p) : null);

/**
 * The "only one unit differs" check (rule 2): compare two dist dirs byte for byte.
 * @returns {{changedUnits: string[], hostChanged: boolean, addedUnits: string[], removedUnits: string[]}}
 */
export function diffAgainstBase(baseDir, newDir) {
  const list = (d) => {
    const ud = path.join(d, 'units');
    return fs.existsSync(ud) ? fs.readdirSync(ud).filter((f) => f.endsWith('.js')).map((f) => f.slice(0, -3)).sort() : [];
  };
  const baseUnits = list(baseDir);
  const newUnits = list(newDir);
  const changedUnits = [];
  for (const u of newUnits.filter((x) => baseUnits.includes(x))) {
    if (!read(path.join(baseDir, 'units', u + '.js')).equals(read(path.join(newDir, 'units', u + '.js')))) changedUnits.push(u);
  }
  return {
    changedUnits,
    hostChanged: !read(path.join(baseDir, 'host.js')).equals(read(path.join(newDir, 'host.js'))),
    addedUnits: newUnits.filter((x) => !baseUnits.includes(x)),
    removedUnits: baseUnits.filter((x) => !newUnits.includes(x)),
  };
}
