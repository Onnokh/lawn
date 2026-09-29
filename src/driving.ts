export const MAX_SPEED = 25;
/** How fast a Mower may go on a Street. Off one, the limit is 13. */
export const STREET_SPEED = 20;

/**
 * Seconds for a soaked Mower to dry to a third of how wet it was. Rain keeps
 * it wet for longer, and water soaks it again in a moment.
 */
export const DRY_SECONDS = 2.6;

type Driver = { x: number; y: number; a: number; v: number; travel?: number; draft?: number;
  braking?: boolean; brakeWindow?: number; slide?: number; brakePressure?: number; driftGrip?: number;
  soak?: number };

/**
 * How wet a Mower is, from 0 to 1, after `dt` more seconds at this depth. It
 * is the same for every Mower on every screen: the client works it out for
 * the Mowers it only sees, from where they stand, to drip them the same way.
 */
export function soakAfter(soak: number, wade: number, rain: number, dt: number): number {
  if (wade > 0) return soak + (1 - soak) * (1 - Math.exp(-dt * 10 * wade));
  const left = soak * Math.exp(-dt / (DRY_SECONDS * (1 + rain * 2)));
  // A halving never ends, and a Mower does dry.
  return left < 0.02 ? 0 : left;
}

/**
 * How wet the tyres must be to break loose on their own. A Mower drier than
 * this grips like a dry one, so a slide out of the Water ends within seconds
 * and not whenever the halving happens to reach nothing.
 */
const SLIPPERY = 0.25;
type Peer = { x: number; y: number; vx?: number; vy?: number; seen: number };

/** Only a moving mower ahead, travelling the same way, can give a tow. */
export function slipstream(me: Driver, peers: Iterable<Peer>, now: number,
  onStreet: (x: number, y: number) => number): number {
  if (me.v < 7 || onStreet(me.x, me.y) < 0.5) return 0;
  const angle = me.travel ?? me.a;
  const fx = Math.cos(angle), fy = Math.sin(angle);
  let tow = 0;
  for (const p of peers) {
    if (now - p.seen > 500 || onStreet(p.x, p.y) < 0.5) continue;
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

/**
 * Heading and travel separate during a drift, then grip pulls them together.
 *
 * `wade` is how far the Mower stands in the Water, from 0 on dry ground to 1
 * as deep as it may go. Water holds it back while it is in, and leaves it
 * soaked when it comes out: a soaked Mower's tyres slip on the ground under
 * them, so it slides through a turn until it has dried.
 */
export function stepDrive(me: Driver, input: { throttle: number; turn: number; brake: boolean;
  street: number; grass: number; tow: number; stunned: boolean; rain?: number; wade?: number }, dt: number) {
  const { street, grass, stunned } = input;
  const rain = input.rain ?? 0;
  const wade = input.wade ?? 0;
  me.soak = soakAfter(me.soak ?? 0, wade, rain, dt);
  // Water on the tyres is water on the ground: it lowers the bar to a slip
  // the way rain does. In the Water itself the Water holds the Mower instead.
  const soaked = me.soak * (1 - wade);
  const slick = Math.max(rain, soaked >= SLIPPERY ? soaked : 0);
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
  // rain it takes to bring that bar down. Wet tyres bring down the speed it
  // takes as well.
  const wetSlip = !stunned && slick > 0 && me.v > 9 - soaked * 3 && Math.abs(turn) > 0.6 - slick * 0.15;
  if (!stunned && ((me.brakeWindow > 0 && me.v > 7 && Math.abs(turn) > 0.15) || wetSlip)) {
    me.slide = 1.6 + slick * 1.1;
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
  const boost = me.draft * street;
  // Wet grass clings to the deck a little; wet tarmac does not, so it takes
  // the grip term instead, below. The Water drags on the whole machine.
  // Wet tyres spin up and lock up alike: a soaked Mower gathers speed and
  // sheds it more slowly, brakes too, and settles at the same pace.
  const spin = 1 - 0.45 * soaked;
  const drag = (5.5 + 1.9 * grass - 2.25 * street + me.driftGrip * 0.25 + me.brakePressure * 5 - boost * 0.7 + rain * grass * 0.8 + 5 * wade)
    * spin * (stunned ? 3 : 1);
  const accel = (62 + 6 * street) * (1 + boost * 0.8) * spin;
  const decay = Math.exp(-drag * dt);
  me.v = me.v * decay + throttle * (1 - me.brakePressure) * accel / drag * (1 - decay);
  // Coast down after leaving the Street; don't snap the speed at the verge.
  me.v = Math.max(-6.5, Math.min(MAX_SPEED, me.v));
  const limit = (13 + (STREET_SPEED - 13) * street + 8 * boost) * (1 - 0.5 * wade);
  if (me.v > limit) me.v = limit + (me.v - limit) * Math.exp(-dt * 7);
  // Grip caps how fast a Mower can turn its heading, below; wet ground gives
  // the tyres less to bite into, so the cap comes down and steering goes soft.
  const grip = (14 + street * (18 + me.driftGrip * 16)) * (1 - rain * 0.3) * (1 - soaked * 0.3);
  const ask = turn * 3 * Math.min(1, 0.25 + Math.abs(me.v) / 4);
  const hold = grip / Math.max(0.01, Math.abs(me.v));
  me.travel ??= me.a;
  me.a += Math.max(-hold, Math.min(hold, ask)) * dt * Math.sign(me.v || 1);
  const gap = Math.atan2(Math.sin(me.a - me.travel), Math.cos(me.a - me.travel));
  // Wet tyres let the travel lag the heading: the Mower slides out of a turn.
  me.travel += gap * (1 - Math.exp(-dt / (0.055 + me.driftGrip * 0.325 + soaked * 0.4)));
  return { vx: Math.cos(me.travel) * me.v, vy: Math.sin(me.travel) * me.v, drifting };
}
