/** Client/server agreement and shoreline continuity around every junction. */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import { placeAt } from '../public/fields.js';
import { treeEarthAt } from '../public/trees.js';
import { ringDistance, STREET_HALF_WIDTH } from '../public/road.js';
import { COLLISION_RADIUS } from '../public/mowing.js';

const source = readFileSync(new URL('../src/index.ts', import.meta.url), 'utf8');
const start = source.indexOf('const SEEDS:');
// The slice must end at the last thing the map is made of. It used to end at
// a comment that has since been deleted, which quietly made the slice the
// whole file — `export class Lawn` is not something `vm` will run, so this
// check threw instead of checking. It is in `package.json` now so it cannot
// rot unnoticed again.
const end = source.indexOf('/** Water and trunks stop', start);
assert.ok(start >= 0 && end > start, 'cannot find the map in src/index.ts');
// The Lawn's own `placeAt` asks the trees where the bare earth is, and the
// Mower how wide the bank is, so the sandbox is handed the same answers the
// client uses. Anything the map depends on has to come in here, or this check
// tests a map that is not the map.
const server = vm.runInNewContext(ts.transpile(source.slice(start, end) + '\nplaceAt;', {
  target: ts.ScriptTarget.ES2022,
}), { treeEarthAt, ringDistance, STREET_HALF_WIDTH, COLLISION_RADIUS });
let checked = 0;
for (const [width, height] of [[408, 272], [288, 192]]) {
  for (let y = 1; y < height - 1; y += 0.7) {
    for (let x = 1; x < width - 1; x += 0.7) {
      const client = placeAt(x, y, width, height);
      const authority = server(x, y, width, height);
      assert.equal(client.field, authority.field);
      assert.equal(client.wet, authority.wet);
      assert.equal(client.street, authority.street);
      assert.equal(client.edge, authority.edge);
      // A centimetre-sized step must not jump across an invisible bank.
      for (const [dx, dy] of [[0.01, 0], [0, 0.01]]) {
        const next = placeAt(x + dx, y + dy, width, height);
        assert.ok(Math.abs(next.wet - client.wet) < 0.04,
          `Shoreline jump at ${x}, ${y}: ${client.wet} -> ${next.wet}`);
      }
      checked++;
    }
  }
}
console.log(`${checked} points: server/client agree; shorelines are continuous.`);
