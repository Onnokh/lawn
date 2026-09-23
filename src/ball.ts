/** Shared fixed-step physics. x/y lie on the lawn; z is height above it. */
export const BALL_RADIUS = 1.65;
export const BALL_STEP = 1 / 60;
const MOWER_RADIUS = 2.21;
const GRAVITY = 22;
export interface Ball {
  x: number; y: number; z: number;
  vx: number; vy: number; vz: number;
  rollX: number; rollY: number;
}
export interface BallMower {
  id: string; x: number; y: number; vx: number; vy: number;
}
/** `force` is how hard the hit landed, 0 to 1: a nudge is near 0, a full-speed
 * charge is 1. It is what the Bonk is heard at, so it rides on the contact. */
export interface BallContact { id: string; at: number; nx: number; ny: number; force: number }
export function createBall(x: number, y: number): Ball {
  return { x, y, z: BALL_RADIUS, vx: 0, vy: 0, vz: 0, rollX: 0, rollY: 0 };
}
export function ballMoving(b: Ball): boolean {
  return b.z > BALL_RADIUS || b.vx !== 0 || b.vy !== 0 || b.vz !== 0;
}

/** Returns the contact used to combine hits from different mowers. */
export function hitBall(b: Ball, mower: BallMower, now: number, previous?: BallContact): BallContact | undefined {
  if (b.z > BALL_RADIUS + 2.3) return;
  const dx = b.x - mower.x, dy = b.y - mower.y;
  const distance = Math.hypot(dx, dy);
  if (distance >= BALL_RADIUS + MOWER_RADIUS) return;
  const speed = Math.hypot(mower.vx, mower.vy);
  const nx = distance > 0.001 ? dx / distance : speed > 0.01 ? mower.vx / speed : 1;
  const ny = distance > 0.001 ? dy / distance : speed > 0.01 ? mower.vy / speed : 0;
  // Correct overlap even when both bodies are at rest, without adding energy.
  b.x = mower.x + nx * (BALL_RADIUS + MOWER_RADIUS + 0.02);
  b.y = mower.y + ny * (BALL_RADIUS + MOWER_RADIUS + 0.02);
  const closing = (mower.vx - b.vx) * nx + (mower.vy - b.vy) * ny;
  if (closing < 0.3 || (previous?.id === mower.id && now - previous.at < 180)) return;
  const forward = mower.vx * nx + mower.vy * ny;
  const hard = Math.max(0, Math.min(1, (forward - 5) / 6));
  // A hard hit must outrun the mower even when it catches a rolling ball.
  // Relative speed alone leaves the ball trapped in a repeated dribble.
  const normalSpeed = b.vx * nx + b.vy * ny;
  const launch = Math.max(normalSpeed + closing * 1.7, forward + hard * 9);
  const impulse = Math.min(36, launch - normalSpeed);
  b.vx += nx * impulse;
  b.vy += ny * impulse;
  const together = previous && previous.id !== mower.id && now - previous.at < 220;
  const opposition = together ? (1 - (nx * previous.nx + ny * previous.ny)) * 0.5 : 0;
  b.vz = Math.max(b.vz, Math.min(11, Math.max(1.2 + closing * 0.32 + hard * 5, hard * 8.5)));
  if (together) b.vz = Math.min(17, b.vz + 5 + opposition * 5);
  const horizontal = Math.hypot(b.vx, b.vy);
  if (horizontal > 30) { b.vx *= 30 / horizontal; b.vy *= 30 / horizontal; }
  return { id: mower.id, at: now, nx, ny, force: Math.min(1, impulse / 20) };
}

export function stepBall(b: Ball, dt: number, width: number, height: number,
  wetAt: (x: number, y: number) => number): void {
  const oldX = b.x, oldY = b.y;
  b.x += b.vx * dt; b.y += b.vy * dt;
  b.vz -= GRAVITY * dt;
  b.z += b.vz * dt;
  if (b.z < BALL_RADIUS) {
    b.z = BALL_RADIUS;
    b.vz = Math.abs(b.vz) > 1.5 ? -b.vz * 0.62 : 0;
  }
  const drag = Math.exp(-(b.z <= BALL_RADIUS ? 1.35 : 0.16) * dt);
  b.vx *= drag; b.vy *= drag;
  for (const [position, velocity, limit] of [['x', 'vx', width], ['y', 'vy', height]] as const) {
    if (b[position] < BALL_RADIUS || b[position] > limit - BALL_RADIUS) {
      b[position] = Math.max(BALL_RADIUS, Math.min(limit - BALL_RADIUS, b[position]));
      b[velocity] *= -0.72;
    }
  }
  // Banks keep the toy on the lawn; an airborne ball can clear a ditch.
  if (b.z < BALL_RADIUS + 0.8 && wetAt(b.x, b.y) > -BALL_RADIUS) {
    const dx = wetAt(b.x + 0.1, b.y) - wetAt(b.x - 0.1, b.y);
    const dy = wetAt(b.x, b.y + 0.1) - wetAt(b.x, b.y - 0.1);
    const length = Math.hypot(dx, dy);
    if (length > 0.0001) {
      const nx = -dx / length, ny = -dy / length;
      const penetration = Math.min(6, wetAt(b.x, b.y) + BALL_RADIUS + 0.1);
      b.x += nx * penetration; b.y += ny * penetration;
      const into = b.vx * nx + b.vy * ny;
      if (into < 0) { b.vx -= 1.65 * into * nx; b.vy -= 1.65 * into * ny; }
    } else { b.x = oldX; b.y = oldY; b.vx *= -0.6; b.vy *= -0.6; }
    // Landing on the centre of a ditch can have no usable bank normal.
    // Put the ball on nearby dry ground so it remains reachable.
    if (wetAt(b.x, b.y) > -BALL_RADIUS) {
      const cx = b.x, cy = b.y;
      shore: for (let radius = 0.5; radius <= 12; radius += 0.5) {
        for (let k = 0; k < 24; k++) {
          const angle = k * Math.PI / 12;
          const x = cx + Math.cos(angle) * radius, y = cy + Math.sin(angle) * radius;
          if (x >= BALL_RADIUS && x <= width - BALL_RADIUS && y >= BALL_RADIUS
            && y <= height - BALL_RADIUS && wetAt(x, y) <= -BALL_RADIUS) {
            b.x = x; b.y = y;
            break shore;
          }
        }
      }
    }
  }
  b.rollX += (b.y - oldY) / BALL_RADIUS;
  b.rollY -= (b.x - oldX) / BALL_RADIUS;
  if (b.z === BALL_RADIUS && b.vz === 0 && Math.hypot(b.vx, b.vy) < 0.15) {
    b.vx = 0; b.vy = 0;
  }
}
