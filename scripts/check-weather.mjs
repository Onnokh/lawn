import assert from 'node:assert/strict';
import { rainIntensityAt, effectiveElapsedMs, WEATHER_CYCLE_MS, RAIN_GROWTH_MULTIPLIER, RAIN_RAMP_MS } from '../public/weather.js';
import { stepDrive } from '../public/driving.js';

// Sweep a long span of Cycles and record which ones rain, and for how long
// their intensity reads above zero.
const CYCLES = 400;
const SPAN_MS = CYCLES * WEATHER_CYCLE_MS;
let rainySamples = 0, totalSamples = 0, sawDry = false, sawWet = false;
const STEP_MS = 5000;
for (let t = 0; t < SPAN_MS; t += STEP_MS) {
  const r = rainIntensityAt(t);
  assert.ok(r >= 0 && r <= 1, 'intensity stays within 0..1');
  totalSamples++;
  if (r > 0) { rainySamples++; sawWet = true; } else sawDry = true;
}
assert.ok(sawDry && sawWet, 'the sweep sees both calm and rainy stretches');
const rainyFraction = rainySamples / totalSamples;
assert.ok(rainyFraction > 0.05 && rainyFraction < 0.6, `rain is occasional, not constant or absent (${rainyFraction})`);

// A moment right at the start of a Cycle, and one deep inside it, should not
// differ in whether later code can trust the ramp: it always fades from 0.
for (let c = 0; c < 50; c++) {
  const start = c * WEATHER_CYCLE_MS;
  if (rainIntensityAt(start + 1) > 0) {
    assert.equal(rainIntensityAt(start), 0, 'rain never starts already at full intensity');
    assert.ok(rainIntensityAt(start + RAIN_RAMP_MS) > 0.9, 'rain reaches full intensity after its ramp');
  }
}

// Regrowth: a span with confirmed Rain in it must be worth more effective
// time than an equal span with none, and a span with no Rain at all must
// equal the plain elapsed time exactly.
let foundRainySpan = false, foundDrySpan = false;
for (let c = 0; c < 200 && !(foundRainySpan && foundDrySpan); c++) {
  const from = c * WEATHER_CYCLE_MS, to = from + WEATHER_CYCLE_MS;
  const plain = to - from;
  const effective = effectiveElapsedMs(from, to);
  assert.ok(effective >= plain - 1e-6, 'rain can only add effective time, never remove it');
  if (effective > plain + 1) { foundRainySpan = true; assert.ok(effective <= plain * RAIN_GROWTH_MULTIPLIER + 1); }
  else foundDrySpan = true;
}
assert.ok(foundRainySpan && foundDrySpan, 'both a rained-on cycle and a dry cycle turn up in 200 tries');

// Splitting a span at any point must total the same as measuring it whole:
// the walk over cycles must not double count or skip a boundary.
const from = 37 * WEATHER_CYCLE_MS + 1000, mid = from + 3 * WEATHER_CYCLE_MS + 5000, to = mid + 4 * WEATHER_CYCLE_MS + 9000;
const whole = effectiveElapsedMs(from, to);
const parts = effectiveElapsedMs(from, mid) + effectiveElapsedMs(mid, to);
assert.ok(Math.abs(whole - parts) < 1e-6, 'a span split at a boundary sums to the same total');
assert.equal(effectiveElapsedMs(to, from), 0, 'a span running backwards counts as no time at all');

// A Tile that has never been mown carries the Unix epoch as its moment —
// decades of Cycles back. That must resolve instantly, not walk them all.
const started = Date.now();
const neverMown = effectiveElapsedMs(0, Date.now());
assert.ok(Date.now() - started < 50, 'a Tile with the epoch as its moment resolves without walking every cycle since 1970');
assert.ok(neverMown > 365 * 24 * 60 * 60 * 1000, 'and still reads as having grown for a very long time');

// Rain in the drive model: less grip, and grass drags a little more.
const input = { throttle: 1, turn: 0, brake: false, road: 0, grass: 1, tow: 0, stunned: false };
const dry = { x: 0, y: 0, a: 0, v: 0 }, wet = { x: 0, y: 0, a: 0, v: 0 };
for (let i = 0; i < 5 * 60; i++) {
  stepDrive(dry, { ...input, turn: 1 }, 1 / 60);
  stepDrive(wet, { ...input, turn: 1, rain: 1 }, 1 / 60);
}
assert.ok(Math.abs(wet.a) < Math.abs(dry.a) * 0.9, 'full rain leaves a mower slower to turn into a corner');
assert.ok(wet.v < dry.v, 'a soaked lawn drags on the mower a little more than a dry one');

// A hard turn at speed should break a wet mower loose without ever tapping the
// brake, and leave it sliding for longer than a dry brake-tap slide would.
const roadInput = { throttle: 1, turn: 0, brake: false, road: 1, grass: 0, tow: 0, stunned: false };
const fast = { x: 0, y: 0, a: 0, v: 0 };
for (let i = 0; i < 3 * 60; i++) stepDrive(fast, roadInput, 1 / 60);
const slipped = stepDrive({ ...fast }, { ...roadInput, turn: 1, rain: 1 }, 1 / 60);
assert.ok(slipped.drifting, 'a hard turn on a wet road slips without any brake tap');
const notSlipped = stepDrive({ ...fast }, { ...roadInput, turn: 1, rain: 0 }, 1 / 60);
assert.ok(!notSlipped.drifting, 'the same turn on a dry road does not');
const wetSlide = { ...fast }; stepDrive(wetSlide, { ...roadInput, turn: 1, rain: 1 }, 1 / 60);
const drySlide = { ...fast }; stepDrive(drySlide, { ...roadInput, turn: 1, brake: true }, 1 / 60);
assert.ok(wetSlide.slide > drySlide.slide, 'a wet slide lasts longer than a dry brake-tap slide');

console.log('Weather: rain is occasional and ramped, Regrowth counts it correctly and additively, and it loosens a mower\'s grip.');
