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
 * wide a lane and a Ditch are, and which seams carry water. It is the same
 * table as `public/fields.js` and must stay so: the two sides have to agree
 * on which Tiles are grass, or a score counts blades that were never there.
 */
const SEEDS: [number, number][] = [
  [0.15, 0.19], [0.47, 0.13], [0.83, 0.20],
  [0.13, 0.53], [0.44, 0.46], [0.79, 0.51],
  [0.19, 0.85], [0.52, 0.81], [0.86, 0.84],
];
const LANE = 2.3;
const DITCH = 2.6;
const BANK = 1.6;
const BRIDGE = 6;
const DITCHES = [[1, 4], [3, 4], [5, 8], [6, 7]];
const SHORE_RADIUS = 1.2;

function warpX(x: number, y: number): number {
  return x + 7 * Math.sin(y * 0.052 + 0.6) + 2.6 * Math.sin(y * 0.127 + 2.1);
}
function warpY(x: number, y: number): number {
  return y + 7 * Math.sin(x * 0.045) + 2.6 * Math.sin(x * 0.103 + 1.3);
}

/** How far a point lies inside the water. Mirrors `water` in the client. */
function water(into: number, beyond: number): number {
  if (into > 0 && beyond > 0) return Math.min(into, beyond);
  const dx = Math.max(0, -into), dy = Math.max(0, -beyond);
  return -Math.sqrt(dx * dx + dy * dy);
}

/**
 * Where a point stands on the Lawn: the Field that owns it, or -1 for a lane,
 * a bank or the water, and how far it lies inside the water. Mirrors
 * `placeAt` in `public/fields.js` exactly.
 */
function placeAt(x: number, y: number, width: number, height: number): { field: number; wet: number } {
  if (x < 0 || y < 0 || x >= width || y >= height) return { field: -1, wet: -BRIDGE };
  const px = warpX(x, y), py = warpY(x, y);
  let first = 0, d0 = Infinity, d1 = Infinity;
  const distances: number[] = [];
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

/** Grass grows on a Field. Nothing grows on a lane, a bank or the water. */
function onGrass(x: number, y: number): boolean {
  return placeAt(x, y, LAWN_WIDTH, LAWN_HEIGHT).field >= 0;
}

/** Open water. No Mower drives here, whatever its client says. */
function inWater(x: number, y: number): boolean {
  return placeAt(x, y, LAWN_WIDTH, LAWN_HEIGHT).wet > 0;
}

/**
 * How far apart the Lawn reads the swath while it looks for water. A Ditch is
 * `2 * DITCH` Tiles wide, so a step this short can never stride over one.
 */
const WATER_STEP = 0.75;

const REGROW = regrowTable(LAWN_WIDTH, LAWN_HEIGHT);

/**
 * How tall the grass on a Tile stands, from 0 to 1. A Tile nobody ever mowed
 * is fully overgrown. Mirrors `heightAt` in the client, which is what makes
 * the score the server counts the same score the Mower watches.
 */
function bladeHeight(mownAt: number, regrow: number, now: number): number {
  const age = mownAt === 0 ? cycle(regrow) : now - mownAt;
  if (age >= cycle(regrow)) return 1;
  if (!(age > COOLDOWN_SECONDS) || !(regrow > 0)) return 0;
  const t = (age - COOLDOWN_SECONDS) / regrow;
  return 1 - (1 - t) * (1 - t);
}
/** Radius of one Mow Stroke, in Tiles. */
const MOW_RADIUS = 2.6;


/**
 * Fastest a Mower drives, in Tiles per second. It mirrors `MAX_V` in the
 * client, and it is what makes a Mow Stroke cost time: the Lawn moves a Mower
 * no faster than a Mower can drive, whatever the client says.
 */
const MAX_SPEED = 13;
/**
 * Room above that speed. A Mower pushed by another Mower moves without
 * driving, and the two clocks are not the same clock.
 */
const SPEED_TOLERANCE = 1.15;
/**
 * Seconds of travel a Mower may bank. Messages arrive in bursts after a
 * stall, and a Mower held up by the network really did drive the whole way,
 * so the budget is a bank and not a limit per message. It is also the longest
 * swath one Mow Stroke can cut: about 15 Tiles.
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
const EMOTE_COUNT = 4;
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
  | { t: "mow"; x: number; y: number; a?: number; x1?: number; y1?: number }
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

  constructor(ctx: DurableObjectState, env: unknown) {
    super(ctx as never, env as never);
    ctx.blockConcurrencyWhile(async () => {
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
    server.serializeAttachment({ id, key: "" });
    server.send(JSON.stringify(this.hello(id)));
    server.send(this.snapshot());
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
      if (blades > 0 && key) {
        const held = this.scores.get(key);
        this.scores.set(key, { n: held?.n ?? name, c: (held?.c ?? 0) + blades });
      }
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
    if (heading) this.report(ws, id, name, key, to, a);
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
  ): void {
    const s = Math.round(this.scores.get(key)?.c ?? 0);
    // Stamp the report. A client draws other Mowers slightly in the past,
    // between two reports, and it needs to know when each one was really
    // made: the gaps between arrivals are network jitter, not movement.
    this.broadcast(
      // `nm` is what this Mower is called and coloured by, and `n` is when
      // the report was made. They are different things with unlucky names.
      JSON.stringify({ t: "peer", id, nm: name, x: at.x, y: at.y, a, s, n: Date.now() }),
      ws,
    );
    this.tell(ws, s);
  }

  webSocketClose(ws: WebSocket): void {
    const who = ws.deserializeAttachment() as { id?: string; key?: string } | null;
    if (who?.id) this.broadcast(JSON.stringify({ t: "gone", id: who.id }), ws);
    this.forgetBudget(ws, who?.key || who?.id || "");
    this.announceMowers();
  }

  webSocketError(ws: WebSocket): void {
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
   * Forget the lowest Scores once the Lawn holds more than it keeps. A Mower
   * that is driving is never forgotten, whatever it has cut, so nobody loses a
   * Score while they are earning it.
   */
  private prune(): void {
    if (this.scores.size <= SCORE_KEEP) return;
    const driving = new Set<string>();
    for (const ws of this.ctx.getWebSockets()) {
      const key = (ws.deserializeAttachment() as { key?: string } | null)?.key;
      if (key) driving.add(key);
    }
    const spare = [...this.scores]
      .filter(([key]) => !driving.has(key))
      .sort((a, b) => a[1].c - b[1].c);
    for (const [key] of spare.slice(0, this.scores.size - SCORE_KEEP)) {
      this.scores.delete(key);
    }
  }

  /**
   * Cut every Tile the swath touches back to zero Blade Height, and answer
   * with the grass that came off. That number is the Score: the Lawn counts
   * the blades itself, so a Mower cannot name its own tally.
   */
  private mow(x0: number, y0: number, x1: number, y1: number): number {
    const now = Math.floor(Date.now() / 1000);
    const minX = Math.max(0, Math.floor(Math.min(x0, x1) - MOW_RADIUS));
    const maxX = Math.min(LAWN_WIDTH - 1, Math.ceil(Math.max(x0, x1) + MOW_RADIUS));
    const minY = Math.max(0, Math.floor(Math.min(y0, y1) - MOW_RADIUS));
    const maxY = Math.min(LAWN_HEIGHT - 1, Math.ceil(Math.max(y0, y1) + MOW_RADIUS));

    const dx = x1 - x0;
    const dy = y1 - y0;
    const len2 = dx * dx + dy * dy;

    let blades = 0;
    for (let y = minY; y <= maxY; y++) {
      for (let x = minX; x <= maxX; x++) {
        const px = x + 0.5 - x0;
        const py = y + 0.5 - y0;
        const t = len2 === 0 ? 0 : Math.min(1, Math.max(0, (px * dx + py * dy) / len2));
        const ox = px - t * dx;
        const oy = py - t * dy;
        if (ox * ox + oy * oy <= MOW_RADIUS * MOW_RADIUS) {
          const i = y * LAWN_WIDTH + x;
          if (onGrass(x + 0.5, y + 0.5)) blades += bladeHeight(this.mownAt[i], REGROW[i], now);
          this.mownAt[i] = now;
        }
      }
    }
    return blades;
  }

  /**
   * Tell a Mower what it has really cut. The client counts along so the digits
   * roll without waiting for the Lawn, and this puts that guess right a few
   * times a second — the same bargain the Snapshot makes for the Tiles.
   */
  private tell(ws: WebSocket, score: number): void {
    const now = Date.now();
    if (now - (this.scoredAt.get(ws) ?? 0) < SCORE_GAP_MS) return;
    this.scoredAt.set(ws, now);
    try {
      ws.send(JSON.stringify({ t: "score", s: score }));
    } catch {
      /* socket is going away */
    }
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
    const who = ws.deserializeAttachment() as { id?: string; key?: string } | null;
    if (who?.key) return;

    const held = typeof given === "string" ? this.scores.get(given) : undefined;
    const key = held ? (given as string) : crypto.randomUUID();
    // The id stays the one this socket opened with. Only the name and the
    // colour come from the Key, so a Mower is recognisable across visits
    // without two of its tabs becoming one Mower.
    const id = who?.id ?? mowerId();
    const name = held?.n ?? mowerId();
    ws.serializeAttachment({ id, key, name });
    try {
      ws.send(JSON.stringify({ t: "you", id, key, nm: name, s: Math.round(held?.c ?? 0) }));
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
    void this.ctx.storage.setAlarm(Date.now() + PERSIST_DELAY_MS);
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
   * as far as the near bank of a Ditch. A Mower cannot drive through water,
   * so neither can a client that says it did — the Lawn stops the swath at
   * the water's edge and sends that Mower the Lawn as the Lawn sees it.
   *
   * An honest Mower is never held back here. Its own client keeps it a whole
   * Mower's width from the water, and this stops only at the water itself.
   */
  private dryRun(from: Place, ux: number, uy: number, distance: number): number {
    for (let travelled = WATER_STEP; travelled < distance; travelled += WATER_STEP) {
      if (inWater(from.x + ux * travelled, from.y + uy * travelled)) {
        return Math.max(0, travelled - WATER_STEP);
      }
    }
    return inWater(from.x + ux * distance, from.y + uy * distance)
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

export interface Env {
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
