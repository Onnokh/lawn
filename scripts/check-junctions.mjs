/**
 * Client/server agreement and shoreline continuity around every junction.
 *
 * The Lawn holds its own copy of the map, in `src/ground/map.ts`, and the
 * client holds another in `public/fields.js`. The two have to agree about
 * every point of the Lawn, or a score counts blades that were never there.
 * This walks both and compares them point for point.
 */
import assert from 'node:assert/strict';
import { placeAt } from '../public/fields.js';
import { placeAt as serverPlaceAt } from '../.checks/ground/map.js';

let checked = 0;
for (const [width, height] of [[408, 272], [288, 192]]) {
  for (let y = 1; y < height - 1; y += 0.7) {
    for (let x = 1; x < width - 1; x += 0.7) {
      const client = placeAt(x, y, width, height);
      const authority = serverPlaceAt(x, y, width, height);
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
