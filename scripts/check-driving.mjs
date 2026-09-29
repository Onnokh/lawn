import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { stepDrive, slipstream, soakAfter, MAX_SPEED } from '../public/driving.js';
import { streetAt } from '../public/fields.js';
import { ringDistance, STREET_HALF_WIDTH } from '../public/road.js';
import { blocked, placeAt } from '../public/fields.js';

const input = { throttle: 1, turn: 0, brake: false, street: 1, grass: 0, tow: 0, stunned: false };
const driver = () => ({ x: 0, y: 0, a: 0, v: 0 });
function run(me, controls, seconds, hz = 60) {
  let motion;
  for (let i = 0; i < seconds * hz; i++) motion = stepDrive(me, { ...input, ...controls }, 1 / hz);
  return motion;
}
const street = driver(), grass = driver(), draft = driver();
run(street, {}, 5); run(grass, { street: 0, grass: 1 }, 5); run(draft, { tow: 1 }, 5);
assert.ok(street.v > grass.v * 2, 'a Street is distinctly faster than mowing');
assert.ok(draft.v > street.v + 3 && draft.v <= MAX_SPEED, 'tow gives enough speed to pass');
run(draft, { tow: 0 }, 0.5);
assert.ok(draft.v > street.v + 1, 'tow persists long enough to pull alongside');
run(draft, { tow: 0, street: 0, grass: 1 }, 3);
assert.ok(draft.v < 9, 'grass brings the mower back to mowing speed');

const slide = { ...street }, corner = { ...street };
assert.ok(run(slide, { brake: true, turn: 1 }, 1 / 60).drifting, 'brake tap starts a slide');
const motion = run(slide, { turn: 1 }, 0.35);
run(corner, { turn: 1 }, 0.35);
assert.ok(motion.drifting, 'release does not cancel drift');
assert.ok(Math.abs(slide.a - slide.travel) > 0.3, 'drift has lateral motion');
assert.ok(Math.abs(corner.a - corner.travel) < 0.12, 'normal corner holds grip');
assert.ok(!run(slide, { turn: 0 }, 0.3).drifting, 'straightening recovers grip');
assert.ok(Math.abs(slide.a - slide.travel) > 0.01, 'grip returns progressively instead of snapping');
run(slide, { turn: 0 }, 0.4);
assert.ok(Math.abs(slide.a - slide.travel) < 0.01, 'slide settles smoothly');
run(slide, { brake: true }, 1.5);
assert.ok(slide.v < 0.1, 'holding brake stops');
assert.ok(!run(slide, { brake: true, turn: 1 }, 0.1).drifting, 'no low speed drift');
const dazed = { ...street };
assert.ok(!run(dazed, { stunned: true, turn: 1, brake: true, tow: 1 }, 0.1).drifting);
assert.equal(dazed.a, 0, 'stunned mower cannot steer');

for (const hz of [30, 60, 120]) {
  const me = driver(); run(me, {}, 2, hz);
  assert.ok(Math.abs(me.v - street.v) < 0.1, 'speed is stable across frame rates');
  const before = me.v;
  run(me, { brake: true, turn: 1 }, 1 / hz, hz);
  assert.ok(me.v > before * 0.96, 'brake onset preserves momentum');
  assert.ok(me.driftGrip > 0 && me.driftGrip < 0.2, 'grip eases into the slide');
}
const me = { ...street, x: 0, y: 0 };
const peer = { x: 12, y: 0, vx: 20, vy: 0, seen: 1000 };
assert.ok(slipstream(me, [peer], 1100, () => 1) > 0.9);
for (const change of [{ x: -12 }, { y: 8 }, { vx: -20 }, { vx: 0 }, { seen: 0 }, { x: 3 }]) {
  assert.equal(slipstream(me, [{ ...peer, ...change }], 1100, () => 1), 0);
}
assert.equal(slipstream(me, [peer], 1100, () => 0), 0);

const leader = { ...street, x: 12, y: -3 }, follower = { ...street, x: 0, y: -3 };
let passing = false, passed = false;
for (let frame = 0; frame < 1200; frame++) {
  const now = frame * 1000 / 60;
  if (leader.x - follower.x < 8) passing = true;
  const want = Math.atan2(((passing ? 3 : -3) - follower.y) * 2, 20);
  const tow = slipstream(follower, [{ ...leader, vx: leader.v, vy: 0, seen: now }], now, () => 1);
  const travel = stepDrive(follower, { ...input, tow, turn: (want - follower.a) * 2.2 }, 1 / 60);
  follower.x += travel.vx / 60; follower.y += travel.vy / 60;
  leader.x += leader.v / 60;
  assert.ok(Math.hypot(leader.x - follower.x, leader.y - follower.y) > 4.42, 'pass clears both mower bodies');
  if (follower.x > leader.x + 4.42) { passed = true; break; }
}
assert.ok(passed, 'draft, pull out, and complete a pass with equal cruising speeds');

for (const [w, h] of [[408, 272], [288, 192]]) {
  // Sample the ring itself. It is a loop, so its centre is found from the
  // distance field rather than from a straight-line centre.
  for (let y = 3; y < h - 3; y += 0.5) for (let x = 3; x < w - 3; x += 0.5) {
    if (Math.abs(ringDistance(x, y, w, h)) > 1.5) continue;
    assert.ok(streetAt(x, y, w, h) > 0.99);
    assert.equal(placeAt(x, y, w, h).field, -1);
    assert.ok(!blocked(x, y, w, h, 2.21), `passing lane blocked at ${x},${y}`);
  }
  let loopTiles = 0;
  for (let y = 3; y < h - 3; y += 0.5) for (let x = 3; x < w - 3; x += 0.5) {
    if (Math.abs(ringDistance(x, y, w, h)) > 3.1) continue;
    loopTiles++;
    assert.ok(!blocked(x, y, w, h, 2.21), `loop passing lane blocked at ${x},${y}`);
  }
  assert.ok(loopTiles > w * 12, 'loop provides a continuous wide route around the landscape');
  // Every Street is one route. The ring and the run across the middle meet at
  // both ends, so a Mower can stay on a Street from any part of it to any
  // other and never drop to the speed of the grass.
  const streetTiles = new Set();
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    if (placeAt(x + 0.5, y + 0.5, w, h).street < STREET_HALF_WIDTH - 3) streetTiles.add(y * w + x);
  }
  const queue = [streetTiles.values().next().value];
  streetTiles.delete(queue[0]);
  for (let i = 0; i < queue.length; i++) {
    const tile = queue[i];
    for (const next of [tile - 1, tile + 1, tile - w, tile + w]) {
      if (streetTiles.delete(next)) queue.push(next);
    }
  }
  assert.equal(streetTiles.size, 0, 'the ring and the run across the middle are one Street');
}
// The Water: it holds a Mower back while it wades, and a Mower that comes
// out soaked slides through a hard turn that a dry one takes on its tyres,
// until it has dried.
const onGrass = { street: 0, grass: 1 };
const dryCruise = driver(), wading = driver();
run(dryCruise, onGrass, 5); run(wading, { ...onGrass, wade: 1 }, 5);
assert.ok(wading.v < dryCruise.v * 0.7, 'the Water holds a wading Mower back');
assert.ok(wading.soak > 0.99, 'a wading Mower is soaked');
const quick = driver(); run(quick, { ...onGrass, wade: 0.5 }, 0.5);
assert.ok(quick.soak > 0.9, 'a moment in the Shallows soaks a Mower');
const wet = { ...dryCruise, soak: 1 }, dryTurn = { ...dryCruise };
assert.ok(run(wet, { ...onGrass, turn: 1 }, 1 / 60).drifting, 'a soaked Mower breaks loose in a hard turn');
assert.ok(!run(dryTurn, { ...onGrass, turn: 1 }, 1 / 60).drifting, 'a dry one holds the same turn');
run(wet, { ...onGrass, turn: 1 }, 0.5); run(dryTurn, { ...onGrass, turn: 1 }, 0.5);
assert.ok(Math.abs(wet.a - wet.travel) > Math.abs(dryTurn.a - dryTurn.travel) + 0.2, 'the soaked Mower slides out of the turn');
const drying = { ...dryCruise, soak: 1 };
run(drying, onGrass, 7);
assert.ok(!run(drying, { ...onGrass, turn: 1 }, 1 / 60).drifting, 'seven seconds out of the Water, it grips again');
run(drying, onGrass, 4);
assert.equal(drying.soak, 0, 'and it dries all the way');
assert.ok(soakAfter(1, 0, 1, 5) > soakAfter(1, 0, 0, 5), 'rain keeps a Mower wet for longer');
for (const [wade, seconds] of [[0.6, 0.4], [0, 3]]) {
  const soaks = [30, 60, 120].map(hz => {
    let soak = 0.5;
    for (let i = 0; i < seconds * hz; i++) soak = soakAfter(soak, wade, 0, 1 / hz);
    return soak;
  });
  assert.ok(Math.max(...soaks) - Math.min(...soaks) < 1e-9, 'a Mower soaks and dries alike at any frame rate');
}

const html = readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
const start = html.indexOf('const skidMarks = []');
const end = html.indexOf('let wakeAnchor', start);
assert.ok(start > 0 && end > start);
const sliding = { x: 100, y: 100, a: 0.4, driftX: 20, driftY: 0, driftGrip: 1 };
const skids = vm.runInNewContext(html.slice(start, end) + '\n({recordSkids, skidMarks})', {
  me: sliding, peers: new Map(), MOWER_SCALE: 2.6, W: 408, H: 272, wetAt: () => -6, onGrass: () => false,
});
skids.recordSkids(0);
sliding.x += 1; skids.recordSkids(50);
assert.equal(skids.skidMarks.length, 2, 'both rear wheels leave a segment');
assert.ok(Math.abs(skids.skidMarks[0].to.x - skids.skidMarks[0].from.x - 1) < 1e-8);
assert.equal(skids.skidMarks[0].to.y, skids.skidMarks[0].from.y, 'marks follow travel, not body heading');
sliding.x += 20; skids.recordSkids(100);
assert.equal(skids.skidMarks.length, 2, 'corrections do not draw a long streak');
sliding.driftX = 0; skids.recordSkids(13000);
assert.equal(skids.skidMarks.length, 0, 'marks expire and stopped wheels leave none');
console.log('Driving: Street speed, a complete collision-free pass, smooth brake-tap drift, stopping, grip recovery, frame rates, passing clearance, wading and the wet slide, and wheel marks verified.');
