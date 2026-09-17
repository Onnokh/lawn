/**
 * The map of the Lawn.
 *
 * One table of seeds says everything. A Field is the ground that lies nearer
 * its own seed than any other, so the Fields are parcels of an irregular
 * shape and not a grid of boxes. The seam between two Fields is a lane, and a
 * seam named in `DITCHES` carries water instead: a Ditch a Mower cannot
 * cross. Every Ditch is cut by one Bridge, at the middle point between the
 * two seeds it runs between, so no Field is ever shut off.
 *
 * Everything here is a pure function of a point. Nothing is stored and
 * nothing is sent: the client, the shader and the Lawn each work out the same
 * map from the same table. `src/index.ts` holds a copy of `placeAt` for the
 * same reason the Growth Rate is copied there, and the two must stay
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
  [0.15, 0.19], [0.47, 0.13], [0.83, 0.20],
  [0.13, 0.53], [0.44, 0.46], [0.79, 0.51],
  [0.19, 0.85], [0.52, 0.81], [0.86, 0.84],
];

/** Half the width of a lane, in Tiles. Nothing grows on it. */
export const LANE = 2.3;
/** Half the width of open water, in Tiles. A Mower cannot enter it. */
export const DITCH = 2.6;
/** Bare bank between the water and the grass, in Tiles. */
export const BANK = 1.6;
/** Radius of the Bridge that cuts every Ditch, in Tiles. */
export const BRIDGE = 6;

/**
 * The seams that carry water. Four of them: enough that a Mower has to read
 * the map and drive round, and little enough that the Lawn is still a lawn.
 */
export const DITCHES = [[1, 4], [3, 4], [5, 8], [6, 7]];

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
 * - `field` is the Field that owns it, or -1 for a lane, a bank or the water.
 * - `wet` is how far it lies inside the water, in Tiles. It is negative on
 *   dry ground, so it is the room a Mower has left before it goes in.
 *
 * `edge` is half the difference between the two nearest seeds. It is about
 * the distance to the seam in Tiles, which is what the widths above measure.
 */
export function placeAt(x, y, width, height) {
  if (x < 0 || y < 0 || x >= width || y >= height) return { field: -1, wet: -BRIDGE };
  const px = warpX(x, y), py = warpY(x, y);
  let first = 0, d0 = Infinity, d1 = Infinity;
  const distances = [];
  for (let k = 0; k < SEEDS.length; k++) {
    const dx = px - SEEDS[k][0] * width, dy = py - SEEDS[k][1] * height;
    const d = Math.sqrt(dx * dx + dy * dy);
    distances.push(d);
    if (d < d0) { d1 = d0; d0 = d; first = k; }
    else if (d < d1) { d1 = d; }
  }
  const edge = (d1 - d0) * 0.5;
  let wet = -BRIDGE;
  // Measure every ditch, even across a field boundary. Switching the nearest
  // pair at a junction must not cut off the shoreline or its collision margin.
  for (const [a, b] of DITCHES) {
    const across = Math.abs(distances[a] - distances[b]) * 0.5;
    let third = Infinity;
    for (let k = 0; k < SEEDS.length; k++) {
      if (k !== a && k !== b) third = Math.min(third, distances[k]);
    }
    // Leave a dry lane before the third field, with rounded bank corners.
    const end = (third - Math.max(distances[a], distances[b])) * 0.5 - LANE - BANK;
    const shore = water(DITCH - across - SHORE_RADIUS, end - SHORE_RADIUS) + SHORE_RADIUS;
    const bx = (SEEDS[a][0] + SEEDS[b][0]) * 0.5 * width;
    const by = (SEEDS[a][1] + SEEDS[b][1]) * 0.5 * height;
    const span2 = (px - bx) ** 2 + (py - by) ** 2;
    const along = Math.sqrt(Math.max(0, span2 - across * across));
    wet = Math.max(wet, water(shore, along - BRIDGE));
  }
  const lane = LANE + 0.35 * Math.sin(x * 0.19 + y * 0.11);
  return { field: edge <= lane || wet > -BANK ? -1 : first, wet };
}

/**
 * How far a point lies inside the water, from how far it is inside the Ditch
 * (`into`) and how far it is past the Bridge (`beyond`). Both are positive in
 * the water, and then the nearer bank is the answer. Outside, the answer is
 * the real distance to the corner where the Bridge meets the Ditch: the
 * smaller of the two on its own would call the dry Bridge wet, and seal it.
 */
function water(into, beyond) {
  if (into > 0 && beyond > 0) return Math.min(into, beyond);
  const dx = Math.max(0, -into), dy = Math.max(0, -beyond);
  return -Math.sqrt(dx * dx + dy * dy);
}

/** Which Field a point belongs to, or -1 for a lane, a bank or the water. */
export function fieldAt(x, y, width, height) {
  return placeAt(x, y, width, height).field;
}

/** How far a point lies inside the water, in Tiles. Negative on dry ground. */
export function wetAt(x, y, width, height) {
  return placeAt(x, y, width, height).wet;
}

/** Water a Mower of this radius cannot drive into. */
export function blocked(x, y, width, height, radius) {
  return wetAt(x, y, width, height) > -radius;
}

/**
 * Grass a Mower can stand on, as near as possible to the point it asked for.
 * It walks outwards in a spiral, so it always answers, and it answers the
 * same point on every screen. Grass and not a lane: a Mower that opens the
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
    if (place.wet > -radius) continue;
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
 * How much of a Field may stand and the Field still count as cut: one part in
 * a hundred. Without it the end of a quest is not mowing, it is searching —
 * one tuft in ten thousand Tiles, somewhere in a parcel the size of a screen,
 * and the Mower that plainly cut the Field has to comb it to be told so.
 */
export const FIELD_SLACK = 0.01;

/**
 * How far through a Field a Mower is, from 0 to 100.
 *
 * It measures against the goal and not against the last blade, so the bar
 * fills exactly as the quest completes. A Field that reads 97% still has 3%
 * standing and is not finished: the Slack is what the number is measured
 * against, not a number taken off the end of it.
 */
export function fieldProgress(tiles, heightAt) {
  if (!tiles.length) return 0;
  let remaining = 0;
  for (const i of tiles) {
    // Short stubble counts as cut, so slow regrowth doesn't prevent completion.
    remaining += Math.max(0, Math.min(1, (heightAt(i) - 0.1) / 0.9));
  }
  const cut = 1 - remaining / tiles.length;
  return 100 * Math.min(1, cut / (1 - FIELD_SLACK));
}

/**
 * The map as one picture, painted once per size of Lawn. The minimap draws a
 * window on it. A picture is what keeps the corner map and the map M opens
 * honest: both read the Lawn the same way `placeAt` does, so neither can draw
 * a path that is not there.
 */
export function buildMapImage(width, height, scale = 2) {
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(width * scale);
  canvas.height = Math.round(height * scale);
  const g = canvas.getContext('2d');
  const image = g.createImageData(canvas.width, canvas.height);
  const px = image.data;
  // A parcel of its own green, so one Field is read from the next.
  const greens = SEEDS.map((_, i) => [
    78 + (i % 3) * 7 - (i / 3 | 0) * 4,
    108 + ((i * 5) % 4) * 9,
    52 + (i % 2) * 8,
  ]);
  for (let y = 0; y < canvas.height; y++) {
    for (let x = 0; x < canvas.width; x++) {
      const wx = (x + 0.5) / scale, wy = (y + 0.5) / scale;
      const { field, wet } = placeAt(wx, wy, width, height);
      let c;
      if (wet > 0) c = wet > 1.2 ? [52, 96, 128] : [78, 126, 152];
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
 * The map, in the shader's own words. It is built from the table above, so
 * the ground a Mower drives on and the ground it sees are one map and cannot
 * drift apart. Only the fringe is the shader's own: a lane reads better with
 * a broken edge, and the water does not, because the water is where the
 * Mower stops.
 */
export const MAP_WGSL = `
const LANE = ${LANE.toFixed(3)};
const DITCH = ${DITCH.toFixed(3)};
const BANK = ${BANK.toFixed(3)};
const BRIDGE = ${BRIDGE.toFixed(3)};
const SHORE_RADIUS = ${SHORE_RADIUS.toFixed(3)};
const SEED_COUNT = ${SEEDS.length};

fn warpPoint(p : vec2f) -> vec2f {
  return vec2f(p.x + 7.0 * sin(p.y * 0.052 + 0.6) + 2.6 * sin(p.y * 0.127 + 2.1),
               p.y + 7.0 * sin(p.x * 0.045) + 2.6 * sin(p.x * 0.103 + 1.3));
}

/** The same answer as \`water\` in this file, in the shader's own words. */
fn waterDepth(into : f32, beyond : f32) -> f32 {
  if (into > 0.0 && beyond > 0.0) { return min(into, beyond); }
  return -length(vec2f(max(0.0, -into), max(0.0, -beyond)));
}

/** x is the distance to the nearest seam, y the water depth, z the Field. */
fn placeAt(p : vec2f) -> vec3f {
  var seeds = array<vec2f, SEED_COUNT>(${SEEDS.map(([u, v]) => `vec2f(${u.toFixed(4)}, ${v.toFixed(4)})`).join(', ')});
  let q = warpPoint(p);
  var distances : array<f32, SEED_COUNT>;
  var first = 0;
  var d0 = 1e20;
  var d1 = 1e20;
  for (var k = 0; k < SEED_COUNT; k = k + 1) {
    let d = length(q - seeds[k] * C.misc2.xy);
    distances[k] = d;
    if (d < d0) { d1 = d0; d0 = d; first = k; }
    else if (d < d1) { d1 = d; }
  }
  let edge = (d1 - d0) * 0.5;
  var wet = -BRIDGE;
  let ditches = array<vec2i, ${DITCHES.length}>(${DITCHES.map(([a, b]) => `vec2i(${a}, ${b})`).join(', ')});
  for (var i = 0; i < ${DITCHES.length}; i = i + 1) {
    let a = ditches[i].x;
    let b = ditches[i].y;
    let across = abs(distances[a] - distances[b]) * 0.5;
    var third = 1e20;
    for (var k = 0; k < SEED_COUNT; k = k + 1) {
      if (k != a && k != b) { third = min(third, distances[k]); }
    }
    let end = (third - max(distances[a], distances[b])) * 0.5 - LANE - BANK;
    let shore = waterDepth(DITCH - across - SHORE_RADIUS, end - SHORE_RADIUS) + SHORE_RADIUS;
    let mid = (seeds[a] + seeds[b]) * 0.5 * C.misc2.xy;
    let offset = q - mid;
    let along = sqrt(max(0.0, dot(offset, offset) - across * across));
    wet = max(wet, waterDepth(shore, along - BRIDGE));
  }
  return vec3f(edge, wet, f32(first));
}

/** 1 on the grass, 0 on a lane, a bank or the water. The verge is soft. */
fn pathGrass(p : vec2f) -> f32 {
  let place = placeAt(p);
  let fringe = (vnoise(p * 1.2) - 0.5) * 0.7;
  let lane = smoothstep(LANE, LANE + 1.8, place.x + fringe);
  // The bank is bare to BANK Tiles from the water, the same answer placeAt
  // gives, and the grass then comes in over the same width as a verge.
  let bank = smoothstep(BANK, BANK + 1.8, -place.y + fringe);
  return min(lane, bank);
}

/** How far a point lies inside the water, in Tiles. Negative on dry ground. */
fn waterAt(p : vec2f) -> f32 {
  return placeAt(p).y;
}
`;

export function createFieldQuests() {
  const banner = document.getElementById('field-banner');
  const bannerTitle = document.getElementById('field-banner-name');
  const bannerLabel = document.getElementById('field-banner-label');
  const list = document.getElementById('world-quest-list');
  const here = document.getElementById('world-quest-here');
  const done = document.getElementById('world-quest-done');
  let width = 0, height = 0, fields = [];
  let rows = [];
  let active = -1, candidate = -1, candidateSince = 0, checkedAt = -Infinity;
  let hideBanner;

  function announce(name, label) {
    clearTimeout(hideBanner);
    bannerTitle.textContent = name;
    bannerLabel.textContent = label;
    banner.classList.add('visible');
    hideBanner = setTimeout(() => banner.classList.remove('visible'), 3200);
  }

  return {
    resize(w, h) {
      if (w === width && h === height) return;
      width = w; height = h;
      fields = buildFields(w, h);
      active = candidate = -1;
      checkedAt = -Infinity;
      rows = fields.map(field => {
        const row = document.createElement('li');
        row.className = 'world-quest';
        row.innerHTML = `<span class="world-quest-badge" aria-hidden="true"></span><div class="world-quest-copy"><div class="world-quest-heading"><span class="world-quest-title"></span><span class="world-quest-percent">0%</span></div><span class="world-quest-status"></span><progress max="100" value="0"></progress></div>`;
        row.querySelector('.world-quest-title').textContent = field.name;
        const meter = row.querySelector('progress');
        meter.setAttribute('aria-label', `${field.name} grass cut`);
        return { row, meter, badge: row.querySelector('.world-quest-badge'), status: row.querySelector('.world-quest-status'), percent: row.querySelector('.world-quest-percent'), completed: false };
      });
      list.replaceChildren(...rows.map(({ row }) => row));
      here.textContent = '';
      done.textContent = `0 / ${fields.length} completed`;
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
        quest.percent.textContent = `${percent}%`;
        if (id === active) here.textContent = `${fields[id].name} ${percent}%`;
        if (!complete) return;
        quest.completed = true;
        quest.row.classList.add('completed');
        quest.badge.textContent = '✓';
        quest.status.textContent = 'Completed';
        announce(fields[id].name, 'World quest completed');
      });
      done.textContent = `${rows.filter(quest => quest.completed).length} / ${fields.length} completed`;
    },
  };
}
