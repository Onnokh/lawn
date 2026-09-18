export const MAX_SPEED = 25;
export const ROAD_SPEED = 20;

type Driver = { x: number; y: number; a: number; v: number; travel?: number; draft?: number;
  braking?: boolean; brakeWindow?: number; slide?: number; brakePressure?: number; driftGrip?: number };
type Peer = { x: number; y: number; vx?: number; vy?: number; seen: number };

/** Only a moving mower ahead, travelling the same way, can give a tow. */
export function slipstream(me: Driver, peers: Iterable<Peer>, now: number,
  onRoad: (x: number, y: number) => number): number {
  if (me.v < 7 || onRoad(me.x, me.y) < 0.5) return 0;
  const angle = me.travel ?? me.a;
  const fx = Math.cos(angle), fy = Math.sin(angle);
  let tow = 0;
  for (const p of peers) {
    if (now - p.seen > 500 || onRoad(p.x, p.y) < 0.5) continue;
    const speed = Math.hypot(p.vx ?? 0, p.vy ?? 0);
    if (speed < 7 || ((p.vx ?? 0) * fx + (p.vy ?? 0) * fy) / speed < 0.85) continue;
    const dx = p.x - me.x, dy = p.y - me.y;
    const ahead = dx * fx + dy * fy;
    const side = Math.abs(dx * fy - dy * fx);
    if (ahead < 5 || ahead > 28) continue;
    tow = Math.max(tow, Math.max(0, 1 - side / (2.8 + ahead * 0.06)) * Math.min(1, (28 - ahead) / 10));
  }
  return tow;
}

/** Heading and travel separate during a drift, then grip pulls them together. */
export function stepDrive(me: Driver, input: { throttle: number; turn: number; brake: boolean;
  road: number; grass: number; tow: number; stunned: boolean; rain?: number }, dt: number) {
  const { road, grass, stunned } = input;
  const rain = input.rain ?? 0;
  const throttle = stunned ? 0 : input.throttle;
  const turn = stunned ? 0 : input.turn;
  const brake = !stunned && input.brake;
  // A tap can precede steering slightly; holding the brake never retriggers it.
  me.brakeWindow = Math.max(0, (me.brakeWindow ?? 0) - dt);
  if (brake && !me.braking) me.brakeWindow = 0.25;
  me.braking = brake;
  me.slide = Math.max(0, (me.slide ?? 0) - dt);
  // Wet ground breaks loose on its own: a hard enough turn slips it without a
  // brake tap at all, and the sharper the turn needs to be normally, the less
  // rain it takes to bring that bar down.
  const wetSlip = !stunned && rain > 0 && me.v > 9 && Math.abs(turn) > 0.6 - rain * 0.15;
  if (!stunned && ((me.brakeWindow > 0 && me.v > 7 && Math.abs(turn) > 0.15) || wetSlip)) {
    me.slide = 1.6 + rain * 1.1;
    me.brakeWindow = 0;
  }
  if (stunned || me.v < 5 || Math.abs(turn) < 0.1) me.slide = 0;
  const drifting = me.slide > 0;
  // Tyres load and unload progressively, so a tap keeps the mower's momentum.
  me.brakePressure = (me.brakePressure ?? 0) + (Number(brake) - (me.brakePressure ?? 0))
    * (1 - Math.exp(-dt / (brake ? 0.22 : 0.08)));
  me.driftGrip = (me.driftGrip ?? 0) + (Number(drifting) - (me.driftGrip ?? 0))
    * (1 - Math.exp(-dt / (drifting ? 0.16 : 0.2)));
  const target = stunned ? 0 : input.tow;
  me.draft = (me.draft ?? 0) + (target - (me.draft ?? 0)) * (1 - Math.exp(-dt / (target > (me.draft ?? 0) ? 0.8 : 3)));
  const boost = me.draft * road;
  // Wet grass clings to the deck a little; wet tarmac does not, so it takes
  // the grip term instead, below.
  const drag = (5.5 + 1.9 * grass - 2.25 * road + me.driftGrip * 0.25 + me.brakePressure * 5 - boost * 0.7 + rain * grass * 0.8) * (stunned ? 3 : 1);
  const accel = (62 + 6 * road) * (1 + boost * 0.8);
  const decay = Math.exp(-drag * dt);
  me.v = me.v * decay + throttle * (1 - me.brakePressure) * accel / drag * (1 - decay);
  // Coast down after leaving the road; don't snap the speed at the verge.
  me.v = Math.max(-6.5, Math.min(MAX_SPEED, me.v));
  const limit = 13 + (ROAD_SPEED - 13) * road + 8 * boost;
  if (me.v > limit) me.v = limit + (me.v - limit) * Math.exp(-dt * 7);
  // Grip caps how fast a Mower can turn its heading, below; wet ground gives
  // the tyres less to bite into, so the cap comes down and steering goes soft.
  const grip = (14 + road * (18 + me.driftGrip * 16)) * (1 - rain * 0.3);
  const ask = turn * 3 * Math.min(1, 0.25 + Math.abs(me.v) / 4);
  const hold = grip / Math.max(0.01, Math.abs(me.v));
  me.travel ??= me.a;
  me.a += Math.max(-hold, Math.min(hold, ask)) * dt * Math.sign(me.v || 1);
  const gap = Math.atan2(Math.sin(me.a - me.travel), Math.cos(me.a - me.travel));
  me.travel += gap * (1 - Math.exp(-dt / (0.055 + me.driftGrip * 0.325)));
  return { vx: Math.cos(me.travel) * me.v, vy: Math.sin(me.travel) * me.v, drifting };
}
