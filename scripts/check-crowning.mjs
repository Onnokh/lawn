/**
 * A Field is finished by the stroke that takes its last Tile, and not by one
 * before it.
 *
 * A Field used to count as cut with one part in a hundred still standing, and
 * the Lawn crowned everybody in it all the same. So this check leaves one Tile
 * of each Field standing and asks the real Lawn what it makes of that, then
 * takes the Tile and asks again. It asks the tracker the same two questions,
 * because the flare and the card are one moment: a Lawn and a tracker that
 * called the finish differently would put the medal to one side of it.
 *
 *     node scripts/check-crowning.mjs
 */
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { FIELD_NAMES, buildFields, fieldProgress } from '../public/fields.js';

const W = 408, H = 272;

const bundled = await build({ entryPoints: ['src/index.ts'], bundle: true, write: false, format: 'esm',
  platform: 'node', plugins: [{ name: 'workers-test', setup(b) {
    b.onResolve({ filter: /^cloudflare:workers$/ }, () => ({ path: 'workers', namespace: 'test' }));
    b.onLoad({ filter: /.*/, namespace: 'test' }, () => ({ contents: 'export class DurableObject {}' }));
  } }] });
const { Lawn } = await import('data:text/javascript;base64,'
  + Buffer.from(bundled.outputFiles[0].text).toString('base64'));
globalThis.WebSocket = { READY_STATE_OPEN: 1 };

const fields = buildFields(W, H);
const realNow = Date.now;
let now = 2_000_000_000_000;
Date.now = () => now;
try {
  for (const [id, name] of FIELD_NAMES.entries()) {
    const { tiles } = fields[id];
    const told = [];
    const socket = { readyState: 1, send(message) { told.push(JSON.parse(message).t); },
      deserializeAttachment: () => ({ id: 'm1', name: 'Rusty Willow', key: 'k1' }) };
    const game = Object.create(Lawn.prototype);
    Object.assign(game, { mownAt: new Uint32Array(W * H), cutByField: new Float64Array(FIELD_NAMES.length),
      fieldWatch: FIELD_NAMES.map(() => ({ at: 0, percent: 0, done: false })),
      notes: [], scores: new Map(), places: new WeakMap(), env: {},
      ctx: { getWebSockets: () => [socket], waitUntil() {}, getTags: () => [''] },
      schedulePersist() {}, broadcast() {}, broadcastNote() {} });
    // The Mower stands in the Field, on a Tile it has cut.
    const stand = tiles[tiles.length >> 1];
    game.places.set(socket, { x: stand % W + 0.5, y: Math.floor(stand / W) + 0.5 });
    const last = tiles.find(i => i !== stand);
    /** What the Lawn reads after a stroke on this Field, as the Mow Stroke leaves it. */
    const stroke = () => {
      game.cutByField.fill(0);
      game.cutByField[id] = 1;
      game.watchFields();
      now += 1000;
      return game.fieldWatch[id].percent;
    };
    const crowned = () => game.scores.get('k1')?.q?.[id] ?? 0;

    stroke(); // The first reading only takes the measure of the Field.
    const seconds = Math.floor(now / 1000);
    for (const i of tiles) if (i !== last) game.mownAt[i] = seconds;
    const nearly = stroke();
    assert.ok(nearly < 100, `${name}: one Tile standing reads ${nearly}%, which is a finish`);
    assert.equal(crowned(), 0, `${name}: nobody is crowned while one Tile stands`);
    const tracked = fieldProgress(tiles, i => (i === last ? 1 : 0));
    assert.ok(Math.abs(tracked - nearly) < 1e-9, `${name}: the tracker reads ${tracked}% and the Lawn ${nearly}%`);

    game.mownAt[last] = Math.floor(now / 1000);
    assert.equal(stroke(), 100, `${name}: the last Tile finishes the Field`);
    assert.equal(fieldProgress(tiles, () => 0), 100, `${name}: and the tracker agrees`);
    assert.equal(crowned(), 1, `${name}: the Mower in the Field is crowned`);
    assert.ok(game.notes.some(note => note.k === 'cut' && note.f === id), `${name}: the Log remembers the finish`);
    assert.ok(told.includes('got'), `${name}: the Mower is told what it won`);
    stroke();
    assert.equal(crowned(), 1, `${name}: a Field that stays cut is not crowned twice`);
  }
} finally { Date.now = realNow; }
console.log(`Crowning: in each of the ${FIELD_NAMES.length} Fields, one Tile standing is no finish, and the stroke that takes it is.`);
