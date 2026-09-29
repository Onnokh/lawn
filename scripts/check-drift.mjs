/**
 * A drift is worth an Achievement only if a Mower can actually do one. The
 * Lawn judges a drift from the swath and the nose, and both come out of the
 * drive model the browser runs, so neither side can be checked alone: a
 * threshold can sit in a range the physics never reach and every unit test
 * either side of it still passes. So this check drives the real drive model,
 * sends what the real client would send, and asks the real Lawn what it saw.
 */
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { stepDrive } from '../public/driving.js';
import { DRIFT_STEPS } from '../public/achievements.js';

const SEND_MS = 100;            // the client's report cadence
const BLADES_PER_STROKE = 10;   // mowing is checked on its own; here it only needs to be > 0

const bundled = await build({ entryPoints: ['src/index.ts'], bundle: true, write: false, format: 'esm',
  platform: 'node', plugins: [{ name: 'workers-test', setup(b) {
    b.onResolve({ filter: /^cloudflare:workers$/ }, () => ({ path: 'workers', namespace: 'test' }));
    b.onLoad({ filter: /.*/, namespace: 'test' }, () => ({ contents: 'export class DurableObject {}' }));
  } }] });
const { Lawn } = await import('data:text/javascript;base64,'
  + Buffer.from(bundled.outputFiles[0].text).toString('base64'));

function lawn() {
  const game = Object.create(Lawn.prototype);
  Object.assign(game, { places: new WeakMap(), lastSwath: new WeakMap(), travelBudgets: new Map(),
    budgets: new WeakMap(), scores: new Map(), strokes: 0, won: [],
    trackBallMower() {}, tell() {}, schedulePersist() {}, watchFields() {}, resync() {},
    mow() { return BLADES_PER_STROKE; }, broadcast() {},
    broadcastNote(note) { if (note.k === 'won') this.won.push(note.w); } });
  // Isolate the drift from terrain; the travel budget and the banks have their own checks.
  game.dryRun = (_from, _ux, _uy, distance) => distance;
  // The Lawn also tells Rybbit about each Achievement it awards. This env holds no API key, so nothing is sent.
  game.env = {};
  game.ctx = { waitUntil() {}, getTags: () => [] };
  return game;
}

/**
 * Drive one style for a while and report what the Lawn made of it. `crooked`
 * holds the nose off the swath without the wheels ever letting go, which is
 * what a Mower would send to claim a drift it did not do.
 */
function drive({ street = 1, rain = 0, throttle = 1, turn = 0, brakeTap = false, tapEvery = 0,
                 seconds = 4, crooked = 0, silent = false }) {
  const me = { x: 100, y: 130, a: 0, v: 0 };
  const base = { throttle: 1, turn: 0, brake: false, street, grass: 1 - street, tow: 0, stunned: false, rain };
  for (let i = 0; i < 120; i++) stepDrive(me, base, 1 / 60);   // up to cruising speed first

  const game = lawn();
  const socket = { deserializeAttachment: () => ({ id: 'd', name: 'Rusty Willow', key: 'k1' }), send() {} };
  const realNow = Date.now;
  let now = 10000, sentAt = -Infinity, sliding = 0, strokes = 0;
  Date.now = () => now;
  try {
    game.webSocketMessage(socket, JSON.stringify({ t: 'mow', x: me.x, y: me.y, a: me.a }));
    for (let frame = 0; frame < seconds * 60; frame++) {
      const tap = (brakeTap && frame === 0) || (tapEvery > 0 && frame % tapEvery === 0);
      const moved = stepDrive(me, { ...base, throttle, turn, brake: tap }, 1 / 60);
      if (moved.drifting) sliding++;
      me.x += moved.vx / 60;
      me.y += moved.vy / 60;
      now = 10000 + Math.round(frame / 60 * 1000);
      if (now - sentAt < SEND_MS) continue;
      sentAt = now;
      strokes++;
      const report = { t: 'mow', x: me.x, y: me.y, vx: moved.vx, vy: moved.vy };
      if (!silent) report.a = me.a + crooked;
      game.webSocketMessage(socket, JSON.stringify(report));
    }
  } finally { Date.now = realNow; }
  const score = game.scores.get('k1') ?? {};
  return { sliding, strokes, cut: score.c ?? 0, drifted: score.g ?? 0, won: game.won, held: score.a ?? 0 };
}

// A real drift: brake into a corner on a Street with the lock on. The client's
// own model says the tyres let go, so the Lawn must agree.
const tapped = drive({ brakeTap: true, turn: 1 });
assert.ok(tapped.sliding > 0, 'the drive model itself must call this a slide, or the check proves nothing');
assert.ok(tapped.drifted > 0, 'a Mower that really slides is credited for it');
assert.ok(tapped.drifted >= tapped.cut * 0.25,
  `a slide held through a corner is credited across it, not on one lucky stroke (${tapped.drifted} of ${tapped.cut})`);

// Rain breaks a Mower loose with no brake at all, and grass slides too.
assert.ok(drive({ rain: 1, turn: 1 }).drifted > 0, 'a Mower loosened by rain is credited');
assert.ok(drive({ street: 0, brakeTap: true, turn: 1 }).drifted > 0, 'a slide on grass counts as much as one on a Street');

// The hardest corner the model allows without ever breaking traction. This is
// the one that must not count, and it is why the bar cannot simply be lowered.
const hard = drive({ turn: 1 });
assert.equal(hard.sliding, 0, 'this style must not slide, or it tests nothing');
assert.equal(hard.drifted, 0, 'steering hard is not drifting');
assert.equal(drive({ turn: 0.2 }).drifted, 0, 'an ordinary bend is not drifting');
assert.equal(drive({ turn: 0 }).drifted, 0, 'a straight is not drifting');

// What a Mower would have to send to claim a drift it did not do.
assert.equal(drive({ turn: 0, crooked: 1.2 }).drifted, 0, 'a nose held crooked down a straight is not a drift');
assert.equal(drive({ turn: 1, crooked: -1.2 }).drifted, 0, 'a nose hung outside the corner is not a drift');
assert.equal(drive({ brakeTap: true, turn: 1, silent: true }).drifted, 0,
  'a Mower too old to send a heading is never credited, because the Lawn cannot see its nose');

// The ladder has to be climbable, and the first rung is the one that proves it:
// a Mower that keeps throwing it into corners must actually arrive at one.
const CORNER_FRAMES = 120;
const corners = Math.ceil(DRIFT_STEPS[0] / tapped.drifted);
const climb = drive({ tapEvery: CORNER_FRAMES, turn: 1, seconds: (corners + 1) * CORNER_FRAMES / 60 });
assert.ok(climb.drifted >= DRIFT_STEPS[0],
  `${DRIFT_STEPS[0]} drifted blades must be reachable by driving; got ${climb.drifted} in ${corners + 1} corners`);
assert.ok(climb.won.includes(22), 'Loose Surface is announced to the Lawn when it is earned');
assert.ok(climb.held & (1 << 22), 'and is written on the Score, so it is kept for ever');

console.log(`Drift: a real slide is credited (${tapped.drifted} of ${tapped.cut} blades), the hardest corner that keeps`
  + ` traction is not, a crooked nose is not, and ${DRIFT_STEPS[0]} blades come in ${corners} corners.`);
