import { MAX_SPEED } from "../driving";

/**
 * Every number the Lawn holds a Mower to, in one place. They are tuning and
 * not domain: the meaning of a Mow Stroke does not change when a rate does,
 * so the services read them from here rather than carrying their own.
 */

/**
 * Room above the speed of a Mower. A Mower pushed by another Mower moves
 * without driving, and the two clocks are not the same clock.
 */
export const SPEED_TOLERANCE = 1.15;
/**
 * Seconds of travel a Mower may bank. Messages arrive in bursts after a
 * stall, and a Mower held up by the network really did drive the whole way,
 * so the budget is a bank and not a limit per message. It is also the longest
 * swath one Mow Stroke can cut: about 29 Tiles at full slipstream speed.
 */
export const TRAVEL_BANK_SECONDS = 1;
export const TRAVEL_RATE = MAX_SPEED * SPEED_TOLERANCE;
export const TRAVEL_BANK = TRAVEL_RATE * TRAVEL_BANK_SECONDS;
/**
 * How far in front of its own last Mow Stroke a Mower may report itself. It
 * holds for the older `pos` message only: a Mow Stroke now carries the
 * heading, and a Mower is shown where the Lawn drove it to.
 */
export const POSITION_SLACK = 2;
/**
 * How far apart the Lawn reads the swath while it looks for water. A run of
 * Water is `2 * WATER` Tiles wide, so a step this short can never stride over
 * one.
 */
export const WATER_STEP = 0.75;

/**
 * Mow Strokes one Mower may send per second. A Mower sends about ten, and the
 * room above that is for a tab open across a deploy: that one still sends a
 * Mow Stroke every 40 ms, and it must not be throttled for it.
 */
export const STROKE_RATE = 40;
/** Shortest gap between two resyncs to the same Mower. */
export const RESYNC_GAP_MS = 1000;
/** Position reports one Mower may send per second. */
export const POS_RATE = 30;
/** Emotes one Mower may send per second. */
export const EMOTE_RATE = 2;
/**
 * Bumps one Mower may report per second. A Mower that is dazed keeps its
 * Grace, so an honest client reports a Bump once in four seconds at the most,
 * and one a second is already room to spare.
 */
export const BUMP_RATE = 1;
/**
 * Mowers one address may have on the Lawn at once. Every socket earns its own
 * travel, so one person with many sockets cuts what many visitors cut. This
 * is the only thing that tells them apart, and it is a blunt one: a house, an
 * office and a whole mobile network each look like one address.
 */
export const MOWERS_PER_ADDRESS = 12;
/** How many Emotes the wheel offers. The client holds the pictures. */
export const EMOTE_COUNT = 5;

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
export const PERSIST_DELAY_MS = 10000;
/**
 * Mowers the Lawn keeps a tally for. Past this it forgets the lowest score of
 * a Mower that is not driving, so the state of the Lawn stays bounded the way
 * the Tiles are. The Lawn remembers the two hundred best Mowers, and one that
 * was never among them starts again from nothing.
 */
export const SCORE_KEEP = 200;
/**
 * Mowers the Lawn keeps at all, whatever they hold. A Mower that has earned an
 * Achievement is spared the ordinary pruning, because a lost Score can be mown
 * again and a lost Achievement cannot — but that exemption has to stop
 * somewhere, or the Lawn grows without bound. Every Score is written into one
 * storage value, and one storage value holds 128 KiB; a record runs to some two
 * hundred bytes, so this leaves the write about a fifth of that limit in hand.
 * Past it the Lawn forgets the lowest Score it holds, decorated or not.
 */
export const KEY_KEEP = 500;

/**
 * How often the Lawn reads a Field it has just been cut on. A read walks some
 * eleven thousand Tiles, which is cheap, but not cheap enough to do ten times
 * a second for every Mower. A Field already near the line is read every time
 * instead, because the stroke that takes the last of it is the one that
 * matters and there may be no stroke after it.
 */
export const FIELD_CHECK_MS = 300;
export const FIELD_NEARLY = 95;

/**
 * How near two Mowers must be for the Lawn to believe a Bump, in Tiles. A
 * Mower is about five Tiles wide and the Lawn sees a position up to a report
 * old, so this is generous on purpose: it is here to catch a Mower that says
 * it was bumped with nobody beside it, not to referee the contact.
 */
export const BUMP_REACH = 14;
/**
 * How much of the client's `STUN_SPEED` the Lawn asks of a Closing Speed
 * before it counts a Bump. The Lawn works the speed out from reports 100 ms
 * apart, so it reads a real ram lower than the client does; asking for the
 * whole of it would count almost nothing.
 */
export const BUMP_CLOSING = 3;
/** How stale a report may be and still say where a Mower was for a Bump. */
export const BUMP_STALE_MS = 1000;

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
export const NOTE_KEEP = 20;
export const NOTE_AGE_MS = 10 * 60 * 1000;
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
export const REJOIN_GRACE_MS = 8000;
/**
 * Past this the Lawn stops caring that a Mower left. It only matters when the
 * last Mower goes and nothing sweeps the list again until somebody new
 * arrives, hours later: telling them that a stranger left before they got here
 * is worse than not telling them at all.
 */
export const LEAVING_STALE_MS = 60000;
/**
 * Shortest gap between two tallies sent to the same Mower. The client counts
 * the blades itself so the digits roll smoothly, and this is how often the
 * Lawn overwrites that guess with what it really cut.
 */
export const SCORE_GAP_MS = 250;

/** The longest a message from a Mower may be. Nothing it may say is longer. */
export const MESSAGE_BYTES = 256;

export * as Limits from "./limits";
