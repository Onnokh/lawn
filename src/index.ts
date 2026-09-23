import { treeAt, treeEarthAt } from "./trees";
import { ringDistance, STREET_HALF_WIDTH } from "./road";
import { MAX_SPEED } from "./driving";
import { effectiveElapsedMs } from "./weather";
import { motion } from "./positions";
import { MOW_RADIUS, COLLISION_RADIUS, forEachMownTile } from "./mowing";
import { BALL_RADIUS, BALL_STEP, createBall, ballMoving, hitBall, stepBall, type Ball, type BallMower, type BallContact } from "./ball";
import { ACHIEVEMENTS, FIELD_NAMES, FIELD_SLACK, countHeld, earnedMask, emptyTally, type Tally } from "./achievements";
import { trackEvent, type RybbitEnv } from "./analytics";
import { DurableObject } from "cloudflare:workers";

/**
 * The Lawn is one shared field of Tiles. A Tile stores only the moment it was
 * last mown. Blade Height is a pure function of the time since that moment, so
 * nothing ticks: the Lawn keeps growing while the Durable Object hibernates.
 */
const LAWN_WIDTH = 408;
const LAWN_HEIGHT = 272;
const TILE_COUNT = LAWN_WIDTH * LAWN_HEIGHT;

/**
 * Seconds a Tile needs to grow from mown to fully overgrown: 2 hours to 6
 * hours. No Tile grows at the speed of its neighbour: the Growth Rate moves
 * between these two bounds across the Lawn, so the field comes back uneven,
 * the way a real lawn does.
 */
const REGROW_MIN_SECONDS = 7200;
const REGROW_MAX_SECONDS = 21600;
/**
 * Seconds a Tile stays mown before its Regrowth starts. Without it the grass
 * behind the Mower is already coming back before the far side of a Field is
 * cut, and a Field can never read as wholly mown. One hour is long enough to
 * finish a Field and see it stand at 100%.
 */
const COOLDOWN_SECONDS = 3600;
/**
 * Width of one patch of like-minded grass, in Tiles. Below about ten the
 * Growth Rate reads as speckle on single Tiles instead of as slow ground.
 */
const PATCH_TILES = 16;
/**
 * Full scale of one Snapshot entry. A Snapshot carries how far a Tile is
 * through its Regrowth, not its age in seconds, so the wire does not change
 * when the Regrowth does. One step is a third of a second at the slowest
 * Growth Rate, far below one part in 255 of Blade Height.
 */
const SNAPSHOT_SCALE = 65535;

/** One lattice point of the Growth Rate noise, 0 to 1. */
function vigourAt(x: number, y: number): number {
  let h = Math.imul(x | 0, 0x27d4eb2d) ^ Math.imul(y | 0, 0x165667b1);
  h = Math.imul(h ^ (h >>> 15), 0x85ebca6b);
  h ^= h >>> 13;
  return (h >>> 0) / 4294967296;
}

/**
 * Seconds from a Mow Stroke to a fully overgrown Tile: the Cooldown first,
 * then the Regrowth. It is the span a Snapshot entry measures.
 */
function cycle(regrow: number): number {
  return COOLDOWN_SECONDS + regrow;
}

/**
 * Seconds of Regrowth for every Tile. It is a pure function of the position of
 * the Tile, so the client works out the same table and nothing is stored or
 * sent. Both sides hold it as a table because the Lawn is read Tile by Tile,
 * many times a second, and the noise is the same on every read.
 */
function regrowTable(width: number, height: number): Float32Array {
  const table = new Float32Array(width * height);
  const span = REGROW_MAX_SECONDS - REGROW_MIN_SECONDS;
  for (let y = 0; y < height; y++) {
    const gy = y / PATCH_TILES;
    const y0 = Math.floor(gy);
    const ty = gy - y0;
    const fy = ty * ty * (3 - 2 * ty);
    for (let x = 0; x < width; x++) {
      const gx = x / PATCH_TILES;
      const x0 = Math.floor(gx);
      const tx = gx - x0;
      const fx = tx * tx * (3 - 2 * tx);
      const a = vigourAt(x0, y0);
      const b = vigourAt(x0 + 1, y0);
      const c = vigourAt(x0, y0 + 1);
      const d = vigourAt(x0 + 1, y0 + 1);
      const top = a + (b - a) * fx;
      const bottom = c + (d - c) * fx;
      table[y * width + x] = REGROW_MIN_SECONDS + (top + (bottom - top) * fy) * span;
    }
  }
  return table;
}

/**
 * The map: where each seed of a Field sits, in fractions of the Lawn, how
 * wide a Path and a run of Water are, and what each seam is made of. It is
 * the same table as `public/fields.js` and must stay so: the two sides have
 * to agree on which Tiles are grass, or a score counts blades that were never
 * there.
 */
const SEEDS: [number, number][] = [
  [0.20, 0.31], [0.40, 0.30], [0.60, 0.29], [0.80, 0.30],
  [0.17, 0.70], [0.335, 0.72], [0.50, 0.71], [0.665, 0.69], [0.83, 0.68],
];
const PATH = 2.6;
const WATER = 3.4;
const BANK = 1.6;
const BRIDGE = 6;
/** Mirrors `SEAMS` in `public/fields.js`: the seams that carry Water, and the Streets. */
const WATERS = [[1, 2], [5, 6], [7, 8]];
const STREETS = [[0, 4], [0, 5], [1, 5], [1, 6], [2, 6], [2, 7], [3, 7], [3, 8]];
const SHORE_RADIUS = 1.2;

function warpX(x: number, y: number): number {
  return x + 7 * Math.sin(y * 0.052 + 0.6) + 2.6 * Math.sin(y * 0.127 + 2.1);
}
function warpY(x: number, y: number): number {
  return y + 7 * Math.sin(x * 0.045) + 2.6 * Math.sin(x * 0.103 + 1.3);
}

/**
 * How far the shoreline of a run of Water wanders from the straight, in Tiles.
 * Mirrors `shoreWander` in `public/fields.js`, which must stay identical or
 * the Lawn and the client disagree about which Tiles are grass.
 */
function shoreWander(x: number, y: number): number {
  return 0.55 * Math.sin(x * 0.23 + y * 0.17)
    + 0.3 * Math.sin(x * 0.11 - y * 0.31)
    + 0.16 * Math.sin(x * 0.47 + y * 0.39);
}

/** How far a point lies inside the water. Mirrors `water` in the client. */
function water(into: number, beyond: number): number {
  if (into > 0 && beyond > 0) return Math.min(into, beyond);
  const dx = Math.max(0, -into), dy = Math.max(0, -beyond);
  return -Math.sqrt(dx * dx + dy * dy);
}

/**
 * Where a point stands on the Lawn: the Field that owns it, or -1 for a Path,
 * a Street, a bank or the Water, and how far it lies inside the Water.
 * Mirrors `placeAt` in `public/fields.js` exactly.
 */
function placeAt(x: number, y: number, width: number, height: number): { field: number; wet: number; street: number; edge: number } {
  if (x < 0 || y < 0 || x >= width || y >= height) return { field: -1, wet: -BRIDGE, street: -BRIDGE, edge: 0 };
  const px = warpX(x, y), py = warpY(x, y);
  let first = 0, second = 0, third = 0;
  let d0 = Infinity, d1 = Infinity, d2 = Infinity;
  const distances: number[] = [];
  for (let k = 0; k < SEEDS.length; k++) {
    const dx = px - SEEDS[k][0] * width, dy = py - SEEDS[k][1] * height;
    const d = Math.sqrt(dx * dx + dy * dy);
    distances.push(d);
    if (d < d0) { d2 = d1; third = second; d1 = d0; second = first; d0 = d; first = k; }
    else if (d < d1) { d2 = d1; third = second; d1 = d; second = k; }
    else if (d < d2) { d2 = d; third = k; }
  }
  const edge = (d1 - d0) * 0.5;
  const beside = (a: number, b: number) =>
    (first !== a && first !== b ? d0 : (second !== a && second !== b ? d1 : d2));
  let wet = -BRIDGE;
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
  const kerb = -ringDistance(x, y, width, height);
  let street = kerb;
  for (const [a, b] of STREETS) {
    const across = Math.abs(distances[a] - distances[b]) * 0.5;
    const past = Math.max(0, (Math.max(distances[a], distances[b]) - beside(a, b)) * 0.5);
    street = Math.min(street, Math.hypot(across, past));
  }
  wet = Math.min(wet, street - STREET_HALF_WIDTH);
  const path = PATH + 0.35 * Math.sin(x * 0.19 + y * 0.11);
  const bare = street <= STREET_HALF_WIDTH || edge <= path || wet > -BANK
    || treeEarthAt(x, y, width, height);
  return { field: bare ? -1 : first, wet, street, edge };
}

/** Water and trunks stop reported strokes, whatever the client says. */
function blocked(x: number, y: number): boolean {
  return placeAt(x, y, LAWN_WIDTH, LAWN_HEIGHT).wet > 0
    || treeAt(x, y, LAWN_WIDTH, LAWN_HEIGHT);
}

/**
 * How far apart the Lawn reads the swath while it looks for water. A run of
 * Water is `2 * WATER` Tiles wide, so a step this short can never stride over
 * one.
 */
const WATER_STEP = 0.75;

const REGROW = regrowTable(LAWN_WIDTH, LAWN_HEIGHT);

/**
 * Which Field owns each Tile, or `NO_FIELD` for a Path, a Street, a bank or
 * the Water.
 *
 * It is the same answer `placeAt` gives, held as a table for the same reason
 * the Growth Rate is: the Lawn is read Tile by Tile, many times a second, and
 * `placeAt` measures nine seeds and three runs of Water for every read. The Mow
 * Stroke used to pay that price per Tile to ask whether grass grows there; it
 * now reads one byte, and gets the Field the Tile belongs to for nothing —
 * which is how the Lawn knows which Fields to read for a finish.
 */
const NO_FIELD = 255;
const FIELD_OF = new Uint8Array(TILE_COUNT);
/** Which Tiles each Field is made of. The Lawn walks these to read a Field. */
const FIELD_TILES: Uint32Array[] = [];
{
  const gathered: number[][] = FIELD_NAMES.map(() => []);
  for (let y = 0; y < LAWN_HEIGHT; y++) {
    for (let x = 0; x < LAWN_WIDTH; x++) {
      const field = placeAt(x + 0.5, y + 0.5, LAWN_WIDTH, LAWN_HEIGHT).field;
      FIELD_OF[y * LAWN_WIDTH + x] = field < 0 ? NO_FIELD : field;
      if (field >= 0) gathered[field].push(y * LAWN_WIDTH + x);
    }
  }
  for (const tiles of gathered) FIELD_TILES.push(Uint32Array.from(tiles));
}

/**
 * How far through a Field the Lawn is, from 0 to 100. It mirrors
 * `fieldProgress` in `public/fields.js` exactly, because the Tracker and the
 * Lawn have to call the same moment the finish: the Mower sees the Field light
 * up and the Achievement has to arrive with it, not a second behind.
 */
function fieldStanding(tiles: Uint32Array, mownAt: Uint32Array, now: number): number {
  if (!tiles.length) return 0;
  let remaining = 0;
  for (const i of tiles) {
    // Short stubble counts as cut, so slow regrowth doesn't prevent completion.
    remaining += Math.max(0, Math.min(1, (bladeHeight(mownAt[i], REGROW[i], now) - 0.1) / 0.9));
  }
  return 100 * Math.min(1, (1 - remaining / tiles.length) / (1 - FIELD_SLACK));
}

/**
 * How often the Lawn reads a Field it has just been cut on. A read walks some
 * eleven thousand Tiles, which is cheap, but not cheap enough to do ten times
 * a second for every Mower. A Field already near the line is read every time
 * instead, because the stroke that takes the last of it is the one that
 * matters and there may be no stroke after it.
 */
const FIELD_CHECK_MS = 300;
const FIELD_NEARLY = 95;

/**
 * How tall the grass on a Tile stands, from 0 to 1. A Tile nobody ever mowed
 * is fully overgrown. Mirrors `heightAt` in the client, which is what makes
 * the score the server counts the same score the Mower watches.
 *
 * Age is counted in effective seconds, not wall-clock seconds: a Tile that
 * sat through Rain has grown as if more time had passed. `effectiveElapsedMs`
 * works in milliseconds, so both ends of the span are scaled up and its
 * answer scaled back down.
 */
function bladeHeight(mownAt: number, regrow: number, now: number): number {
  const age = mownAt === 0 ? cycle(regrow) : effectiveElapsedMs(mownAt * 1000, now * 1000) / 1000;
  if (age >= cycle(regrow)) return 1;
  if (!(age > COOLDOWN_SECONDS) || !(regrow > 0)) return 0;
  const t = (age - COOLDOWN_SECONDS) / regrow;
  return 1 - (1 - t) * (1 - t);
}


/**
 * Room above that speed. A Mower pushed by another Mower moves without
 * driving, and the two clocks are not the same clock.
 */
const SPEED_TOLERANCE = 1.15;
/**
 * Seconds of travel a Mower may bank. Messages arrive in bursts after a
 * stall, and a Mower held up by the network really did drive the whole way,
 * so the budget is a bank and not a limit per message. It is also the longest
 * swath one Mow Stroke can cut: about 29 Tiles at full slipstream speed.
 */
const TRAVEL_BANK_SECONDS = 1;
const TRAVEL_RATE = MAX_SPEED * SPEED_TOLERANCE;
const TRAVEL_BANK = TRAVEL_RATE * TRAVEL_BANK_SECONDS;
/**
 * How far in front of its own last Mow Stroke a Mower may report itself. It
 * holds for the older `pos` message only: a Mow Stroke now carries the
 * heading, and a Mower is shown where the Lawn drove it to.
 */
const POSITION_SLACK = 2;

/**
 * Mow Strokes one Mower may send per second. A Mower sends about ten, and the
 * room above that is for a tab open across a deploy: that one still sends a
 * Mow Stroke every 40 ms, and it must not be throttled for it.
 */
const STROKE_RATE = 40;
/** Shortest gap between two resyncs to the same Mower. */
const RESYNC_GAP_MS = 1000;
/** Position reports one Mower may send per second. */
const POS_RATE = 30;
/** Emotes one Mower may send per second. */
const EMOTE_RATE = 2;
/**
 * Bumps one Mower may report per second. A Mower that is dazed keeps its
 * Grace, so an honest client reports a Bump once in four seconds at the most,
 * and one a second is already room to spare.
 */
const BUMP_RATE = 1;
/**
 * Mowers one address may have on the Lawn at once. Every socket earns its own
 * travel, so one person with many sockets cuts what many visitors cut. This
 * is the only thing that tells them apart, and it is a blunt one: a house, an
 * office and a whole mobile network each look like one address.
 */
const MOWERS_PER_ADDRESS = 12;
/** How many Emotes the wheel offers. The client holds the pictures. */
const EMOTE_COUNT = 5;
const STORAGE_KEY = "mownAt";
/**
 * The Tiles are one array, and a storage value holds at most 128 KiB, so the
 * array is written in chunks. The size of a chunk is not part of the format:
 * the chunks are read back in order and joined, so a Lawn written before this
 * one grew still loads.
 */
const CHUNK_BYTES = 96 * 1024;
const CHUNK_COUNT = Math.ceil((TILE_COUNT * 4) / CHUNK_BYTES);
const chunkKey = (k: number) => (k === 0 ? STORAGE_KEY : `${STORAGE_KEY}:${k}`);

async function readChunks(storage: DurableObjectStorage): Promise<ArrayBuffer | undefined> {
  // Read one key more than this Lawn writes, so a Lawn saved in smaller
  // chunks is still read whole.
  const keys = Array.from({ length: CHUNK_COUNT + 4 }, (_, k) => chunkKey(k));
  const stored = await storage.get<ArrayBuffer>(keys);
  const parts: ArrayBuffer[] = [];
  for (const key of keys) {
    const part = stored.get(key);
    if (!part) break;
    parts.push(part);
  }
  if (!parts.length) return undefined;
  if (parts.length === 1) return parts[0];
  const joined = new Uint8Array(parts.reduce((n, part) => n + part.byteLength, 0));
  let at = 0;
  for (const part of parts) {
    joined.set(new Uint8Array(part), at);
    at += part.byteLength;
  }
  return joined.buffer;
}
const STROKE_KEY = "strokes";
const SCORE_KEY = "scores";
/**
 * How long the Lawn holds its Mow Strokes before it writes them down. Every
 * write is four rows and every alarm is a request, and the Lawn is written
 * whole each time, so writing every two seconds spent more of the day's
 * budget than the mowing did. Ten seconds is short enough that the Lawn is
 * still awake when the alarm comes: a Lawn nobody is driving on is put out of
 * memory after a while, and what it had not written down goes with it. The
 * price of that is ten seconds of Mow Strokes on a Lawn that takes hours to
 * grow back.
 */
const PERSIST_DELAY_MS = 10000;
/**
 * Mowers the Lawn keeps a tally for. Past this it forgets the lowest score of
 * a Mower that is not driving, so the state of the Lawn stays bounded the way
 * the Tiles are. The Lawn remembers the two hundred best Mowers, and one that
 * was never among them starts again from nothing.
 */
const SCORE_KEEP = 200;
/**
 * Mowers the Lawn keeps at all, whatever they hold. A Mower that has earned an
 * Achievement is spared the ordinary pruning, because a lost Score can be mown
 * again and a lost Achievement cannot — but that exemption has to stop
 * somewhere, or the Lawn grows without bound. Every Score is written into one
 * storage value, and one storage value holds 128 KiB; a record runs to some two
 * hundred bytes, so this leaves the write about a fifth of that limit in hand.
 * Past it the Lawn forgets the lowest Score it holds, decorated or not.
 */
const KEY_KEEP = 500;
/**
 * How near two Mowers must be for the Lawn to believe a Bump, in Tiles. A
 * Mower is about five Tiles wide and the Lawn sees a position up to a report
 * old, so this is generous on purpose: it is here to catch a Mower that says
 * it was bumped with nobody beside it, not to referee the contact.
 */
const BUMP_REACH = 14;
/**
 * How much of the client's `STUN_SPEED` the Lawn asks of a Closing Speed
 * before it counts a Bump. The Lawn works the speed out from reports 100 ms
 * apart, so it reads a real ram lower than the client does; asking for the
 * whole of it would count almost nothing.
 */
const BUMP_CLOSING = 3;
/** How stale a report may be and still say where a Mower was for a Bump. */
const BUMP_STALE_MS = 1000;
/**
 * How fast a Mower must be driving, in Tiles a second, before a sharp bend in
 * its own swath counts as a drift and not a Mower that has simply stopped.
 * The client will not start a slide under `me.v > 7` either, so this asks
 * for a little less: the Lawn reads the speed as an average across a whole
 * Mow Stroke, which blurs a true peak down.
 */
const DRIFT_SPEED = 6;
/**
 * How far a Mower's nose must lie off the way it is actually travelling, in
 * radians, before it counts as a drift and not an ordinary corner. This is
 * what a slide is: the wheels stop taking the Mower where they point, so the
 * nose leads the swath. Steering alone cannot open that gap — the hardest
 * corner the drive model allows without breaking traction slips 0.15, and a
 * slide runs from 0.6 to 1.2 — so the bar sits in the space between them.
 */
const DRIFT_SLIP = 0.3;
/**
 * How far the swath must bend across one Mow Stroke, in radians, for the slip
 * to be a corner being taken and not a nose held crooked on a straight. It is
 * small on purpose: it asks only that the Mower is going somewhere round.
 */
const DRIFT_BEND = 0.02;
/** How long a gap between two Mow Strokes may be and still be one movement, and not two unrelated ones. */
const DRIFT_STALE_MS = 1000;
/**
 * Notes the Lawn keeps about what has lately happened on it, and how old one
 * may be and still be worth telling a Mower that has just arrived.
 *
 * They are held in memory and never written down. A Lawn only hibernates when
 * nobody is driving on it, so a Lawn that has forgotten its notes is a Lawn
 * where nothing has happened — which is exactly what an empty log says. What
 * this does buy is the thing a log is for: it survives a reload, and it tells
 * a Mower who has just walked in what it walked in on.
 */
const NOTE_KEEP = 20;
const NOTE_AGE_MS = 10 * 60 * 1000;
/**
 * How long a Mower may be away before the Lawn believes it has gone.
 *
 * A reload closes one socket and opens another on the same Mower Key, which is
 * not a Mower leaving and coming back — it is the same hands on the same
 * machine, and saying so twice in the corner is the log crying wolf. So
 * arriving and leaving are worked out per Key and not per socket: a Key with
 * any socket open is here, and one that goes quiet has this long to come back
 * before anybody is told.
 */
const REJOIN_GRACE_MS = 8000;
/**
 * Past this the Lawn stops caring that a Mower left. It only matters when the
 * last Mower goes and nothing sweeps the list again until somebody new
 * arrives, hours later: telling them that a stranger left before they got here
 * is worse than not telling them at all.
 */
const LEAVING_STALE_MS = 60000;
/**
 * Shortest gap between two tallies sent to the same Mower. The client counts
 * the blades itself so the digits roll smoothly, and this is how often the
 * Lawn overwrites that guess with what it really cut.
 */
const SCORE_GAP_MS = 250;

/**
 * A Mow Stroke says where the Mower is now and which way it points. The swath
 * is from where the Lawn last saw that Mower to there, so the Mower cannot
 * name its own starting point. It is the position report as well, because
 * both say the same thing about the same movement and a second message would
 * cost the Lawn a second time. `x1`/`y1` is the old name for the same point,
 * and a missing `a` the older shape, for a tab open across a deploy.
 */
type ClientMessage =
  | { t: "mow"; x: number; y: number; a?: number; vx?: number; vy?: number; seq?: number; x1?: number; y1?: number }
  /**
   * Where a Mower is and which way it points. A Mow Stroke now carries this,
   * so only a tab open across a deploy still sends it on its own.
   */
  | { t: "pos"; x: number; y: number; a: number }
  /**
   * Which Mower Key this one holds, or none. It is the first thing a Mower
   * says. The Key travels in a message and never in the address of the
   * socket: an address is written down by every machine it passes, and the
   * Key is the whole of the proof of who a Mower is.
   */
  | { t: "i"; k?: string }
  /** Which Emote a Mower shows. Relayed, never stored. */
  | { t: "emote"; e: number }
  /**
   * That this Mower has been bumped and is dazed. A Mower speaks only for
   * itself here, the same as with its position and its score: it cannot daze
   * another Mower, it can only say that it is dazed.
   */
  | { t: "bump" };

/**
 * What the Lawn keeps under one Mower Key: what that Mower is called, and the
 * blades it has cut.
 *
 * The name seed is not the `id`. An `id` is one per socket, so two tabs of one
 * browser stay two Mowers on the screen and neither writes over the other on
 * the board. The name seed is one per Key, so those two Mowers wear the same
 * name and the same colour, and so does the Mower that comes back tomorrow.
 */
interface Score {
  /** What it is called and coloured by. */
  n: string;
  /** Its blades. */
  c: number;
  /**
   * The Achievements it has earned, one bit each. A Score written before
   * Achievements existed carries none, and earns them on its next Mow Stroke
   * from what it already holds.
   */
  a?: number;
  /**
   * How often it stood in each Field as that Field was finished, in the order
   * of `FIELD_NAMES`.
   */
  q?: number[];
  /**
   * The blades it took off each Field, from when a Field was earned by cutting
   * a whole one yourself. Nothing reads it. It is dropped from a record the
   * first time the Lawn writes that record, so no old number is ever mistaken
   * for a count of finishes.
   */
  h?: number[];
  /** Tiles it has driven, as the Lawn drove it. */
  d?: number;
  /** Bumps the Lawn saw it in. */
  b?: number;
  /** Blades it took off while a Mow Stroke said it was drifting. */
  g?: number;
}

/**
 * Round a running total before it is written down. A Score is one storage
 * value for every Mower on the Lawn, and the last ten decimal places of a
 * distance are bytes spent on nothing.
 */
function tidy(value: number, places = 4): number {
  const scale = 10 ** places;
  return Math.round(value * scale) / scale;
}

/**
 * The shortest way round between two angles, from -PI to PI. Two headings a
 * hair either side of due west are a hair apart, not a whole turn apart.
 */
function wrapAngle(radians: number): number {
  return Math.atan2(Math.sin(radians), Math.cos(radians));
}

/** What a Score has done, in the shape the Achievement table reads. */
function tallyOf(score: Score): Tally {
  return {
    c: score.c,
    q: score.q ?? emptyTally().q,
    d: score.d ?? 0,
    b: score.b ?? 0,
    g: score.g ?? 0,
  };
}

/** A short random string. Both an id and a name seed are one of these. */
function mowerId(): string {
  return crypto.randomUUID().slice(0, 8);
}

interface Budget {
  tokens: number;
  refilledAt: number;
}

/** Where the Lawn last saw a Mower, in Tiles. */
interface Place {
  x: number;
  y: number;
}

export class Lawn extends DurableObject {
  /** Epoch seconds of the last Mow Stroke per Tile. 0 means never mown. */
  private mownAt!: Uint32Array;
  private ball = createBall(LAWN_WIDTH / 2 + 7, LAWN_HEIGHT / 2);
  private ballMowers = new Map<WebSocket, BallMower & { at: number }>();
  private ballContact?: BallContact;
  private ballTimer?: ReturnType<typeof setInterval>;
  private ballTick = 0;
  private ballSent = 0;
  private ballSaved = 0;
  private strokes = 0;
  private dirty = false;
  private budgets = new WeakMap<WebSocket, Budget>();
  private posBudgets = new WeakMap<WebSocket, Budget>();
  private emoteBudgets = new WeakMap<WebSocket, Budget>();
  private bumpBudgets = new WeakMap<WebSocket, Budget>();
  private resyncedAt = new WeakMap<WebSocket, number>();
  /**
   * Where the Lawn holds each Mower, and how much travel that Mower has left.
   * A Mower is where the Lawn says it is, not where the client says it is.
   * Both are forgotten when the Lawn hibernates, which costs nothing: a Lawn
   * only hibernates when nobody is driving, and the next Mow Stroke from a
   * Mower the Lawn has lost says where it starts and cuts nothing.
   */
  private places = new WeakMap<WebSocket, Place>();
  /** The direction and moment of a Mower's last Mow Stroke, for `sawDrift`. */
  private lastSwath = new WeakMap<WebSocket, { dx: number; dy: number; at: number }>();
  /**
   * How much travel each Mower has left, by Mower Key and not by socket.
   * Windows are free and hands are not, so ten tabs on one Key drive one
   * Mower's worth between them and a Score cannot be farmed by opening
   * windows. Two honest tabs pay the same price: what they share is one pair
   * of hands.
   */
  private travelBudgets = new Map<string, Budget>();
  /**
   * How many blades each Mower has cut, by Mower Key. The Lawn counts them as
   * it cuts them, so the tally is not a number a client can name. Unlike a
   * position it outlives the socket, because a Score is worth nothing that
   * does not outlive the visit that earned it.
   */
  private scores!: Map<string, Score>;
  private scoredAt = new WeakMap<WebSocket, number>();
  /**
   * The grass the last Mow Stroke took off each Field. It is reused and never
   * allocated: a Mow Stroke runs many times a second and this says nothing
   * between one and the next.
   */
  private readonly cutByField = new Float64Array(FIELD_NAMES.length);
  /**
   * What the Lawn last read of each Field, and when. `at` of 0 means it has
   * never read that Field: the first read only takes the measure of it and
   * crowns nobody, or a Lawn waking beside a Field that was finished while it
   * slept would hand out medals for somebody else's work.
   */
  private readonly fieldWatch = FIELD_NAMES.map(() => ({ at: 0, percent: 0, done: false }));
  /** What the Lawn has lately had to say, newest last. See `NOTE_KEEP`. */
  private notes: { k: string; nm?: string; w?: number; f?: number; at: number }[] = [];
  /** Mower Keys the others have been told are on the Lawn. */
  private announced = new Map<string, string>();
  /** Keys whose last socket has gone, waiting to see whether they come back. */
  private leaving = new Map<string, { name: string; at: number }>();
  /** When the alarm is next set for, so two callers cannot undercut it. */
  private alarmAt = 0;

  constructor(ctx: DurableObjectState, env: unknown) {
    super(ctx as never, env as never);
    ctx.blockConcurrencyWhile(async () => {
      const savedBall = await ctx.storage.get<Ball>("ball");
      if (savedBall) this.ball = createBall(savedBall.x, savedBall.y);
      const stored = await readChunks(ctx.storage);
      this.mownAt =
        stored && stored.byteLength === TILE_COUNT * 4
          ? new Uint32Array(stored.slice(0))
          : new Uint32Array(TILE_COUNT);
      const oldWidth = stored?.byteLength === 288 * 192 * 4 ? 288
        : stored?.byteLength === 144 * 96 * 4 ? 144
        : stored?.byteLength === 72 * 48 * 4 ? 72 : 0;
      if (stored && oldWidth) {
        const oldHeight = oldWidth * 2 / 3;
        const previous = new Uint32Array(stored);
        const offsetX = (LAWN_WIDTH - oldWidth) / 2;
        const offsetY = (LAWN_HEIGHT - oldHeight) / 2;
        for (let y = 0; y < oldHeight; y++) {
          this.mownAt.set(previous.subarray(y * oldWidth, (y + 1) * oldWidth), (y + offsetY) * LAWN_WIDTH + offsetX);
        }
        this.schedulePersist();
      }
      this.strokes = (await ctx.storage.get<number>(STROKE_KEY)) ?? 0;
      // A Score used to be a bare number. One written before the id was kept
      // gets an id here, so an old Mower Key still opens the Score it holds.
      const scores = await ctx.storage.get<[string, Score | number][]>(SCORE_KEY);
      this.scores = new Map(
        (Array.isArray(scores) ? scores : []).map(([key, held]) => [
          key,
          typeof held === "number" ? { n: mowerId(), c: held } : held,
        ]),
      );
    });
  }

  async fetch(request: Request): Promise<Response> {
    if (request.headers.get("Upgrade") !== "websocket") {
      return new Response("expected websocket", { status: 426 });
    }
    // The address is a tag on the socket, not a note in memory: the Lawn can
    // then count the Mowers of one address with an index, and the count stays
    // right when the Lawn hibernates. Cloudflare writes this header itself, so
    // a client cannot claim another address.
    const address = request.headers.get("CF-Connecting-IP") ?? "";
    if (address && this.mowersAt(address) >= MOWERS_PER_ADDRESS) {
      return new Response("too many mowers from here", { status: 429 });
    }

    const pair = new WebSocketPair();
    const [client, server] = [pair[0], pair[1]];

    // Hibernation: the Lawn sleeps between Mow Strokes and the sockets survive.
    // The id rides on the socket, so it survives hibernation too. This one
    // lasts until the Mower says which Key it holds, which is the first thing
    // it says.
    const id = mowerId();
    this.ctx.acceptWebSocket(server, address ? [address] : []);
    // The browser rides along for the analytics, cut short so it can never
    // crowd the attachment past what a socket may carry.
    const ua = (request.headers.get("User-Agent") ?? "").slice(0, 400);
    server.serializeAttachment({ id, key: "", ua });
    server.send(JSON.stringify(this.hello(id)));
    server.send(this.snapshot());
    server.send(this.ballMessage());
    server.send(this.logMessage());
    this.announceMowers();

    return new Response(null, { status: 101, webSocket: client });
  }

  webSocketMessage(ws: WebSocket, raw: string | ArrayBuffer): void {
    if (typeof raw !== "string" || raw.length > 256) return;

    let message: ClientMessage;
    try {
      message = JSON.parse(raw);
    } catch {
      return;
    }
    if (message?.t === "i") {
      this.claim(ws, message.k);
      return;
    }
    const who = ws.deserializeAttachment() as
      | { id?: string; key?: string; name?: string }
      | null;
    const id = who?.id ?? "?";
    const key = who?.key ?? "";
    // What this Mower is called and coloured by. A socket that has not said
    // which Key it holds wears its own id, as every Mower did before Keys.
    const name = who?.name || id;
    // What the travel budget is held under. A socket that has not said which
    // Key it holds drives on its own id rather than sharing an empty purse
    // with every other such socket.
    const purse = key || id;

    if (message?.t === "pos") {
      // Presence is ephemeral: relay it and keep nothing on disk. A Mower
      // that goes quiet simply fades from the other screens.
      if (!this.spendPos(ws)) return;
      const x = Number(message.x);
      const y = Number(message.y);
      const a = Number(message.a);
      if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(a)) return;
      // A Mower shows itself where it mows. The report is pulled back to
      // within reach of the last Mow Stroke, so a Mower that drives faster
      // than a Mower can drive is seen at the speed of a Mower.
      const seen = this.within(ws, purse, x, y);
      // The score is what the Lawn counted, not what the report says. A
      // report carries no tally any more, so there is nothing to forge.
      this.report(ws, id, name, key, seen, a);
      return;
    }
    if (message?.t === "emote") {
      // An Emote is presence, like a position: relay it and store nothing.
      // It therefore fades from the other screens on its own, and it costs
      // the hibernating Lawn nothing.
      if (!this.spendEmote(ws)) return;
      const e = Number(message.e);
      if (!Number.isInteger(e) || e < 0 || e >= EMOTE_COUNT) return;
      this.broadcast(JSON.stringify({ t: "emoted", id, e }), ws);
      return;
    }
    if (message?.t === "bump") {
      // A daze is presence too: it lasts one second, so it is gone long
      // before a Lawn that hibernates wakes up. Relay it and store nothing.
      if (!this.spendBump(ws)) return;
      this.broadcast(JSON.stringify({ t: "bumped", id }), ws);
      // The daze is still relayed on the Mower's word, because a Mower only
      // ever dazes itself and a liar wearing its own Stars costs nobody
      // anything. The tally is not: an Achievement is the one thing here
      // worth forging, so the Lawn counts a Bump only when it saw one.
      if (key && this.sawBump(ws)) {
        const score = this.scores.get(key);
        if (score) {
          score.b = (score.b ?? 0) + 1;
          this.award(ws, score);
          this.schedulePersist();
        }
      }
      return;
    }
    if (message?.t !== "mow") return;

    const x = Number(message.x ?? message.x1);
    const y = Number(message.y ?? message.y1);
    if (!Number.isFinite(x) || !Number.isFinite(y)) return;
    if (x < -MOW_RADIUS || x > LAWN_WIDTH + MOW_RADIUS) return;
    if (y < -MOW_RADIUS || y > LAWN_HEIGHT + MOW_RADIUS) return;
    // A Mow Stroke that carries a heading is a position report as well. A tab
    // open across a deploy sends the two apart and carries none here, and is
    // then shown by its own `pos` message exactly as before.
    const a = Number(message.a);
    const heading = Number.isFinite(a);

    // A Mower over budget gets the Lawn as the server sees it, so an optimistic
    // client never keeps a swath the server refused.
    if (!this.spend(ws)) {
      this.resync(ws);
      return;
    }

    const from = this.places.get(ws);
    if (!from) {
      // The first Mow Stroke of a Mower only says where it starts. Nothing is
      // cut, because the Lawn has no idea where that Mower came from.
      this.seed(ws, purse, x, y);
      if (heading) this.report(ws, id, name, key, { x, y }, a, motion(message.vx, message.vy));
      this.acceptPosition(ws, message, { x, y });
      return;
    }

    // Drive the Mower towards where it says it is, as far as its travel
    // allows. A client that says it moved further keeps a swath the Lawn
    // refused, so it gets the Lawn as the server sees it.
    const to = this.drive(purse, from, x, y);
    this.places.set(ws, to);
    if (to.x !== x || to.y !== y) this.resync(ws);

    if (to.x !== from.x || to.y !== from.y) {
      // The Lawn counts the blades as it cuts them. This is the whole tally:
      // no client adds anything to it and no client is asked what it is.
      const blades = this.mow(from.x, from.y, to.x, to.y);
      // Tiles driven is what the Lawn drove, not what the Mower asked for: a
      // client that claims a mile gets as far as its travel allows, and the
      // ladder is measured on the near end of that.
      const drove = Math.hypot(to.x - from.x, to.y - from.y);
      const drifted = this.sawDrift(ws, from, to, drove, a);
      if (key) this.credit(ws, key, name, blades, drove, drifted);
      // A Field can only be finished by grass coming off it, so this is the
      // one moment worth looking.
      if (blades > 0) this.watchFields();
      this.strokes += 1;
      this.broadcast(
        JSON.stringify({
          t: "mow",
          x0: from.x,
          y0: from.y,
          x1: to.x,
          y1: to.y,
          by: id,
          strokes: this.strokes,
        }),
        ws,
      );
      this.schedulePersist();
    }

    // A Mow Stroke that says which way the Mower points is the position
    // report as well, because it is the same movement. The Mower is shown
    // where the Lawn drove it to and not where the report said, so there is
    // nothing to pull back: `within` is for the older `pos` message only.
    const velocity = to.x === x && to.y === y ? motion(message.vx, message.vy) : { vx: 0, vy: 0 };
    if (heading) this.report(ws, id, name, key, to, a, velocity);
    this.acceptPosition(ws, message, to);
  }

  private acceptPosition(ws: WebSocket, message: Extract<ClientMessage, { t: "mow" }>, at: Place): void {
    if (Number.isSafeInteger(message.seq) && message.seq! > 0) {
      ws.send(JSON.stringify({ t: "accepted", seq: message.seq, x: at.x, y: at.y }));
    }
  }

  /**
   * Show a Mower to the others, and tell it what it has really cut. Both come
   * from one report, so the tally that goes out is the one the Mow Stroke in
   * that same report just added to.
   */
  private report(
    ws: WebSocket,
    id: string,
    name: string,
    key: string,
    at: Place,
    a: number,
    velocity?: { vx: number; vy: number },
  ): void {
    this.trackBallMower(ws, id, at);
    const held = this.scores.get(key);
    const s = Math.round(held?.c ?? 0);
    // How many Achievements this Mower holds, for the board. It rides on the
    // report for the reason the tally does: the board is built from presence,
    // so anything the board shows about a Mower has to arrive with it. It is
    // the count and not the mask, because the board shows a number.
    const ac = countHeld(held?.a ?? 0);
    // Stamp the report. A client draws other Mowers slightly in the past,
    // between two reports, and it needs to know when each one was really
    // made: the gaps between arrivals are network jitter, not movement.
    this.broadcast(
      // `nm` is what this Mower is called and coloured by, and `n` is when
      // the report was made. They are different things with unlucky names.
      JSON.stringify({ t: "peer", id, nm: name, x: at.x, y: at.y, a, ...velocity, s, ac, n: Date.now() }),
      ws,
    );
    this.tell(ws, held);
  }

  /** Whether any open socket other than `going` holds this Mower Key. */
  private keyIsHere(key: string, going?: WebSocket): boolean {
    for (const ws of this.ctx.getWebSockets()) {
      if (ws === going || ws.readyState !== WebSocket.READY_STATE_OPEN) continue;
      if ((ws.deserializeAttachment() as { key?: string } | null)?.key === key) return true;
    }
    return false;
  }

  /**
   * Tell the Lawn that a Mower Key has arrived, if it was not already here.
   *
   * A second tab on one Key is not a second arrival, and neither is a reload:
   * both find the Key already announced and say nothing.
   */
  private arrive(key: string, name: string): void {
    this.leaving.delete(key);
    if (this.announced.has(key)) return;
    this.announced.set(key, name);
    this.broadcastNote({ k: "here", nm: name });
  }

  /**
   * Work through the Keys whose sockets have gone, and announce the ones that
   * have stayed away. It runs whenever a socket opens or closes, which is the
   * only time any of this can have changed.
   */
  private sweepLeaving(): void {
    const now = Date.now();
    for (const [key, who] of this.leaving) {
      if (this.keyIsHere(key)) { this.leaving.delete(key); continue; }
      const away = now - who.at;
      if (away < REJOIN_GRACE_MS) continue;
      this.leaving.delete(key);
      this.announced.delete(key);
      // Too long ago to be news. The last Mower left and nothing swept the
      // list until this one arrived; it does not want the old goodbye.
      if (away > LEAVING_STALE_MS) continue;
      this.broadcastNote({ k: "gone", nm: who.name });
    }
    // Anything still waiting needs the Lawn to look again, and a socket may
    // never open or close between now and then.
    if (this.leaving.size) this.wake(REJOIN_GRACE_MS);
  }

  /** Say a thing to everyone on the Lawn, and remember having said it. */
  private broadcastNote(what: { k: string; nm?: string; w?: number; f?: number }): void {
    this.remember(what);
    this.broadcast(JSON.stringify({ t: what.k, ...what }));
  }

  /**
   * Say something, and remember having said it. The note is what a Mower
   * arriving later is told; the message is what everyone here hears now.
   */
  private remember(what: { k: string; nm?: string; w?: number; f?: number }): void {
    this.notes.push({ ...what, at: Date.now() });
    if (this.notes.length > NOTE_KEEP) this.notes.shift();
  }

  /** What has lately happened, for a Mower that has just arrived. */
  private logMessage(): string {
    const now = Date.now();
    return JSON.stringify({
      t: "log",
      lines: this.notes.filter((one) => now - one.at <= NOTE_AGE_MS),
    });
  }

  private ballMessage(): string {
    return JSON.stringify({ t: "ball", ...this.ball, n: Date.now() });
  }

  private trackBallMower(ws: WebSocket, id: string, at: Place): void {
    const now = Date.now();
    const previous = this.ballMowers.get(ws);
    const dt = previous ? (now - previous.at) / 1000 : 0;
    const vx = previous && dt > 0 && dt < 1 ? (at.x - previous.x) / dt : 0;
    const vy = previous && dt > 0 && dt < 1 ? (at.y - previous.y) / dt : 0;
    const speed = Math.hypot(vx, vy);
    const scale = speed > MAX_SPEED ? MAX_SPEED / speed : 1;
    this.ballMowers.set(ws, { id, ...at, vx: vx * scale, vy: vy * scale, at: now });
    if (!this.ballTimer && speed > 0.3 && Math.hypot(at.x - this.ball.x, at.y - this.ball.y) < BALL_RADIUS + COLLISION_RADIUS) {
      this.ballTick = now;
      this.ballTimer = setInterval(() => this.tickBall(), 1000 / 30);
    }
  }

  private tickBall(): void {
    const now = Date.now();
    const steps = Math.min(12, Math.floor((now - this.ballTick) / (BALL_STEP * 1000)));
    for (let i = 0; i < steps; i++) {
      this.ballTick += BALL_STEP * 1000;
      for (const [ws, mower] of this.ballMowers) {
        if (now - mower.at > 1000) { this.ballMowers.delete(ws); continue; }
        const contact = hitBall(this.ball, {
          ...mower,
          vx: now - mower.at < 180 ? mower.vx : 0,
          vy: now - mower.at < 180 ? mower.vy : 0,
        }, this.ballTick, this.ballContact);
        if (contact) this.ballContact = contact;
      }
      stepBall(this.ball, BALL_STEP, LAWN_WIDTH, LAWN_HEIGHT,
        (x, y) => placeAt(x, y, LAWN_WIDTH, LAWN_HEIGHT).wet);
    }
    if (now - this.ballTick > 200) this.ballTick = now;
    const moving = ballMoving(this.ball);
    if (!moving || now - this.ballSent >= 50) {
      this.broadcast(this.ballMessage());
      this.ballSent = now;
    }
    if ((!moving || now - this.ballSaved > 2000)
      && this.ball.z === BALL_RADIUS
      && placeAt(this.ball.x, this.ball.y, LAWN_WIDTH, LAWN_HEIGHT).wet <= -BALL_RADIUS) {
      this.ctx.waitUntil(this.ctx.storage.put("ball", this.ball));
      this.ballSaved = now;
    }
    if (!moving) {
      if (this.ballTimer !== undefined) clearInterval(this.ballTimer);
      this.ballTimer = undefined;
    }
  }

  webSocketClose(ws: WebSocket): void {
    this.ballMowers.delete(ws);
    const who = ws.deserializeAttachment() as { id?: string; key?: string; name?: string } | null;
    // The name rides on the goodbye, because the log names who left and a
    // Mower the others never heard report has no name on their screens.
    // `left` is presence and not news: the others use it to forget where that
    // Mower stood, and it fires for a reload exactly as it does for a goodbye.
    // Whether anything is said about it is `sweepLeaving`'s to decide.
    if (who?.id) this.broadcast(JSON.stringify({ t: "left", id: who.id }), ws);
    this.track(ws, "mower_left");
    if (who?.key && who?.name && !this.keyIsHere(who.key, ws)) {
      this.leaving.set(who.key, { name: who.name, at: Date.now() });
    }
    this.sweepLeaving();
    this.forgetBudget(ws, who?.key || who?.id || "");
    this.announceMowers();
  }

  webSocketError(ws: WebSocket): void {
    this.ballMowers.delete(ws);
    const who = ws.deserializeAttachment() as { id?: string; key?: string } | null;
    this.forgetBudget(ws, who?.key || who?.id || "");
    this.announceMowers();
  }

  /**
   * Drop a travel budget once the last Mower driving on that purse has gone.
   * A budget held by a Key outlives the socket that spent from it, so unlike
   * the other budgets it is not swept away with the socket. It holds no more
   * than a second of driving, so forgetting it gives nothing away.
   *
   * `webSocketClose` fires before the socket leaves the list, so the one that
   * is going does not count itself as still driving.
   */
  private forgetBudget(going: WebSocket, purse: string): void {
    if (!purse) return;
    for (const ws of this.ctx.getWebSockets()) {
      if (ws === going || ws.readyState !== WebSocket.READY_STATE_OPEN) continue;
      const who = ws.deserializeAttachment() as { id?: string; key?: string } | null;
      if ((who?.key || who?.id || "") === purse) return;
    }
    this.travelBudgets.delete(purse);
  }

  async alarm(): Promise<void> {
    this.alarmAt = 0;
    // A Mower that left while nobody else was coming or going is decided here.
    // Without this the last one out of the Lawn is never said to have left.
    this.sweepLeaving();
    if (!this.dirty) return;
    this.dirty = false;
    this.prune();
    // Each storage value stays below 128 KiB; save every chunk atomically.
    const write: Record<string, unknown> = {
      [STROKE_KEY]: this.strokes,
      [SCORE_KEY]: [...this.scores],
    };
    for (let k = 0; k < CHUNK_COUNT; k++) {
      write[chunkKey(k)] = this.mownAt.buffer.slice(k * CHUNK_BYTES, (k + 1) * CHUNK_BYTES);
    }
    await this.ctx.storage.put(write);
  }

  /**
   * Forget the lowest Scores once the Lawn holds more than it keeps.
   *
   * A Mower that is driving is never forgotten, whatever it has cut, so nobody
   * loses a Score while they are earning it. Nor is a Mower that has earned an
   * Achievement, while the Lawn stays under `KEY_KEEP`: a Score can be mown
   * again in an afternoon and an Achievement cannot be earned twice, so the
   * two are not worth the same and must not be pruned the same.
   *
   * Past `KEY_KEEP` that exemption ends, because every Score is written into
   * one storage value and one storage value has a ceiling. A Lawn with more
   * decorated Mowers than that forgets the quietest of them, and the Mower it
   * forgets gets a fresh Mower Key on its next visit. That is the hole this
   * leaves open, and it opens only on a Lawn that has been busy for a long
   * time; raise `KEY_KEEP` — and split the storage value — before it does.
   */
  private prune(): void {
    if (this.scores.size <= SCORE_KEEP) return;
    const driving = new Set<string>();
    for (const ws of this.ctx.getWebSockets()) {
      const key = (ws.deserializeAttachment() as { key?: string } | null)?.key;
      if (key) driving.add(key);
    }
    const decorated = this.scores.size > KEY_KEEP;
    const keep = decorated ? KEY_KEEP : SCORE_KEEP;
    const spare = [...this.scores]
      .filter(([key, held]) => !driving.has(key) && (decorated || !held.a))
      .sort((a, b) => a[1].c - b[1].c);
    for (const [key] of spare.slice(0, this.scores.size - keep)) {
      this.scores.delete(key);
    }
  }

  /**
   * Cut every Tile the swath touches back to zero Blade Height, and answer
   * with the grass that came off. That number is the Score: the Lawn counts
   * the blades itself, so a Mower cannot name its own tally.
   *
   * It leaves the same grass split by Field in `cutByField`, which is how the
   * Lawn knows which Fields this stroke could have finished. That costs the
   * Mow Stroke nothing: it has to know which Tiles are grass to count them at
   * all, and the table that says so names the Field in the same byte.
   */
  private mow(x0: number, y0: number, x1: number, y1: number): number {
    const now = Math.floor(Date.now() / 1000);
    this.cutByField.fill(0);
    let blades = 0;
    forEachMownTile(x0, y0, x1, y1, LAWN_WIDTH, LAWN_HEIGHT, MOW_RADIUS, (i) => {
      const field = FIELD_OF[i];
      if (field !== NO_FIELD) {
        const off = bladeHeight(this.mownAt[i], REGROW[i], now);
        blades += off;
        this.cutByField[field] += off;
      }
      this.mownAt[i] = now;
    });
    return blades;
  }

  /**
   * Add one Mow Stroke to what the Lawn holds for this Mower: the blades it
   * took off, the Tiles it drove, and, on the Mower's own word, the blades
   * that came off while its tyres were sliding.
   *
   * All of them grow and none of them ever falls, which is what lets an
   * Achievement be for ever. The record is the one the map holds, so it is
   * changed in place and not rebuilt: a Score that is rebuilt is a Score that
   * silently drops the fields a later version added.
   */
  private credit(
    ws: WebSocket,
    key: string,
    name: string,
    blades: number,
    drove: number,
    drifting: boolean,
  ): void {
    const score = this.scores.get(key) ?? { n: name, c: 0 };
    score.c += blades;
    score.d = tidy((score.d ?? 0) + drove);
    if (drifting && blades > 0) score.g = (score.g ?? 0) + blades;
    // The finishes are put on the record even when there are none, so that
    // reading it never has to build them: a Mower reports ten times a second,
    // and a Tally built afresh each time is throwaway arrays ten times a
    // second. The blades-per-Field of the older shape go at the same moment.
    if (!score.q) score.q = emptyTally().q;
    if (score.h) delete score.h;
    this.scores.set(key, score);
    this.award(ws, score);
  }

  /**
   * Work out which Achievements a Score has earned, and tell that Mower when
   * the answer has grown.
   *
   * What it holds is ORed with what it has earned and never replaced. An
   * Achievement is a thing that happened, so a threshold that is raised
   * afterwards must not take one back from the Mower that had it.
   */
  private award(ws: WebSocket, score: Score): void {
    const before = score.a ?? 0;
    const after = (before | earnedMask(tallyOf(score))) >>> 0;
    if (after === before) return;
    score.a = after;
    // Everyone hears about it. An Achievement earned where nobody can see it
    // is half an Achievement, and the Lawn is a shared field.
    const won: number[] = [];
    for (let bit = 0; bit < 32; bit++) {
      if ((after & (1 << bit)) && !(before & (1 << bit))) won.push(bit);
    }
    if (won.length) {
      const who = ws.deserializeAttachment() as { id?: string; name?: string } | null;
      for (const bit of won) this.broadcastNote({ k: "won", nm: who?.name, w: bit });
      for (const bit of won) {
        const achievement = ACHIEVEMENTS.find((held) => held.bit === bit);
        this.track(ws, "achievement_won", { achievement: achievement?.name ?? String(bit), tier: achievement?.tier ?? "" });
      }
    }
    try {
      ws.send(JSON.stringify({ t: "got", a: after, ...this.tallyMessage(score) }));
    } catch {
      /* socket is going away; the Achievement is kept and arrives next visit */
    }
  }

  /**
   * Read every Field this Mow Stroke took grass off, and crown the Mowers
   * standing in one that has just been finished.
   *
   * The Lawn judges the finish itself, from the Tiles it holds, by the same
   * sum the Tracker uses. It has to: the flare, the banner and the Achievement
   * are one moment, and a Lawn that worked it out differently from the client
   * would put the medal a second to one side of the thing it belongs to.
   */
  private watchFields(): void {
    const now = Date.now();
    const seconds = Math.floor(now / 1000);
    for (let field = 0; field < this.cutByField.length; field++) {
      if (this.cutByField[field] <= 0) continue;
      const watch = this.fieldWatch[field];
      // A Field near the line is read on every stroke, because the stroke that
      // takes the last of it may be the last stroke anyone makes there.
      if (watch.percent < FIELD_NEARLY && now - watch.at < FIELD_CHECK_MS) continue;
      const first = watch.at === 0;
      watch.at = now;
      watch.percent = fieldStanding(FIELD_TILES[field], this.mownAt, seconds);
      const done = watch.percent >= 100 - 1e-7;
      // Only the crossing counts. A Field stays done until the Regrowth takes
      // it back under the line, and then it can be finished — and crowned —
      // all over again.
      if (done && !watch.done && !first) {
        // The line about a finished Field is said by each client as it draws
        // the flare, so the two land together. The Lawn only remembers it, for
        // whoever arrives afterwards.
        this.remember({ k: "cut", f: field });
        this.crownField(field);
      }
      watch.done = done;
    }
  }

  /**
   * Give every Mower standing in a Field the Achievement for it.
   *
   * Being there is the whole of the test, and that is the point: the Field
   * lights up, the banner falls and the card arrives, all of it at once and
   * all of it for the Mowers who were in it. It is not a share of the work —
   * the Lawn does not ask who cut what — so a Mower that drove in at the end
   * is crowned with the one that cut the parcel. That is the cost of the
   * moment arriving whole, and it was taken with open eyes.
   */
  private crownField(field: number): void {
    const crowned = new Set<string>();
    for (const ws of this.ctx.getWebSockets()) {
      if (ws.readyState !== WebSocket.READY_STATE_OPEN) continue;
      const place = this.places.get(ws);
      if (!place) continue;
      const x = Math.floor(place.x);
      const y = Math.floor(place.y);
      if (x < 0 || y < 0 || x >= LAWN_WIDTH || y >= LAWN_HEIGHT) continue;
      if (FIELD_OF[y * LAWN_WIDTH + x] !== field) continue;
      const who = ws.deserializeAttachment() as { id?: string; key?: string; name?: string } | null;
      const key = who?.key;
      if (!key) continue;
      // A Mower that has stood still since it arrived has cut nothing and
      // driven nowhere, so the Lawn holds no record for it yet. Standing there
      // is the whole of what this asks, so it gets one now.
      const score = this.scores.get(key) ?? { n: who?.name || who?.id || mowerId(), c: 0 };
      this.scores.set(key, score);
      // Two tabs of one browser are two Mowers on the screen but one Key, and
      // one Key was there once. The card goes to whichever of them the Lawn
      // reaches first, because `award` speaks only when the mask grows and by
      // the second tab it has already grown.
      if (!crowned.has(key)) {
        crowned.add(key);
        const finishes = score.q ?? (score.q = emptyTally().q);
        finishes[field] += 1;
      }
      this.award(ws, score);
    }
    this.schedulePersist();
  }

  /**
   * Whether this Mow Stroke was cut sideways, at speed, and so was a drift and
   * not an ordinary corner.
   *
   * The Lawn never runs the Mower's own physics and so never sees the tyres
   * let go. What it can see is that a sliding Mower stops going where it is
   * pointed: the swath is the ground the Lawn itself drove the Mower over, and
   * the nose is the heading that same Mow Stroke already carries for drawing
   * it, so the angle between them costs nothing to read and is exactly what a
   * slide opens up. Steering alone cannot open it — the wheels take the Mower
   * where they point until they break away.
   *
   * Three things are asked, and a drift is all three at once. The nose must
   * lie `DRIFT_SLIP` off the swath. The swath must bend `DRIFT_BEND` across
   * the stroke, so a nose held crooked down a straight is not a drift. And the
   * bend must run the same way the nose is turned, because a Mower slides
   * with its nose inside the corner and never outside it. The last two are
   * what a Mower would have to forge together, while genuinely driving fast
   * over real grass, to claim a drift it did not do.
   *
   * It always remembers this Mow Stroke's direction for the next one, whether
   * or not this one drifted, so two ordinary corners taken back to back are
   * read against each other and not against whatever drift happened earlier.
   * A Mower too old to send a heading never drifts: the Lawn cannot see a
   * nose it was not told about, and it will not guess one.
   */
  private sawDrift(ws: WebSocket, from: Place, to: Place, drove: number, nose: number): boolean {
    if (drove <= 0) return false;
    const now = Date.now();
    const dx = (to.x - from.x) / drove, dy = (to.y - from.y) / drove;
    const last = this.lastSwath.get(ws);
    this.lastSwath.set(ws, { dx, dy, at: now });
    if (!last || !Number.isFinite(nose)) return false;
    const gap = now - last.at;
    if (gap <= 0 || gap >= DRIFT_STALE_MS) return false;
    if (drove / (gap / 1000) < DRIFT_SPEED) return false;
    const slip = wrapAngle(nose - Math.atan2(dy, dx));
    const bend = wrapAngle(Math.atan2(dy, dx) - Math.atan2(last.dy, last.dx));
    return Math.abs(slip) >= DRIFT_SLIP && Math.abs(bend) >= DRIFT_BEND
      && Math.sign(slip) === Math.sign(bend);
  }

  /**
   * Whether the Lawn itself saw the Bump a Mower says it was in.
   *
   * A Mower speaks only for itself about a daze, and that is right: it cannot
   * daze anybody else with it. But a tally is worth forging, and two tabs
   * parked against each other could trade Bumps all afternoon. So the Lawn
   * asks its own question — is another Mower near, and were the two of them
   * really closing? — from the positions and speeds it already keeps for the
   * ball. A Mower alone in a corner, and two that stand still together, both
   * answer no.
   *
   * The Closing Speed is the speed along the line between the two, so it is
   * the same number whichever of them asks: the Mower that drove in and the
   * Mower that was standing are both in the Bump, and both are counted.
   */
  private sawBump(ws: WebSocket): boolean {
    const me = this.ballMowers.get(ws);
    const now = Date.now();
    if (!me || now - me.at > BUMP_STALE_MS) return false;
    for (const [other, them] of this.ballMowers) {
      if (other === ws || now - them.at > BUMP_STALE_MS) continue;
      const dx = them.x - me.x;
      const dy = them.y - me.y;
      const gap = Math.hypot(dx, dy);
      if (gap === 0 || gap > BUMP_REACH) continue;
if (((me.vx - them.vx) * dx + (me.vy - them.vy) * dy) / gap >= BUMP_CLOSING) return true;
    }
    return false;
  }

  /**
   * Tell a Mower what it has really cut, and what else it has done.
   *
   * The client counts the blades along so the digits roll without waiting for
   * the Lawn, and this puts that guess right a few times a second — the same
   * bargain the Snapshot makes for the Tiles. The rest of the tally rides with
   * it because the Achievements window draws how far along every ladder this
   * Mower is, and it can only draw what it has been told. It goes to the one
   * socket that asked and is never broadcast, so it costs the line nothing
   * that matters.
   */
  private tell(ws: WebSocket, held: Score | undefined): void {
    const now = Date.now();
    if (now - (this.scoredAt.get(ws) ?? 0) < SCORE_GAP_MS) return;
    this.scoredAt.set(ws, now);
    try {
      ws.send(JSON.stringify({ t: "score", ...this.tallyMessage(held) }));
    } catch {
      /* socket is going away */
    }
  }

  /** What a Mower has done, in the shape the Achievement table reads. */
  private tallyMessage(held: Score | undefined) {
    return {
      s: Math.round(held?.c ?? 0),
      d: Math.round(held?.d ?? 0),
      b: held?.b ?? 0,
      g: Math.round(held?.g ?? 0),
      q: held?.q ?? emptyTally().q,
    };
  }

  private resync(ws: WebSocket): void {
    const now = Date.now();
    if (now - (this.resyncedAt.get(ws) ?? 0) < RESYNC_GAP_MS) return;
    this.resyncedAt.set(ws, now);
    try {
      ws.send(this.snapshot());
    } catch {
      /* socket is going away */
    }
  }

  /**
   * Take the Mower Key a Mower says it holds, and answer with who that makes
   * it. The Lawn takes a Key back only when it already holds a Score under it,
   * so a Mower cannot name itself into the Score of another; one the Lawn has
   * never issued simply becomes a new Mower, which costs it nothing.
   *
   * A socket does this once. The name it was given when it opened is replaced
   * by the name that belongs to the Key, so a Mower is the same Mower, with
   * the same colour, on every visit.
   */
  private claim(ws: WebSocket, given?: unknown): void {
    const who = ws.deserializeAttachment() as { id?: string; key?: string; ua?: string } | null;
    if (who?.key) return;

    const held = typeof given === "string" ? this.scores.get(given) : undefined;
    const key = held ? (given as string) : crypto.randomUUID();
    // The id stays the one this socket opened with. Only the name and the
    // colour come from the Key, so a Mower is recognisable across visits
    // without two of its tabs becoming one Mower.
    const id = who?.id ?? mowerId();
    const name = held?.n ?? mowerId();
    ws.serializeAttachment({ id, key, name, ua: who?.ua, at: Date.now() });
    this.track(ws, "mower_arrived", { returning: !!held, achievements: countHeld(held?.a ?? 0) });
    // Say so to the Lawn. A Mower is only worth announcing once it holds its
    // Key: that is the moment it has the name it will wear, and the Key is
    // what says whether this is somebody new or the same Mower back from a
    // reload.
    this.arrive(key, name);
    this.sweepLeaving();
    try {
      // The Achievements come back with the Key, because they are the whole
      // of what a returning Mower has to show for its last visit. They are
      // what it already had, so the client lands them rather than announcing
      // them, the way the Score is landed rather than rolled up to.
      ws.send(JSON.stringify({
        t: "you", id, key, nm: name, a: held?.a ?? 0, ...this.tallyMessage(held),
      }));
    } catch {
      /* socket is going away */
    }
  }

  private hello(id: string) {
    return {
      t: "hello",
      id,
      w: LAWN_WIDTH,
      h: LAWN_HEIGHT,
      regrowMin: REGROW_MIN_SECONDS,
      regrowMax: REGROW_MAX_SECONDS,
      cooldown: COOLDOWN_SECONDS,
      patch: PATCH_TILES,
      radius: MOW_RADIUS,
      now: Date.now(),
      mowers: this.ctx.getWebSockets().length,
      strokes: this.strokes,
    };
  }

  /**
   * How far every Tile is through Cooldown and Regrowth together, 0 to
   * SNAPSHOT_SCALE. The span is the whole cycle and not the Regrowth alone,
   * so one entry still says everything about one Tile and the wire keeps its
   * size.
   */
  private snapshot(): ArrayBuffer {
    const now = Math.floor(Date.now() / 1000);
    const ages = new Uint16Array(TILE_COUNT);
    for (let i = 0; i < TILE_COUNT; i++) {
      const mown = this.mownAt[i];
      const span = cycle(REGROW[i]);
      const age = mown === 0 ? span : now - mown;
      const grown = age >= span ? 1 : age < 0 ? 0 : age / span;
      ages[i] = Math.round(grown * SNAPSHOT_SCALE);
    }
    return ages.buffer;
  }

  private schedulePersist(): void {
    if (this.dirty) return;
    this.dirty = true;
    this.wake(PERSIST_DELAY_MS);
  }

  /**
   * Ask to be woken in `delay`, unless something sooner is already asked for.
   *
   * A Durable Object has one alarm, and two things now want it: writing the
   * Lawn down, and deciding whether a Mower that went quiet has really gone.
   * Whichever wants it first gets it, and whatever is left over asks again
   * when the alarm has been served.
   */
  private wake(delay: number): void {
    const at = Date.now() + delay;
    if (this.alarmAt > Date.now() && this.alarmAt <= at) return;
    this.alarmAt = at;
    void this.ctx.storage.setAlarm(at);
  }


  /** How many Mowers one address has on the Lawn now. */
  private mowersAt(address: string): number {
    return this.ctx
      .getWebSockets(address)
      .filter((ws) => ws.readyState === WebSocket.READY_STATE_OPEN).length;
  }

  /**
   * Put a Mower on the Lawn where it says it is, with no travel banked. A
   * fresh socket must earn its travel exactly like the Mower before it:
   * without this a Mower could reconnect for a full bank, cut a long swath at
   * once, drop the socket and come straight back for another.
   */
  private seed(ws: WebSocket, purse: string, x: number, y: number): void {
    this.places.set(ws, { x, y });
    this.travelBudgets.set(purse, { tokens: 0, refilledAt: Date.now() });
  }

  /**
   * Move a Mower from where the Lawn holds it towards where it says it is,
   * and no further than its travel allows. The answer is the far end of the
   * swath: it is the claim itself when the Mower kept to the speed of a
   * Mower, and a point on the way there when it did not.
   */
  private drive(purse: string, from: Place, x: number, y: number): Place {
    const dx = x - from.x;
    const dy = y - from.y;
    const distance = Math.hypot(dx, dy);
    if (distance === 0) return { x, y };
    const budget = this.refill(this.travelBudgets, purse, TRAVEL_RATE, TRAVEL_BANK);
    const allowed = Math.min(distance, budget.tokens);
    const dry = this.dryRun(from, dx / distance, dy / distance, allowed);
    budget.tokens -= dry;
    // The claim itself, and not a point worked back to it: the caller reads
    // an answer that differs from the claim as a swath it has to put right.
    if (dry >= distance) return { x, y };
    const k = dry / distance;
    return { x: from.x + dx * k, y: from.y + dy * k };
  }

  /**
   * How far a Mower really gets along its swath: as far as it asked for, or
   * as far as the near bank of the Water. A Mower cannot drive through water,
   * so neither can a client that says it did — the Lawn stops the swath at
   * the water's edge and sends that Mower the Lawn as the Lawn sees it.
   *
   * An honest Mower is never held back here. Its own client keeps it a whole
   * Mower's width from the water, and this stops only at the water itself.
   */
  private dryRun(from: Place, ux: number, uy: number, distance: number): number {
    for (let travelled = WATER_STEP; travelled < distance; travelled += WATER_STEP) {
      if (blocked(from.x + ux * travelled, from.y + uy * travelled)) {
        return Math.max(0, travelled - WATER_STEP);
      }
    }
    return blocked(from.x + ux * distance, from.y + uy * distance)
      ? Math.max(0, Math.floor(distance / WATER_STEP) * WATER_STEP - WATER_STEP)
      : distance;
  }

  /**
   * Pull a reported position back to within reach of the last Mow Stroke of
   * that Mower. Travel is spent by mowing, not by reporting: a Mow Stroke and
   * the position that follows it are the same movement, and paying twice for
   * it would hold back every honest Mower.
   */
  private within(ws: WebSocket, purse: string, x: number, y: number): Place {
    const place = this.places.get(ws);
    if (!place) {
      this.seed(ws, purse, x, y);
      return { x, y };
    }
    const dx = x - place.x;
    const dy = y - place.y;
    const distance = Math.hypot(dx, dy);
    const reach = this.refill(this.travelBudgets, purse, TRAVEL_RATE, TRAVEL_BANK).tokens
      + POSITION_SLACK;
    if (distance <= reach) return { x, y };
    const k = reach / distance;
    return { x: place.x + dx * k, y: place.y + dy * k };
  }

  private spend(ws: WebSocket): boolean {
    return this.take(this.budgets, ws, STROKE_RATE);
  }

  private spendPos(ws: WebSocket): boolean {
    return this.take(this.posBudgets, ws, POS_RATE);
  }

  private spendEmote(ws: WebSocket): boolean {
    return this.take(this.emoteBudgets, ws, EMOTE_RATE);
  }

  private spendBump(ws: WebSocket): boolean {
    return this.take(this.bumpBudgets, ws, BUMP_RATE);
  }

  private take(budgets: WeakMap<WebSocket, Budget>, ws: WebSocket, rate: number): boolean {
    const budget = this.refill(budgets, ws, rate, rate);
    if (budget.tokens < 1) return false;
    budget.tokens -= 1;
    return true;
  }

  /**
   * Give a budget back the time that has gone by, and hand it over to spend.
   * The purse is the socket for what a socket may send, because that is a cost
   * to the line, and the Mower Key for what a Mower may cut, because that is a
   * cost to the Lawn.
   */
  private refill<K>(
    budgets: { get(purse: K): Budget | undefined; set(purse: K, budget: Budget): unknown },
    purse: K,
    rate: number,
    capacity: number,
  ): Budget {
    const now = Date.now();
    const budget = budgets.get(purse) ?? { tokens: capacity, refilledAt: now };
    budget.tokens = Math.min(capacity, budget.tokens + ((now - budget.refilledAt) / 1000) * rate);
    budget.refilledAt = now;
    budgets.set(purse, budget);
    return budget;
  }

  /**
   * Tell Rybbit what a Mower did. It is sent after the answer, never before
   * it, so a slow or absent Rybbit costs the Lawn nothing. A socket that has
   * not said which Key it holds is nobody yet, and is not counted.
   */
  private track(ws: WebSocket, name: string, properties: Record<string, string | number | boolean> = {}): void {
    const who = ws.deserializeAttachment() as { key?: string; ua?: string; at?: number } | null;
    if (!who?.key) return;
    if (name === "mower_left" && who.at) properties = { ...properties, seconds: Math.round((Date.now() - who.at) / 1000) };
    this.ctx.waitUntil(trackEvent(this.env as RybbitEnv, {
      name,
      key: who.key,
      properties,
      ipAddress: this.ctx.getTags(ws)[0],
      userAgent: who.ua,
    }));
  }

  private announceMowers(): void {
    // webSocketClose fires before the socket leaves the list.
    const sockets = this.ctx
      .getWebSockets()
      .filter((ws) => ws.readyState === WebSocket.READY_STATE_OPEN);
    const message = JSON.stringify({ t: "mowers", mowers: sockets.length });
    for (const ws of sockets) {
      try {
        ws.send(message);
      } catch {
        /* socket is going away */
      }
    }
  }

  private broadcast(message: string, except?: WebSocket): void {
    for (const ws of this.ctx.getWebSockets()) {
      if (ws === except) continue;
      try {
        ws.send(message);
      } catch {
        /* socket is going away */
      }
    }
  }
}

export interface Env extends RybbitEnv {
  LAWN: DurableObjectNamespace;
  ASSETS: Fetcher;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/lawn") {
      // One Lawn for the whole world.
      const id = env.LAWN.idFromName("the-lawn");
      return env.LAWN.get(id).fetch(request);
    }
    return env.ASSETS.fetch(request);
  },
} satisfies ExportedHandler<Env>;
