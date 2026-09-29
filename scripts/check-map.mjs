/**
 * Read the map the way a Mower does, and say whether it holds together.
 *
 * Water that cannot be crossed is only fair while every Field can still be
 * reached. This walks the Lawn from one dry Tile, through the Shallows as a
 * Mower wades them, and reports what it could not get to, along with how
 * much of the Lawn is Water, Path, Street and grass. It holds the map to four
 * rules and fails if one of them breaks:
 *
 * - every Field is one piece, so no Street or run of Water splits a parcel.
 *   A Field is cut only when all of it is cut, so even a crumb of one Tile
 *   that the wander of a Path has pinched off is a split;
 * - a Mower can reach every Tile of dry ground, and can cut every Tile of
 *   every Field. One tuft in a pocket no Mower can enter is a quest nobody
 *   can finish. A Mower wades into the Shallows to cut the grass beside the
 *   Water, which is what keeps every Tile of it in reach;
 * - no Tile is both wet and on a Street, which is what lets the shoreline
 *   ignore the seams and stay continuous;
 * - the Deep parts the banks. The Lawn reads a swath every `WATER_STEP` for
 *   the Deep, so a swath strides over it where it is narrower than a step.
 *   That is allowed only where a Mower could have waded round instead, so
 *   the two ends of every stride must be joined through water the Lawn lets
 *   a Mower into, close by. Where the Deep has thinned out in the middle of a
 *   run, that way round is the Bridge, and the rule fails.
 *
 *     node scripts/check-map.mjs [width] [height]
 */
import { MOW_RADIUS, COLLISION_RADIUS } from '../public/mowing.js';
import { FIELD_NAMES, placeAt, blocked, SHALLOWS } from '../public/fields.js';
import { STREET_HALF_WIDTH } from '../public/road.js';
import { treeAt } from '../public/trees.js';

const W = Number(process.argv[2] ?? 408);
const H = Number(process.argv[3] ?? 272);
const RADIUS = COLLISION_RADIUS;
const MOW = MOW_RADIUS;
/** The Lawn's `WATER_STEP`, in `src/index.ts`. */
const WATER_STEP = 0.75;
/** How close by the way round a stride must be, in Tiles. */
const WADE_ROUND = 2;

const field = new Int8Array(W * H);
const wet = new Float32Array(W * H);
const street = new Uint8Array(W * H);
const open = new Uint8Array(W * H);
for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
  const place = placeAt(x + 0.5, y + 0.5, W, H);
  field[y * W + x] = place.field;
  wet[y * W + x] = place.wet;
  street[y * W + x] = place.street <= STREET_HALF_WIDTH ? 1 : 0;
  open[y * W + x] = blocked(x + 0.5, y + 0.5, W, H, RADIUS) ? 0 : 1;
}

// Where a Mower can drive, from the middle of the Lawn outwards.
const seen = new Uint8Array(W * H);
let start = -1;
for (let r = 0; r < W && start < 0; r++) {
  for (let a = 0; a < 64 && start < 0; a++) {
    const x = Math.round(W / 2 + Math.cos(a) * r), y = Math.round(H / 2 + Math.sin(a) * r);
    if (x >= 0 && y >= 0 && x < W && y < H && open[y * W + x]) start = y * W + x;
  }
}
const stack = [start];
seen[start] = 1;
while (stack.length) {
  const i = stack.pop();
  const x = i % W, y = (i / W) | 0;
  for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
    const nx = x + dx, ny = y + dy;
    if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
    const j = ny * W + nx;
    if (seen[j] || !open[j]) continue;
    seen[j] = 1;
    stack.push(j);
  }
}

// A Tile is cut from where a Mower can stand, not only where it stands.
const mowable = new Uint8Array(W * H);
const reach = Math.ceil(MOW);
for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
  if (!seen[y * W + x]) continue;
  for (let dy = -reach; dy <= reach; dy++) for (let dx = -reach; dx <= reach; dx++) {
    if (dx * dx + dy * dy > MOW * MOW) continue;
    const nx = x + dx, ny = y + dy;
    if (nx >= 0 && ny >= 0 && nx < W && ny < H) mowable[ny * W + nx] = 1;
  }
}

const counts = FIELD_NAMES.map(() => ({ tiles: 0, reached: 0, first: -1 }));
let shallows = 0, deep = 0, paved = 0, bare = 0, grass = 0, cutOff = 0, drowned = 0;
for (let i = 0; i < W * H; i++) {
  if (wet[i] > SHALLOWS) deep++;
  else if (wet[i] > 0) shallows++;
  else if (street[i]) paved++;
  else if (field[i] < 0) bare++;
  else {
    grass++;
    const one = counts[field[i]];
    one.tiles++;
    if (one.first < 0) one.first = i;
    if (mowable[i]) one.reached++;
  }
  // A Street is dry by construction. If one is not, the shoreline has a step
  // in it, because `placeAt` only clamps the Water on the ring.
  if (wet[i] > 0 && street[i]) drowned++;
  if (open[i] && !seen[i]) cutOff++;
}

/**
 * A Field is one piece. This is the rule a Street has to obey: it may run
 * along a parcel, and it may not run through one.
 */
function pieceOf(id, from) {
  const piece = new Uint8Array(W * H);
  const stack = [from];
  piece[from] = 1;
  let size = 0;
  while (stack.length) {
    const i = stack.pop();
    size++;
    const x = i % W, y = (i / W) | 0;
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const nx = x + dx, ny = y + dy;
      if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
      const j = ny * W + nx;
      if (piece[j] || field[j] !== id) continue;
      piece[j] = 1;
      stack.push(j);
    }
  }
  return size;
}
const split = counts.map(({ tiles, first }, id) => tiles - (first < 0 ? 0 : pieceOf(id, first)));

/**
 * The strides over the Deep, and whether a Mower could have waded round each
 * one. Ground the Lawn lets a Mower onto is read on a lattice eight to the
 * Tile, finer than any stretch of the Deep a stride can miss.
 */
const lawnBlocked = (x, y) => placeAt(x, y, W, H).wet > SHALLOWS || treeAt(x, y, W, H);
const FINE = 8, NW = W * FINE + 1, NH = H * FINE + 1;
const lattice = new Uint8Array(NW * NH);
function openNode(i, j) {
  const k = j * NW + i;
  if (!lattice[k]) lattice[k] = lawnBlocked(i / FINE, j / FINE) ? 2 : 1;
  return lattice[k] === 1;
}
function nearestNode(x, y) {
  let best = null;
  for (let dj = -2; dj <= 3; dj++) for (let di = -2; di <= 3; di++) {
    const i = Math.floor(x * FINE) + di, j = Math.floor(y * FINE) + dj;
    if (i < 0 || j < 0 || i >= NW || j >= NH || !openNode(i, j)) continue;
    const d = Math.hypot(i / FINE - x, j / FINE - y);
    if (!best || d < best.d) best = { i, j, d };
  }
  return best;
}
function wadesRound(x0, y0, x1, y1) {
  const from = nearestNode(x0, y0), to = nearestNode(x1, y1);
  if (!from || !to) return false;
  const seen = new Set([from.j * NW + from.i]);
  const queue = [[from.i, from.j]];
  for (let q = 0; q < queue.length; q++) {
    const [i, j] = queue[q];
    if (i === to.i && j === to.j) return true;
    for (const [di, dj] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const ni = i + di, nj = j + dj;
      if (ni < 0 || nj < 0 || ni >= NW || nj >= NH) continue;
      if ((ni / FINE - x0) ** 2 + (nj / FINE - y0) ** 2 > WADE_ROUND * WADE_ROUND) continue;
      const k = nj * NW + ni;
      if (seen.has(k) || !openNode(ni, nj)) continue;
      seen.add(k);
      queue.push([ni, nj]);
    }
  }
  return false;
}
let strides = 0;
const leaps = [];
for (let y = 0.25; y < H; y += 0.5) for (let x = 0.25; x < W; x += 0.5) {
  const here = placeAt(x, y, W, H).wet;
  if (here <= SHALLOWS - 1.2 || here > SHALLOWS || treeAt(x, y, W, H)) continue;
  for (let k = 0; k < 32; k++) {
    const ca = Math.cos(k * Math.PI / 16), sa = Math.sin(k * Math.PI / 16);
    const x1 = x + ca * WATER_STEP, y1 = y + sa * WATER_STEP;
    if (lawnBlocked(x1, y1)) continue;
    let over = false;
    for (let t = 0.02; t < WATER_STEP && !over; t += 0.02) over = placeAt(x + ca * t, y + sa * t, W, H).wet > SHALLOWS;
    if (!over) continue;
    strides++;
    if (!wadesRound(x, y, x1, y1)) leaps.push([x, y]);
  }
}

const total = W * H;
console.log(`Lawn ${W} x ${H} = ${total} Tiles`);
console.log(`  grass ${grass} (${(100 * grass / total).toFixed(1)}%)`);
console.log(`  path, verge and bank ${bare} (${(100 * bare / total).toFixed(1)}%)`);
console.log(`  street ${paved} (${(100 * paved / total).toFixed(1)}%)`);
console.log(`  water ${shallows + deep} (${(100 * (shallows + deep) / total).toFixed(1)}%): ${shallows} Shallows, ${deep} Deep`);
console.log(`  dry ground a Mower cannot reach: ${cutOff} Tiles`);
console.log(`  wet Tiles on a Street: ${drowned}`);
console.log(`  strides over the Deep: ${strides}, ${leaps.length} with no way round`);
for (const [i, name] of FIELD_NAMES.entries()) {
  const { tiles, reached } = counts[i];
  const share = tiles ? (100 * reached / tiles).toFixed(1) : '0.0';
  const cut = split[i] ? `, ${split[i]} off the main piece` : '';
  const pocket = tiles - reached ? `, ${tiles - reached} in a pocket` : '';
  console.log(`  ${name.padEnd(18)} ${String(tiles).padStart(6)} Tiles, ${share}% mowable${cut}${pocket}`);
}

// A picture of it, one character per few Tiles.
const step = Math.ceil(W / 118);
let picture = '';
for (let y = 0; y < H; y += step * 2) {
  for (let x = 0; x < W; x += step) {
    const i = y * W + x;
    picture += wet[i] > SHALLOWS ? '~' : wet[i] > 0 ? ':' : field[i] < 0 ? '.' : String.fromCharCode(48 + field[i]);
  }
  picture += '\n';
}
console.log(picture);

const broken = [];
if (cutOff) broken.push(`${cutOff} Tiles of dry ground a Mower cannot reach`);
if (drowned) broken.push(`${drowned} wet Tiles on a Street`);
if (leaps.length) {
  const at = leaps.slice(0, 3).map(([x, y]) => `${x},${y}`).join('; ');
  broken.push(`${leaps.length} strides over the Deep with no way round within ${WADE_ROUND} Tiles, first at ${at}`);
}
for (const [i, name] of FIELD_NAMES.entries()) {
  if (split[i]) broken.push(`${name} is split: ${split[i]} Tiles are off its main piece`);
  const pocket = counts[i].tiles - counts[i].reached;
  if (pocket) broken.push(`${name} has ${pocket} Tiles of grass a Mower cannot cut, so it can never be finished`);
}
if (broken.length) {
  console.error('The map does not hold together:');
  for (const line of broken) console.error(`  ${line}`);
  process.exit(1);
}
console.log('The map holds together.');
