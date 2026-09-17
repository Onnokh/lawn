/** Client/server agreement and shoreline continuity around every junction. */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import { placeAt } from '../public/fields.js';

const source = readFileSync(new URL('../src/index.ts', import.meta.url), 'utf8');
const start = source.indexOf('const SEEDS:');
const end = source.indexOf('/** Grass grows', start);
const server = vm.runInNewContext(ts.transpile(source.slice(start, end) + '\nplaceAt;', {
  target: ts.ScriptTarget.ES2022,
}));
let checked = 0;
for (const [width, height] of [[408, 272], [288, 192]]) {
  for (let y = 1; y < height - 1; y += 0.7) {
    for (let x = 1; x < width - 1; x += 0.7) {
      const client = placeAt(x, y, width, height);
      const authority = server(x, y, width, height);
      assert.equal(client.field, authority.field);
      assert.equal(client.wet, authority.wet);
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
