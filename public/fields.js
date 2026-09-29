import { treeAt, treeEarthAt, EARTH_RADIUS, TREES } from './trees.js';
import { ringDistance, STREET_HALF_WIDTH, RING_WGSL } from './road.js';
import { MOWER_SCALE } from './mowing.js';

/**
 * The map of the Lawn.
 *
 * One table of seeds says where the Fields are, and one table of seams says
 * what lies between them. A Field is the ground that lies nearer its own seed
 * than any other, so the Fields are parcels of an irregular shape and not a
 * grid of boxes. The seam between two Fields is one of three things, and the
 * three are the whole map:
 *
 * - a **Path**, bare earth that a Mower crosses at the speed it was going;
 * - a **Street**, which a Mower drives fast on;
 * - **Water**, which it wades into at the edge and cannot cross but at the
 *   Bridge that cuts it.
 *
 * A Street is a boundary and never a cut. Every Street is either a seam,
 * which lies between two Fields by construction, or the ring, which lies
 * outside all of them: ground the ring would take out of the middle of a
 * parcel is verge, and not Field at all. So no Street splits a Field, and
 * `scripts/check-map.mjs` is what says so on the day a seed moves.
 *
 * Everything here is a pure function of a point. Nothing is stored and
 * nothing is sent: the client, the shader and the Lawn each work out the same
 * map from the same two tables. `src/index.ts` holds a copy of `placeAt` for
 * the same reason the Growth Rate is copied there, and the two must stay
 * identical or the two sides count different grass.
 */

export const FIELD_NAMES = [
  'Daisy Hollow', 'Cloverbank', 'Heron Reach',
  'Bramble Meadow', 'Buttercup Rise', 'Willow Bend',
  'The Long Acre', 'Foxglove Pasture', 'Mill Green',
];

/**
 * Where each Field sits, in fractions of the Lawn. They are in reading order,
 * so the tracker lists the Fields the way the map draws them, and the map
 * grows with the Lawn instead of being pinned to one size.
 */
export const SEEDS = [
  [0.20, 0.31], [0.40, 0.30], [0.60, 0.29], [0.80, 0.30],
  [0.17, 0.70], [0.335, 0.72], [0.50, 0.71], [0.665, 0.69], [0.83, 0.68],
];

/** Half the width of a Path, in Tiles. Nothing grows on it. */
export const PATH = 2.6;
/** Half the width of open Water, in Tiles. */
export const WATER = 3.4;
/**
 * Where the Shallows end and the Deep begins, in `wet`. A Mower drives
 * through Water shallower than this, slowly, and comes out of it wet; the Deep
 * in the middle of the run it cannot enter at all.
 *
 * The Deep is what keeps Water a seam. Where it parts the two banks it is
 * wider than the Lawn's `WATER_STEP`, so no Report strides over it, and the
 * Shallows and the bank beyond it keep the grass on the far side out of reach
 * of the blades. At its ends it narrows to nothing, and there the Shallows
 * join round it: a Mower may wade round the end of the Deep, where the
 * Bridge or a Street already takes it across. `scripts/check-map.mjs` holds
 * the map to that.
 */
export const SHALLOWS = 1.8;
/**
 * How deep a Mower's own client lets it wade: short of the Deep by a margin,
 * so the straight line the Lawn reads between two Reports never cuts a corner
 * into it. The Lawn stops a Mower at `SHALLOWS`, and an honest Mower never
 * gets there.
 */
export const WADE = SHALLOWS - 0.3;
/**
 * Bare bank between the Water and the grass, in Tiles.
 *
 * A Mower wades into the Shallows to cut the grass beside them, so the bank
 * need not be as wide as a Mower is. While all of the Water held a Mower off,
 * it had to be: `wet` is measured in the frame of the seam, and far from the
 * seeds one unit of it lies across as many as four Tiles of ground, so a
 * narrow bank there left tufts further from dry ground than the blades reach,
 * and a bank wide enough to reach them took 568 Tiles of grass.
 */
export const BANK = 1.6;
/** Radius of the Bridge that cuts every run of Water, in Tiles. */
export const BRIDGE = 6;

/**
 * What each seam is made of. A seam that is not named here is a Path.
 *
 * The Streets are every seam between the top row of Fields and the bottom
 * row, so they read as one run of road the whole width of the Lawn, and it
 * meets the ring at both ends. The Water lies within a row, which is what
 * keeps a run of it a detour and not a wall.
 */
export const SEAMS = {
  '0,4': 'street', '0,5': 'street', '1,5': 'street', '1,6': 'street',
  '2,6': 'street', '2,7': 'street', '3,7': 'street', '3,8': 'street',
  '1,2': 'water', '5,6': 'water', '7,8': 'water',
};

function seamsOfKind(kind) {
  return Object.keys(SEAMS).filter(key => SEAMS[key] === kind).map(key => key.split(',').map(Number));
}

/** The seams that carry Water. The client draws a Bridge at the middle of each. */
export const WATERS = seamsOfKind('water');
const STREETS = seamsOfKind('street');

const SHORE_RADIUS = 1.2;

/**
 * Bend the ground before the seeds are measured against it. Without this the
 * seams are straight lines and the Lawn reads as a diagram; with it they
 * meander the way a hedge and a ditch really do.
 */
function warpX(x, y) { return x + 7 * Math.sin(y * 0.052 + 0.6) + 2.6 * Math.sin(y * 0.127 + 2.1); }
function warpY(x, y) { return y + 7 * Math.sin(x * 0.045) + 2.6 * Math.sin(x * 0.103 + 1.3); }

/**
 * Where a point stands on the Lawn.
 *
 * - `field` is the Field that owns it, or -1 for a Path, a Street, a bank
 *   or the Water.
 * - `wet` is how far it lies inside the water, in Tiles. It is negative on
 *   dry ground, so it is the room a Mower has left before it goes in.
 * - `street` is how far it is from the nearest Street, measured inwards. It
 *   is negative on a Street and past one, so it is the room a Field has left
 *   before a Street would cut it.
 *
 * - `edge` is half the difference between the two nearest seeds. It is about
 *   the distance to the seam in Tiles, which is what the widths above
 *   measure, and it is what draws every Path.
 */
export function placeAt(x, y, width, height) {
  if (x < 0 || y < 0 || x >= width || y >= height) return { field: -1, wet: -BRIDGE, street: -BRIDGE, edge: 0 };
  const px = warpX(x, y), py = warpY(x, y);
  // The three nearest seeds, not the two. The third is what says where a seam
  // ends, and a Street needs that as much as the Water does.
  let first = 0, second = 0, third = 0;
  let d0 = Infinity, d1 = Infinity, d2 = Infinity;
  const distances = [];
  for (let k = 0; k < SEEDS.length; k++) {
    const dx = px - SEEDS[k][0] * width, dy = py - SEEDS[k][1] * height;
    const d = Math.sqrt(dx * dx + dy * dy);
    distances.push(d);
    if (d < d0) { d2 = d1; third = second; d1 = d0; second = first; d0 = d; first = k; }
    else if (d < d1) { d2 = d1; third = second; d1 = d; second = k; }
    else if (d < d2) { d2 = d; third = k; }
  }
  const edge = (d1 - d0) * 0.5;
  /** The nearest seed that is neither of these two. */
  const beside = (a, b) => (first !== a && first !== b ? d0 : (second !== a && second !== b ? d1 : d2));
  let wet = -BRIDGE;
  // One wander for the point, not one per run of Water: it depends on where
  // the point is and not on which seam is being measured, and `placeAt` is
  // read once per Tile of the Lawn on both sides.
  const wander = shoreWander(x, y);
  // Measure every run of Water, even across a field boundary. Switching the
  // nearest pair at a junction must not cut off the shoreline or its
  // collision margin.
  for (const [a, b] of WATERS) {
    const across = Math.abs(distances[a] - distances[b]) * 0.5;
    let third = Infinity;
    for (let k = 0; k < SEEDS.length; k++) {
      if (k !== a && k !== b) third = Math.min(third, distances[k]);
    }
    // Leave a dry Path before the third field, with rounded bank corners.
    const end = (third - Math.max(distances[a], distances[b])) * 0.5 - PATH - BANK;
    const shore = water(WATER + wander - across - SHORE_RADIUS, end + wander - SHORE_RADIUS) + SHORE_RADIUS;
    const bx = (SEEDS[a][0] + SEEDS[b][0]) * 0.5 * width;
    const by = (SEEDS[a][1] + SEEDS[b][1]) * 0.5 * height;
    const span2 = (px - bx) ** 2 + (py - by) ** 2;
    const along = Math.sqrt(Math.max(0, span2 - across * across));
    wet = Math.max(wet, water(shore, along - BRIDGE + wander));
  }
  // The room left before the ring: it grows towards the middle of the Lawn,
  // and is negative on the ring and past it, so the kerb is where a Field
  // stops and the verge begins.
  const kerb = -ringDistance(x, y, width, height);
  // How far the point is from the nearest Street.
  //
  // It is measured against the seam itself and not against the nearest pair
  // of seeds. Asking "does my nearest pair carry a Street" is a yes or a no,
  // and the map read it once per point: the gravel stopped dead along the
  // line where the second-nearest seed changes, which is a hard edge through
  // open ground and a Mower that loses the Street mid-corner.
  //
  // A seam is live while its own two seeds are nearer than any third. Past
  // the point where they are not — the junction where three Fields meet —
  // the distance is taken to that junction instead of to the line, so a
  // Street that ends rounds off over its own width. Before the junction the
  // answer is the distance to the seam, exactly as it was.
  let street = kerb;
  for (const [a, b] of STREETS) {
    const across = Math.abs(distances[a] - distances[b]) * 0.5;
    const past = Math.max(0, (Math.max(distances[a], distances[b]) - beside(a, b)) * 0.5);
    street = Math.min(street, Math.hypot(across, past));
  }
  // Nothing wet lies on a Street, or past the ring. This is safe only because
  // the answer above is a real distance and not a choice between two: clamped
  // on the old yes-or-no test, the shoreline gained a step where the
  // second-nearest seed changes — an invisible bank a Mower stopped at.
  wet = Math.min(wet, street - STREET_HALF_WIDTH);
  const path = PATH + 0.35 * Math.sin(x * 0.19 + y * 0.11);
  const bare = street <= STREET_HALF_WIDTH || edge <= path || wet > -BANK
    || treeEarthAt(x, y, width, height);
  return { field: bare ? -1 : first, wet, street, edge };
}

/** How much of a Street covers a point, from 0 to 1. */
export function streetAt(x, y, width, height) {
  return streetCover(placeAt(x, y, width, height).street);
}

/** A Street reads as one for the last 1.5 Tiles before its kerb. */
export function streetCover(street) {
  return Math.max(0, Math.min(1, (STREET_HALF_WIDTH - street) / 1.5));
}

/**
 * How far the shoreline of a run of Water wanders from the straight, in
 * Tiles.
 *
 * Without it the Water is a rectangle: `across` and `along` are the two sides
 * of a box drawn in the seam's own frame, and a box is what gets drawn. A
 * Path already wanders for the same reason, and the earth around a tree does
 * too. Three sines of the unwarped point, mean zero, so the Water keeps its
 * width on average and only its edge moves.
 */
function shoreWander(x, y) {
  return 0.55 * Math.sin(x * 0.23 + y * 0.17)
    + 0.3 * Math.sin(x * 0.11 - y * 0.31)
    + 0.16 * Math.sin(x * 0.47 + y * 0.39);
}

/**
 * How far a point lies inside the Water, from how far it is inside the run
 * (`into`) and how far it is past the Bridge (`beyond`). Both are positive in
 * the Water, and then the nearer bank is the answer. Outside, the answer is
 * the real distance to the corner where the Bridge meets the Water: the
 * smaller of the two on its own would call the dry Bridge wet, and seal it.
 */
function water(into, beyond) {
  if (into > 0 && beyond > 0) return Math.min(into, beyond);
  const dx = Math.max(0, -into), dy = Math.max(0, -beyond);
  return -Math.sqrt(dx * dx + dy * dy);
}

/** Which Field a point belongs to, or -1 for a Path, a Street, a bank or the Water. */
export function fieldAt(x, y, width, height) {
  return placeAt(x, y, width, height).field;
}

/** How far a point lies inside the Water, in Tiles. Negative on dry ground. */
export function wetAt(x, y, width, height) {
  return placeAt(x, y, width, height).wet;
}

/**
 * The Deep and the trunks a Mower of this radius cannot drive into.
 *
 * The Shallows are not in it: a Mower wades through them. The Water holds the
 * middle of a Mower and not its edge, so at `WADE` the nose may hang out over
 * the Deep, the way a Mower stands at the edge of a drop. A trunk holds the
 * edge, because a trunk is something to hit.
 */
export function blocked(x, y, width, height, radius) {
  return wetAt(x, y, width, height) > WADE || treeAt(x, y, width, height, radius);
}

/**
 * Where a Mower's wheels touch the ground, in Tiles along and across it: the
 * two rear wheels, then the two front ones.
 */
export const WHEELS = [[-0.57, -0.715], [-0.57, 0.715], [0.61, -0.715], [0.61, 0.715]]
  .map(([along, across]) => [along * MOWER_SCALE, across * MOWER_SCALE]);

/** How deep each wheel of a Mower stands, from 0 on dry ground to 1 at `WADE`. */
export function wheelDepths(x, y, heading, width, height) {
  const ca = Math.cos(heading), sa = Math.sin(heading);
  return WHEELS.map(([along, across]) => Math.max(0, Math.min(1,
    wetAt(x + ca * along - sa * across, y + sa * along + ca * across, width, height) / WADE)));
}

/**
 * How far a Mower stands in the Water, from 0 on dry ground to 1 at `WADE`:
 * the mean depth under its four wheels, so a Mower that noses in is a little
 * in and a Mower that is all the way in is all the way in.
 */
export function wadeAt(x, y, heading, width, height) {
  const depths = wheelDepths(x, y, heading, width, height);
  return (depths[0] + depths[1] + depths[2] + depths[3]) / 4;
}

/**
 * Grass a Mower can stand on, as near as possible to the point it asked for.
 * It walks outwards in a spiral, so it always answers, and it answers the
 * same point on every screen. Grass and not a Path: a Mower that opens the
 * page on a Bridge is a Mower with nothing to cut.
 */
export function dryStart(width, height, x = width / 2, y = height / 2, radius = 3) {
  let dry = null;
  for (let step = 0; step < 4000; step++) {
    // A spiral of points around the place that was asked for.
    const ring = Math.sqrt(step);
    const angle = step * 2.39996;
    const px = x + Math.cos(angle) * ring * 2.5;
    const py = y + Math.sin(angle) * ring * 2.5;
    if (px < radius || py < radius || px > width - radius || py > height - radius) continue;
    const place = placeAt(px, py, width, height);
    if (place.wet > -radius || treeAt(px, py, width, height, radius)) continue;
    if (place.field >= 0) return { x: px, y: py };
    dry = dry ?? { x: px, y: py };
  }
  return dry ?? { x: width / 2, y: height / 2 };
}

export function buildFields(width, height) {
  const fields = FIELD_NAMES.map(name => ({ name, tiles: [] }));
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const id = fieldAt(x + 0.5, y + 0.5, width, height);
    if (id >= 0) fields[id].tiles.push(y * width + x);
  }
  return fields;
}

/**
 * How far through a Field a Mower is, from 0 to 100.
 *
 * It measures against the last blade. A Field is cut when all of it is cut:
 * nothing stands for free, so 100 belongs to the stroke that takes the last
 * tuft. A Field used to count as cut with one part in a hundred standing,
 * which was a hundred Tiles nobody cut and a Field crowned all the same.
 */
export function fieldProgress(tiles, heightAt) {
  if (!tiles.length) return 0;
  let remaining = 0;
  for (const i of tiles) {
    // Short stubble counts as cut, so slow regrowth doesn't prevent completion.
    remaining += Math.max(0, Math.min(1, (heightAt(i) - 0.1) / 0.9));
  }
  return 100 * (1 - remaining / tiles.length);
}

/**
 * The map as one picture, painted once per size of Lawn. The minimap draws a
 * window on it. A picture is what keeps the corner map and the map M opens
 * honest: both read the Lawn the same way `placeAt` does, so neither can draw
 * a path that is not there.
 */
export function buildMapImage(width, height, done = [], scale = 2) {
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(width * scale);
  canvas.height = Math.round(height * scale);
  const g = canvas.getContext('2d');
  const image = g.createImageData(canvas.width, canvas.height);
  const px = image.data;
  // A parcel of its own green, so one Field is read from the next. A Field
  // that is finished is the pale, warm green of grass that has just been cut,
  // which is the same thing the Lawn itself says about ground a Mower has
  // been over: the map fills up as the Lawn comes in.
  const greens = SEEDS.map((_, i) => done[i] ? [150, 194, 108] : [
    78 + (i % 3) * 7 - (i / 3 | 0) * 4,
    108 + ((i * 5) % 4) * 9,
    52 + (i % 2) * 8,
  ]);
  for (let y = 0; y < canvas.height; y++) {
    for (let x = 0; x < canvas.width; x++) {
      const wx = (x + 0.5) / scale, wy = (y + 0.5) / scale;
      const { field, wet, street } = placeAt(wx, wy, width, height);
      let c;
      // The Shallows are the pale water: pale is where a Mower may drive.
      if (wet > 0) c = wet > SHALLOWS ? [52, 96, 128] : [96, 146, 164];
      else if (street <= STREET_HALF_WIDTH) c = [195, 171, 126];
      else if (field < 0) c = wet > -BANK ? [122, 104, 72] : [163, 138, 96];
      else c = greens[field];
      const i = (y * canvas.width + x) * 4;
      px[i] = c[0]; px[i + 1] = c[1]; px[i + 2] = c[2]; px[i + 3] = 255;
    }
  }
  g.putImageData(image, 0, 0);
  return canvas;
}

/**
 * Where a point stands, in the shader's own words: everything `placeAt`
 * needs and nothing else.
 *
 * It is built from the tables above, so the widths and the seams cannot drift
 * from the ones the Lawn uses. The working is not built from anything — it is
 * written twice, here and in JavaScript, and two hands write two answers.
 * `public/check-shader.html` is what holds them to one: it runs this very
 * string on the GPU and reads it against `placeAt` point by point. It is
 * separated out so that check can compile it without the rest of the shader,
 * which needs a lawn's worth of bindings to say anything at all.
 */
export const PLACE_WGSL = `
${RING_WGSL}
const PATH = ${PATH.toFixed(3)};
const WATER = ${WATER.toFixed(3)};
const SHALLOWS = ${SHALLOWS.toFixed(3)};
const BANK = ${BANK.toFixed(3)};
const BRIDGE = ${BRIDGE.toFixed(3)};
const SHORE_RADIUS = ${SHORE_RADIUS.toFixed(3)};
const SEED_COUNT = ${SEEDS.length};

fn warpPoint(p : vec2f) -> vec2f {
  return vec2f(p.x + 7.0 * sin(p.y * 0.052 + 0.6) + 2.6 * sin(p.y * 0.127 + 2.1),
               p.y + 7.0 * sin(p.x * 0.045) + 2.6 * sin(p.x * 0.103 + 1.3));
}

/** The same answer as \`shoreWander\` in this file. */
fn shoreWander(p : vec2f) -> f32 {
  return 0.55 * sin(p.x * 0.23 + p.y * 0.17)
    + 0.30 * sin(p.x * 0.11 - p.y * 0.31)
    + 0.16 * sin(p.x * 0.47 + p.y * 0.39);
}

/** The same answer as \`water\` in this file, in the shader's own words. */
fn waterDepth(into : f32, beyond : f32) -> f32 {
  if (into > 0.0 && beyond > 0.0) { return min(into, beyond); }
  return -length(vec2f(max(0.0, -into), max(0.0, -beyond)));
}

/**
 * x is the distance to the nearest seam, y the water depth, z the Field, and
 * w the room left before the nearest Street. The last is negative on a Street
 * and past one, which is what keeps a Street off the middle of a Field.
 */
fn placeAt(p : vec2f) -> vec4f {
  var seeds = array<vec2f, SEED_COUNT>(${SEEDS.map(([u, v]) => `vec2f(${u.toFixed(4)}, ${v.toFixed(4)})`).join(', ')});
  let q = warpPoint(p);
  var distances : array<f32, SEED_COUNT>;
  var first = 0;
  var second = 0;
  var third = 0;
  var d0 = 1e20;
  var d1 = 1e20;
  var d2 = 1e20;
  for (var k = 0; k < SEED_COUNT; k = k + 1) {
    let d = length(q - seeds[k] * C.misc2.xy);
    distances[k] = d;
    if (d < d0) { d2 = d1; third = second; d1 = d0; second = first; d0 = d; first = k; }
    else if (d < d1) { d2 = d1; third = second; d1 = d; second = k; }
    else if (d < d2) { d2 = d; third = k; }
  }
  let edge = (d1 - d0) * 0.5;
  var wet = -BRIDGE;
  let wander = shoreWander(p);
  let waters = array<vec2i, ${WATERS.length}>(${WATERS.map(([a, b]) => `vec2i(${a}, ${b})`).join(', ')});
  for (var i = 0; i < ${WATERS.length}; i = i + 1) {
    let a = waters[i].x;
    let b = waters[i].y;
    let across = abs(distances[a] - distances[b]) * 0.5;
    var third = 1e20;
    for (var k = 0; k < SEED_COUNT; k = k + 1) {
      if (k != a && k != b) { third = min(third, distances[k]); }
    }
    let end = (third - max(distances[a], distances[b])) * 0.5 - PATH - BANK;
    let shore = waterDepth(WATER + wander - across - SHORE_RADIUS, end + wander - SHORE_RADIUS) + SHORE_RADIUS;
    let mid = (seeds[a] + seeds[b]) * 0.5 * C.misc2.xy;
    let offset = q - mid;
    let along = sqrt(max(0.0, dot(offset, offset) - across * across));
    wet = max(wet, waterDepth(shore, along - BRIDGE + wander));
  }
  let kerb = -ringDistance(p);
  // The same answer as the Street loop in this file: measured against the
  // seam itself, so a Street that ends rounds off instead of stopping dead
  // along the line where the second-nearest seed changes.
  let streets = array<vec2i, ${STREETS.length}>(${STREETS.map(([a, b]) => `vec2i(${a}, ${b})`).join(', ')});
  var street = kerb;
  for (var i = 0; i < ${STREETS.length}; i = i + 1) {
    let a = streets[i].x;
    let b = streets[i].y;
    var beside = d2;
    if (first != a && first != b) { beside = d0; }
    else if (second != a && second != b) { beside = d1; }
    let across = abs(distances[a] - distances[b]) * 0.5;
    let past = max(0.0, (max(distances[a], distances[b]) - beside) * 0.5);
    street = min(street, length(vec2f(across, past)));
  }
  wet = min(wet, street - STREET_HALF_WIDTH);
  return vec4f(edge, wet, f32(first), street);
}

`;

/**
 * The map, in the shader's own words. Only the fringe is the shader's own: a
 * Path reads better with a broken edge, and the water does not, because the
 * water is where the Mower stops.
 */
export const MAP_WGSL = `
${PLACE_WGSL}
/** 1 on the grass, 0 on a Path, a Street, a bank or the Water. The verge is soft. */
fn pathGrass(p : vec2f) -> f32 {
  let place = placeAt(p);
  let fringe = (vnoise(p * 1.2) - 0.5) * 0.7;
  let path = smoothstep(PATH, PATH + 0.8, place.x + fringe);
  // The bank is bare to BANK Tiles from the Water, the same answer placeAt
  // gives, and the grass then comes in over the same width as a verge.
  let bank = smoothstep(BANK, BANK + 1.8, -place.y + fringe);
  var earth = 1.0;
  for (var i = 0u; i < ${TREES.length}u; i++) {
    let tree = TREE_PLACES[i];
    let delta = p - tree.xy * C.misc2.xy;
    let angle = atan2(delta.y, delta.x);
    let seed = tree.x * 37.0 + tree.y * 19.0;
    // Match treeEarthAt so the visible edge and mowing totals agree.
    let edge = (${EARTH_RADIUS.toFixed(2)} + 0.30 * sin(angle * 3.0 + seed)
      + 0.18 * sin(angle * 5.0 - seed * 2.0) + 0.09 * sin(angle * 9.0 + seed)) * tree.z;
    earth = min(earth, smoothstep(edge, edge + 0.45, length(delta)));
  }
  let street = smoothstep(STREET_HALF_WIDTH, STREET_HALF_WIDTH + 1.8, place.w + fringe);
  return min(min(min(path, bank), earth), street);
}

/** How far a point lies inside the Water, in Tiles. Negative on dry ground. */
fn waterAt(p : vec2f) -> f32 {
  return placeAt(p).y;
}
`;

/**
 * The tracker. `onComplete` is called the moment a Field is finished, because
 * the reward for finishing one belongs on the Lawn where the Mower is
 * looking, and the Lawn is drawn by the client and not by this file.
 */
export function createFieldQuests(onComplete = () => {}) {
  const banner = document.getElementById('field-banner');
  const bannerTitle = document.getElementById('field-banner-name');
  const bannerLabel = document.getElementById('field-banner-label');
  const bannerTally = document.getElementById('field-banner-tally');
  const list = document.getElementById('world-quest-list');
  const here = document.getElementById('world-quest-here');
  const done = document.getElementById('world-quest-done');
  let width = 0, height = 0, fields = [];
  let rows = [];
  let active = -1, candidate = -1, candidateSince = 0, checkedAt = -Infinity;
  /**
   * Whether the tracker has read the Lawn once. What it finds on that first
   * reading is what the Mower arrived to — Fields other people finished, or
   * this Mower finished yesterday — and none of it is worth a fanfare. Only
   * what is finished after that is.
   */
  let arrived = false;
  let hideBanner;

  /**
   * The banner says two different things and used to say them the same way.
   * Walking into a Field and finishing one are not the same event, and the
   * second one is the only thing on this Lawn a Mower can finish, so it gets
   * the gold, the tally and longer on the screen.
   */
  function announce(name, label, tally = '') {
    clearTimeout(hideBanner);
    bannerTitle.textContent = name;
    bannerLabel.textContent = label;
    bannerTally.textContent = tally;
    banner.classList.toggle('triumph', Boolean(tally));
    banner.classList.add('visible');
    hideBanner = setTimeout(() => banner.classList.remove('visible'), tally ? 4600 : 3200);
  }

  return {
    resize(w, h) {
      if (w === width && h === height) return;
      width = w; height = h;
      fields = buildFields(w, h);
      active = candidate = -1;
      checkedAt = -Infinity;
      arrived = false;
      rows = fields.map(field => {
        const row = document.createElement('li');
        row.className = 'world-quest';
        row.innerHTML = `<span class="world-quest-badge" aria-hidden="true"></span><div class="world-quest-copy"><div class="world-quest-heading"><span class="world-quest-title"></span><span class="world-quest-percent">0%</span></div><span class="world-quest-status"></span><progress max="100" value="0"></progress></div>`;
        row.querySelector('.world-quest-title').textContent = field.name;
        const meter = row.querySelector('progress');
        meter.setAttribute('aria-label', `${field.name} grass cut`);
        return { row, meter, badge: row.querySelector('.world-quest-badge'), status: row.querySelector('.world-quest-status'), percent: row.querySelector('.world-quest-percent'), completed: false, value: 0 };
      });
      list.replaceChildren(...rows.map(({ row }) => row));
      here.textContent = '';
      done.textContent = `0 / ${fields.length} completed`;
    },
    /**
     * How far each Field is, in the order the Fields are named. The map draws
     * this, so a Field reads the same on the map as it does in the tracker:
     * there is one answer and both of them show it.
     */
    standing() {
      return rows.map((quest, id) => ({ name: fields[id].name, percent: quest.value, completed: quest.completed }));
    },
    update(x, y, now, heightAt) {
      const next = fieldAt(x, y, width, height);
      // Crossing a path keeps the last objective until the next field is entered.
      if (next !== candidate) { candidate = next; candidateSince = now; }
      let entered = false;
      if (next >= 0 && next !== active && now - candidateSince >= 450) {
        active = next; entered = true;
        announce(fields[active].name, 'Field quest discovered');
        here.textContent = `${fields[active].name} ${rows[active].percent.textContent}`;
        rows.forEach(({ row }, id) => row.classList.toggle('active', id === active));
      }
      if (!entered && now - checkedAt < 500) return;
      checkedAt = now;
      rows.forEach((quest, id) => {
        if (quest.completed) return;
        const value = fieldProgress(fields[id].tiles, heightAt);
        const complete = value >= 100 - 1e-7;
        // Reserve 100% for completion, even when the remaining grass rounds away.
        const percent = complete ? 100 : Math.min(99, Math.floor(value + 1e-7));
        quest.meter.value = value;
        quest.value = percent;
        quest.percent.textContent = `${percent}%`;
        if (id === active) here.textContent = `${fields[id].name} ${percent}%`;
        if (!complete) return;
        quest.completed = true;
        quest.row.classList.add('completed');
        quest.badge.textContent = '✓';
        quest.status.textContent = 'Completed';
        if (!arrived) return;
        const cut = rows.filter(one => one.completed).length;
        announce(fields[id].name, 'Field complete',
          cut === fields.length ? 'The whole Lawn is cut' : `${cut} of ${fields.length} Fields cut`);
        onComplete(id, cut, fields.length);
      });
      arrived = true;
      done.textContent = `${rows.filter(quest => quest.completed).length} / ${fields.length} completed`;
    },
  };
}
