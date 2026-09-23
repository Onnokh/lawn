import assert from 'node:assert/strict';
import { BALL_RADIUS as R, BALL_STEP, createBall, ballMoving, hitBall, stepBall } from '../public/ball.js';
const dry = () => -100;
const tick = (b, seconds, wet = dry) => {
  for (let t = 0; t < seconds; t += BALL_STEP) stepBall(b, BALL_STEP, 408, 272, wet);
};
const ball = createBall(100, 100);
const first = hitBall(ball, {id:'a', x:97, y:100, vx:10, vy:0}, 1000);
assert.ok(first && ball.vx > 10 && ball.vz > 0, 'hit follows mower direction with lift');
const singleLift = ball.vz;
const second = hitBall(ball, {id:'b', x:ball.x + 3, y:100, vx:-10, vy:0}, 1100, first);
assert.ok(second && ball.vz > singleLift + 5, 'opposing hits launch the ball');
let peak = ball.z;
for (let i = 0; i < 120; i++) { tick(ball, BALL_STEP); peak = Math.max(peak, ball.z); }
assert.ok(peak > 5, 'combined hit has visible vertical travel');
tick(ball, 30);
assert.ok(!ballMoving(ball), 'ball settles and can let the server sleep');
assert.equal(ball.z, R);

const parked = createBall(100,100);
assert.equal(hitBall(parked,{id:'parked',x:97,y:100,vx:0,vy:0},1000), undefined);
assert.equal(parked.vz,0,'parked mowers do not generate bounce energy');
const high = createBall(100,100); high.z = 8;
assert.equal(hitBall(high,{id:'a',x:99,y:100,vx:10,vy:0},1000),undefined,'high ball clears mower');
const edge = createBall(406,100); edge.vx = 12;
tick(edge, .3);
assert.ok(edge.vx < 0 && edge.x <= 408-R, 'outer boundary reflects ball');
const bank = createBall(95,100); bank.vx=12;
tick(bank,1, x=>x-100);
assert.ok(bank.x < 100-R && bank.vx < 0, 'bank reflects rolling ball');
const airborne = createBall(95,100); airborne.vx = 12; airborne.z = 10;
tick(airborne,.5,x=>x-100);
assert.ok(airborne.x >100 && airborne.z>R+.8,'airborne ball clears bank');

const landing = createBall(100,100); landing.z = R + 0.2; landing.vz = -4;
tick(landing,0.5,x=>2.6-Math.abs(x-100));
assert.ok(2.6-Math.abs(landing.x-100) <= -R, 'ditch-centre landing returns to a reachable bank');

// Keep driving at full speed after contact: the ball must visibly break away.
for (const rolling of [0, 9.5]) {
  const fast = createBall(100, 100);
  fast.vx = rolling;
  const mower = {id:'fast',x:96.5,y:100,vx:11,vy:0};
  assert.ok(hitBall(fast,mower,1000));
  tick(fast,0.5);
  const gap = fast.x - (mower.x + mower.vx * 0.5) - (R + 2.21);
  assert.ok(gap > 3, `full-speed hit breaks away from rolling speed ${rolling}: gap ${gap}`);
  assert.ok(fast.z > R + 0.8, 'hard hit is visibly airborne after half a second');
}
const gentle = createBall(100,100);
const nudge = hitBall(gentle,{id:'slow',x:97,y:100,vx:2,vy:0},1000);
assert.ok(gentle.vx < 4 && gentle.vz < 3, 'gentle nudges remain controllable');

// The Bonk is heard at the contact's force, so a nudge and a charge must not
// arrive at the same loudness, and neither may leave the 0..1 the sound takes.
const charge = hitBall(createBall(100,100),{id:'fast',x:97,y:100,vx:13,vy:0},1000);
for (const [what, contact] of [['nudge', nudge], ['charge', charge]]) {
  assert.ok(contact.force > 0 && contact.force <= 1, `${what} force stays within 0..1`);
}
assert.ok(charge.force > nudge.force + 0.3, 'a charge bonks harder than a nudge');
assert.ok(nudge.force < 0.3, 'a nudge stays quiet');

console.log('Ball direction, combined lift, gravity, settling, parked contact, height clearance, bounds, banks and bonk force pass.');
