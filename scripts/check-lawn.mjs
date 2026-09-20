/**
 * The parts of the Lawn that move without being asked.
 *
 * A Mow Stroke answers for itself: it is sent, and something comes back. These
 * do not. A Field is read on a schedule and crowns whoever was standing in it;
 * a Mower that goes quiet is only said to have left once a grace has run out;
 * a Bump is counted only when the Lawn saw one. Nothing sends a message asking
 * for any of that, so nothing finds it broken unless a check goes looking.
 *
 * It drives the real Session over a Durable Object that is a Map.
 */
import assert from 'node:assert/strict';
import { harness } from '../.checks/lawn/testing.js';
import { FIELD_TILES, FIELD_OF, NO_FIELD } from '../.checks/ground/parcels.js';
import { FIELD_NAMES, FIELD_SLACK } from '../public/achievements.js';

const W = 408, H = 272, TILES = W * H;
const CHUNK = 96 * 1024;
const wait = ms => new Promise(r => setTimeout(r, ms));

/** The Lawn's own storage format: one array, written in 96 KiB chunks. */
function sow(mownAt) {
  const disk = new Map();
  const buffer = mownAt.buffer;
  for (let k = 0; k * CHUNK < buffer.byteLength; k++) {
    disk.set(k === 0 ? 'mownAt' : `mownAt:${k}`, buffer.slice(k * CHUNK, (k + 1) * CHUNK));
  }
  return disk;
}

// ---- A finished Field crowns whoever stood in it -------------------------

{
  const field = 0;
  const tiles = FIELD_TILES[field];
  const inField = new Set(tiles);
  // Leave one square of grass standing, somewhere a Mower can reach it. It has
  // to be bigger than the Slack, or the Field counts as cut with it still
  // there, and small enough that the Field still reads as near the line — a
  // Field under `FIELD_NEARLY` is only read every 300 ms.
  const least = tiles.length * FIELD_SLACK;
  const most = tiles.length * (1 - 0.95 * (1 - FIELD_SLACK));
  let square = null;
  for (let side = 14; side <= 30 && !square; side += 2) {
    for (const i of tiles) {
      const x0 = i % W, y0 = Math.floor(i / W);
      const held = [];
      for (let y = y0; y < y0 + side; y++) {
        for (let x = x0; x < x0 + side; x++) {
          if (inField.has(y * W + x)) held.push(y * W + x);
        }
      }
      if (held.length === side * side && held.length > least && held.length < most) {
        square = { x0, y0, side, held };
        break;
      }
    }
  }
  assert.ok(square, `a square of standing grass between ${least.toFixed(0)} and ${most.toFixed(0)} tiles`);

  const now = Math.floor(Date.now() / 1000);
  const mownAt = new Uint32Array(TILES);
  const standing = new Set(square.held);
  for (const i of tiles) if (!standing.has(i)) mownAt[i] = now;

  const lawn = await harness({ disk: sow(mownAt) });
  const driver = lawn.join({ id: 'driver' });
  const watcher = lawn.join({ id: 'watcher' });
  lawn.say(driver, { t: 'i' });
  const you = driver.said.find(m => m.t === 'you');
  assert.ok(you, 'the Mower holds a Key');
  assert.deepEqual(you.q, FIELD_NAMES.map(() => 0), 'and has finished nothing yet');

  // Drive the square off, one pass every 550 ms: a Mower banks a second of
  // travel at a time and a pass is most of a second's worth.
  const left = square.x0 - 1, right = square.x0 + square.side + 1;
  let seq = 0;
  lawn.say(driver, { t: 'mow', x: left, y: square.y0 + 0.5, a: 0, seq: ++seq });
  for (let row = 0; row < square.side + 2; row += 3) {
    await wait(550);
    const y = square.y0 + row + 0.5;
    lawn.say(driver, { t: 'mow', x: left, y, a: 0, seq: ++seq });
    await wait(550);
    lawn.say(driver, { t: 'mow', x: right, y, a: 0, seq: ++seq });
  }

  const got = driver.said.filter(m => m.t === 'got').at(-1);
  const won = watcher.said.filter(m => m.t === 'won');
  const cut = driver.said.filter(m => m.t === 'score').at(-1);
  assert.ok(cut.s > 0, 'the Lawn counted the blades it took off the square');
  assert.ok(got, 'finishing a Field earns the Mower standing in it an Achievement');
  assert.equal(got.q[field], 1, 'and the Lawn records the finish against that Field');
  assert.ok(won.length > 0, 'and everybody else is told about it');
  assert.ok(won.every(w => typeof w.w === 'number'), 'a note says which Achievement');
  console.log(`Fields: ${FIELD_NAMES[field]} finished after ${cut.s} blades; ${won.length} note(s) broadcast.`);
}

// ---- A first read of a Field crowns nobody --------------------------------

{
  // A Lawn waking beside a Field that was finished while it slept must not
  // hand out medals for somebody else's work.
  const tiles = FIELD_TILES[0];
  const now = Math.floor(Date.now() / 1000);
  const mownAt = new Uint32Array(TILES);
  for (const i of tiles) mownAt[i] = now;

  const lawn = await harness({ disk: sow(mownAt) });
  const driver = lawn.join({ id: 'driver' });
  lawn.say(driver, { t: 'i' });
  const at = tiles[Math.floor(tiles.length / 2)];
  const x = at % W, y = Math.floor(at / W);
  for (let seq = 1; seq <= 4; seq++) lawn.say(driver, { t: 'mow', x: x + seq, y: y + 0.5, a: 0, seq });
  assert.equal(driver.said.filter(m => m.t === 'got').length, 0,
    'a Field already finished when the Lawn woke crowns nobody');
  console.log('Fields: a Lawn that wakes beside a finished Field hands out nothing.');
}

// ---- A Bump is counted only when the Lawn saw one -------------------------

{
  // A Mower alone in a corner is in no Bump, whatever it says it was in.
  const lawn = await harness({ flat: true });
  const alone = lawn.join({ id: 'alone' });
  lawn.say(alone, { t: 'i' });
  lawn.say(alone, { t: 'mow', x: 200, y: 136, a: 0, seq: 1 });
  await wait(100);
  lawn.say(alone, { t: 'mow', x: 202, y: 136, a: 0, seq: 2 });
  lawn.say(alone, { t: 'bump' });
  await wait(300);
  lawn.say(alone, { t: 'mow', x: 203, y: 136, a: 0, seq: 3 });
  assert.equal(alone.said.filter(m => m.t === 'score').at(-1).b, 0,
    'a Mower alone in a corner is in no Bump, whatever it says');
}
{
  // Two that really close on each other are both in one, and the Lawn works
  // the Closing Speed out itself from the reports it already keeps.
  const lawn = await harness({ flat: true });
  const a = lawn.join({ id: 'a' });
  const b = lawn.join({ id: 'b' });
  lawn.say(a, { t: 'i' });
  lawn.say(b, { t: 'i' });
  lawn.say(a, { t: 'mow', x: 200, y: 136, a: 0, seq: 1 });
  lawn.say(b, { t: 'mow', x: 210, y: 136, a: 3.14, seq: 1 });
  await wait(100);
  lawn.say(a, { t: 'mow', x: 202, y: 136, a: 0, seq: 2 });
  lawn.say(b, { t: 'mow', x: 208, y: 136, a: 3.14, seq: 2 });
  // Said at once: a report a second old says nothing about how a Mower moves.
  lawn.say(a, { t: 'bump' });
  assert.ok(b.said.some(m => m.t === 'bumped' && m.id === 'a'),
    'the daze is relayed on the Mower\'s own word');
  await wait(300);
  lawn.say(a, { t: 'mow', x: 203, y: 136, a: 0, seq: 3 });
  assert.equal(a.said.filter(m => m.t === 'score').at(-1).b, 1,
    'a Bump the Lawn saw is counted');
  console.log('Bumps: a lone Mower counts none; two that close on each other count one.');
}

// ---- Arriving and leaving are per Mower Key, not per socket ---------------

{
  const lawn = await harness();
  const watcher = lawn.join({ id: 'watcher' });
  lawn.say(watcher, { t: 'i' });
  // A note goes to everyone on the Lawn, the Mower it is about included, so
  // the watcher heard its own arrival. Count from there.
  const base = watcher.said.filter(m => m.t === 'here').length;
  const here = () => watcher.said.filter(m => m.t === 'here').length - base;
  const gone = () => watcher.said.filter(m => m.t === 'gone').length;

  const first = lawn.join({ id: 'tab1' });
  lawn.say(first, { t: 'i' });
  const key = first.said.find(m => m.t === 'you').key;
  assert.equal(here(), 1, 'a Mower arriving is said once');

  // A second tab on one Key is not a second arrival.
  const second = lawn.join({ id: 'tab2', key });
  lawn.say(second, { t: 'i' });
  assert.equal(here(), 1, 'a second tab on one Key is not a second arrival');

  // Nor is the first tab closing a goodbye, while the second still holds it.
  lawn.leave(first);
  assert.equal(gone(), 0, 'a Key with a socket still open has not left');

  lawn.leave(second);
  assert.equal(gone(), 0, 'and a Key that has just gone quiet is given its grace');
  console.log('Log: arriving and leaving are worked out per Key; a reload says nothing.');
}

// ---- The board goes to disk and comes back --------------------------------

{
  const lawn = await harness({ flat: true });
  const driver = lawn.join({ id: 'driver' });
  lawn.say(driver, { t: 'i' });
  const key = driver.said.find(m => m.t === 'you').key;
  let x = 120;
  for (let seq = 1; seq <= 12; seq++) {
    await wait(100);
    lawn.say(driver, { t: 'mow', x: x += 2, y: 60, a: 0, seq });
  }
  const cut = driver.said.filter(m => m.t === 'score').at(-1);
  assert.ok(cut.s > 0, 'the Mower cut something');
  await lawn.wake();
  assert.ok(lawn.disk.has('scores'), 'the alarm wrote the board down');
  assert.ok(lawn.disk.has('mownAt'), 'and the ground with it');

  // A new Lawn, off the same disk. The Key opens the same Score.
  const again = await harness({ flat: true, disk: lawn.disk });
  const returning = again.join({ id: 'returning' });
  again.say(returning, { t: 'i', k: key });
  const you = returning.said.find(m => m.t === 'you');
  assert.equal(you.key, key, 'the Key is taken back');
  // The Mower is told its tally a few times a second, not on every stroke, so
  // the last number it heard is behind the number the Lawn wrote down. What
  // comes back is the Lawn's count, which is the only one that was ever real.
  assert.ok(you.s >= cut.s, `the board comes back whole: ${you.s} >= ${cut.s}`);
  assert.ok(you.d > 0, 'and the Tiles it drove with it');
  console.log(`Storage: ${you.s} blades written down and read back on a new Lawn.`);
}

// ---- One unreadable record does not cost everybody their Score ----------

{
  // The Lawn writes every record itself, so none of them should be unreadable.
  // That is the argument for being strict about what is read, and it is not an
  // argument for betting the board on it: whatever is loaded is what the next
  // alarm writes back, so a row that is dropped on the way in is a row deleted
  // on the way out. A Score can be mown again in an afternoon; an Achievement
  // earned with it cannot be earned twice.
  const disk = new Map([['scores', [
    ['good-1', { n: 'Bold Clover', c: 900, a: 7, q: FIELD_NAMES.map(() => 0), d: 120, b: 3 }],
    ['ancient', 450],                       // the bare number a Score used to be
    ['broken', { c: 5 }],                   // no name: the Lawn cannot read it
    ['good-2', { n: 'Quiet Fescue', c: 300 }],
  ]]]);
  const lawn = await harness({ flat: true, disk });
  const ws = lawn.join({ id: 'reader' });

  lawn.say(ws, { t: 'i', k: 'good-1' });
  const kept = ws.said.find(m => m.t === 'you');
  assert.equal(kept.s, 900, 'a good record survives a bad one beside it');
  assert.equal(kept.a, 7, 'and keeps the Achievements it had earned');

  const second = lawn.join({ id: 'reader2' });
  lawn.say(second, { t: 'i', k: 'ancient' });
  assert.equal(second.said.find(m => m.t === 'you').s, 450,
    'a Score written as a bare number still opens');

  const third = lawn.join({ id: 'reader3' });
  lawn.say(third, { t: 'i', k: 'good-2' });
  assert.equal(third.said.find(m => m.t === 'you').s, 300, 'and so does the record after the bad one');

  // The unreadable one is gone, and that is the whole of the damage.
  const fourth = lawn.join({ id: 'reader4' });
  lawn.say(fourth, { t: 'i', k: 'broken' });
  const fresh = fourth.said.find(m => m.t === 'you');
  assert.notEqual(fresh.key, 'broken', 'an unreadable record is not handed back');
  assert.equal(fresh.s, 0, 'the Mower it belonged to starts again');
  console.log('Storage: one unreadable record costs one Mower, not the board.');
}

console.log('\nThe Lawn holds together: Fields crown, Bumps are refereed, the log waits, the board persists.');
process.exit(0);
