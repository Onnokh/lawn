# The Lawn

One shared lawn on the web. A visitor drags the pointer to mow. The grass grows
back. If nobody mows, the lawn becomes fully overgrown again.

## Ubiquitous language

- **Lawn** — the one shared field. One Durable Object instance, name `the-lawn`.
- **Tile** — one cell of the Lawn. The grid is 72 x 48 = 3456 Tiles.
- **Blade Height** — how tall the grass on a Tile is, from 0 (mown) to 1
  (fully overgrown).
- **Mow Stroke** — the swath between two pointer positions. The Mower cuts a
  capsule with radius `MOW_RADIUS` around that line.
- **Mower** — one connected visitor.
- **Bump** — two Mowers touch while they close on each other. A contact while
  both stand still, or while one only catches up with the other, is not a
  Bump.
- **Closing Speed** — how fast two Mowers meet, along the line between them.
  It is the same number on both screens, so both reach the same answer about
  the same Bump.
- **Stun** — the second after a Bump that closed at `STUN_SPEED` or more. A
  stunned Mower takes no throttle and no steering. It keeps its momentum, it
  is still pushed by the Mower that hit it, and the blades stay down.
- **Grace** — the `STUN_GRACE_MS` after a Stun, in which that Mower cannot be
  stunned again. It is what stops one Mower from holding another.
- **Stars** — the ring of four Stars a stunned Mower wears. It is the only
  sign on the screen that says the controls are gone.
- **Regrowth** — the return of Blade Height to 1. A Lawn nobody mows is
  overgrown again the same day.
- **Growth Rate** — the seconds one Tile needs for a full Regrowth, from 2 to
  6 hours. It is a smooth noise over the Lawn, in patches of `PATCH_TILES`,
  so the grass comes back in slow ground and quick ground. It is a pure
  function of the position of the Tile: no one stores it and no one sends it,
  and both sides build the same table.
- **Snapshot** — how far each Tile is through its Regrowth, from 0 to
  `SNAPSHOT_SCALE`, sent as a `Uint16Array`. No two Tiles share a Regrowth, so
  the wire carries the fraction and not the age in seconds. The wire therefore
  stays the same when the Growth Rate changes.

## Why there is no server tick

The Durable Object stores one number per Tile: the epoch second of the last
Mow Stroke. Blade Height is a pure function of `now - mownAt` and the Growth
Rate of the Tile, which is itself a pure function of where the Tile is.
Therefore:

- No timer runs to make the grass grow. The Lawn stays correct while the
  Durable Object hibernates.
- The client uses the same function, so it animates growth with no traffic.
  The server sends only Mow Strokes.
- The state is 13.8 kB (`Uint32Array`), and it stays that size for ever.

An alarm exists, but only to write the state to storage 2 seconds after a
change. It is a debounce, not a simulation step.

## Presence

A Mower reports its position with `{t:"pos"}`. The server relays it and keeps
nothing on disk, because a position has no meaning after the Mower leaves. A
client forgets a Mower it has not heard from for 4 seconds. Hibernation
therefore costs almost nothing: a Lawn that wakes has forgotten where each
Mower stands, and the next Mow Stroke says it again.

## A Bump dazes both Mowers

A Bump is one event with two victims. The Mower that drove in is stunned, and
so is the Mower that stood still, because it is the one that was hit.

Both clients see the same contact — each one pushes itself out of the other —
so each one dazes itself and says so with `{t:"bump"}`. The Lawn stamps the
id on it and relays it, exactly as it does with an Emote, and keeps nothing:
a Stun lasts one second, so it is over long before a Lawn that hibernates
wakes again.

A Mower therefore never dazes another Mower. It reports its own Stun, the
same as it reports its own position and its own score, and a rewritten client
can say no more about anybody else than the truthful one can. Because the
Stun is on the wire and not worked out on each screen, a Mower that is not in
the Bump sees the Stars over both of the Mowers that are.

## Only a ram dazes, and only once in a while

A contact is not a Bump. Two Mowers parked against each other touch every
frame, and a Mower that catches another up and leans on it is a nuisance, not
a crash. What counts is the Closing Speed: the speed along the line between
the two. Below `BUMP_SPEED` nothing happens at all. Above it there is dust and
a shake of the camera. Only above `STUN_SPEED`, which is about half of the
speed a Mower can drive, do the controls go.

The velocity of the other Mower comes from the two reports it is drawn
between, because a report says where a Mower was and not how fast it drove.
It is the way of the travel and not the way of the nose, so a Mower that is
pushed sideways is measured by where it really goes. A Mower with no report
to drive to counts as standing still.

Then a Stun buys `STUN_GRACE_MS` of Grace. Without it, one Mower parks beside
another and rams it again the moment it comes round, and the Mower under the
wheels never drives again. With it, the worst a Mower can do to another is one
second in four, and the Mower it holds keeps the other three to drive away in.

The Grace is kept by the Mower that was dazed, because a Mower only ever
dazes itself. A rewritten client therefore cannot hold anybody: the answer to
"may I be dazed again" is never asked of the Mower that is doing the ramming.

## An Emote is read from across the Lawn

An Emote is a card in the air, and a card too small is a card nobody reads at
the far side of a field. The card is therefore wide, and two things keep it
clear of the Mower that sent it.

The card is measured in pixels and the Mower in world units, so the two are
tied at the top of the Mower and the card hangs its own height above that
point. A card placed at a world height instead sinks into the handlebar on a
short window, where one world unit is worth fewer pixels.

The size then falls with distance, against the Mower you drive: your own card
never changes size, and a card far away is smaller, so the Lawn keeps its
depth. It never falls below a size that can be read.

The rest is motion, and motion is what says an Emote is new: the card springs
past its size and back, breathes where it hangs, and lifts away as it ages
out. A ring leaves it the moment it lands, for the Mower who was looking
elsewhere. All of it stands still for a visitor who asks for less motion.

## One map, and M grows it

The map in the corner and the map M opens are one map. Hold M and the corner
map grows out to the middle of the screen, where it holds the whole Lawn; let
go and it goes back to its corner. Nothing new fades in over it, so a Mower
never reads two maps of one Lawn at two scales at the same time.

Two things change while it grows. The window on the Lawn widens by the same
factor every frame — 90 Tiles across in the corner, the whole Lawn when it is
out — so the ground under the frame runs out at an even pace instead of
bolting at the end. And the names of the Fields arrive late, because a map
that fills the screen has the room to write them and the corner has room for
none of it.

The World Quest Tracker steps aside while the map is out, the way it already
stands down for the Field banner. It stands over the right of the map, and it
says what the map says.

The map is held, like the board, and not switched on. A key you hold cannot be
left on, so a hand that leaves the keyboard always leaves the Lawn in view.

## The Lawn decides where a Mower is

A Mow Stroke says where the Mower is now. It does not say where the swath
starts. The server holds a position for each Mower and cuts from there to the
new one, so the start of a swath is always the end of the one before it, and
a client cannot name a place it never drove from.

That position moves no faster than a Mower drives: `MAX_SPEED` Tiles a second,
which is the `MAX_V` of the client. Travel is a budget in Tiles, and not a
limit for each message, because messages come in bursts after a stall and a
Mower held up by the line did drive the whole way. The budget fills at
`MAX_SPEED * SPEED_TOLERANCE` and holds `TRAVEL_BANK_SECONDS` of driving. When
a client says it went further, the server moves it as far as the budget
allows and does not cut the remainder of the swath.

A new socket starts that budget empty. A full budget on arrival was worth 15
Tiles of swath to anyone who opened a socket, cut, dropped it and came back,
which is quicker than driving: 24 sockets cut 84 Tiles a second that way. An
empty budget makes a reconnection worth 1 Tile a second, and costs an honest
Mower nothing, because its first Mow Stroke only marks where it starts and its
second comes 40 ms later, by which time it has earned the 0.5 Tiles it needs.

A client that is rewritten thus gets no advantage. It can send a Mow Stroke
every millisecond and still cuts 13 Tiles a second, the same as a thumb on a
phone. A reported position is also pulled back to within reach of the last Mow
Stroke, so each Mower is seen where it mows.

Before this the server only clamped a stroke to `MAX_STROKE` Tiles, measured
back from the end the Mower gave. Forty of those in a second cut 240 Tiles a
second. The clamp also threw away the swath of an honest Mower whose messages
were held up, and told that Mower nothing.

Two holes stay open, because they are cheap and what they let through is not:

- A Mower the Lawn has not seen — a new socket, or one the Lawn forgot while
  it hibernated — is believed one time. Its first Mow Stroke only says where
  it starts and cuts nothing, so a reconnection buys a place to stand and no
  grass.

## One address, twelve Mowers

Every socket earns its own travel, so one person with many sockets cuts what
many visitors cut. Nothing in what a client sends tells the two apart; only
where it comes from does. The Lawn therefore counts: `MOWERS_PER_ADDRESS`
sockets from one address at a time, and the next one gets a 429 instead of a
Lawn. A new socket also costs the Lawn a whole Snapshot of 110 kB, so this
holds down what it costs to open sockets as well as what they can cut.

The address is a tag on the socket and not a note in memory. The count is then
an index lookup, and it stays right while the Lawn hibernates — which is where
the budgets in the WeakMaps are lost. Cloudflare writes `CF-Connecting-IP`
itself, so a client cannot say it comes from somewhere else.

This is a blunt instrument, and that is the reason to write it down: a house,
an office and a whole mobile network each look like one address. It bounds
what one address can do; it does not stop it. Twelve sockets driven flat out
cut 147 Tiles a second, against 13 for one honest Mower. The cap is what
decides that number, so lower it if the Lawn is still being shaved.

A socket that dies without saying so keeps its place. A tab that is killed or
a phone that loses its signal leaves a socket the runtime still reports as
open, for ten minutes and more, so a visitor can be kept out by the ghosts of
its own dropped connections. A tab that is closed or reloaded says goodbye
properly and frees its place at once, which is what nearly every visitor does.

Sending the oldest Mower away instead of refusing the newcomer was tried and
dropped. `close()` on the server moves that socket to CLOSING, but the client
is never told and the socket never leaves the count, so the cap would let
every newcomer in and count nothing — no cap at all, and silently. Refusing
the newcomer is worse for the rare visitor with ghosts and right for everyone
else, so it stands until the close can be made to land.

## The score is a sum, so it must never take a NaN

The score adds one Blade Height for each Tile the Mower cuts. A sum has no
memory of its parts: one addend that is not a number makes every later score
NaN, for as long as the page is open. It is worse than that, because the score
is written to `localStorage` twice a second and a saved `"NaN"` reads back as
zero. One bad frame therefore throws away the whole tally of a visitor.

Three gates stop this. `heightAt` answers 0 for a Tile it cannot date, instead
of NaN. Only a Blade Height above zero is added. And `updateScore` refuses a
score that is not a finite number, so nothing that is not a number reaches the
screen or the storage. The board reads the score of another Mower the same
way, because `??` passes a NaN through and only catches a null.

## The Lawn counts the blades

A position report used to carry the score of the Mower that sent it, and the
server passed it on. A rewritten client therefore had whatever score it liked,
and one wrote seven hundred million on the board.

The server counts instead. It already works out every Tile a Mow Stroke cuts,
and it holds the moment each Tile was last mown and the Growth Rate of that
Tile, so it knows the Blade Height it is about to take off. It adds that up
per Mower and puts its own number in the report. A client is not asked.

This costs a second copy of two functions the client already has: `fieldAt`,
for the Tiles that are path and verge and grow nothing, and the Blade Height
curve. They sit beside the Growth Rate table, which was already a copy for the
same reason. All of them must stay identical to `public/index.html` and
`public/fields.js`, or the two sides count different grass.

The count lives in memory and is written to the socket every `TALLY_SAVE_MS`,
so a Mower that parks while the Lawn hibernates comes back to its score and
not to zero. It is kept between visits against the key of that Mower, which is
the next section. The headline and the board therefore show one number, and it
is the Lawn's.

## A Mower keeps its name

A socket used to be all the Lawn knew of a Mower, so a score lasted one visit
and a name changed every time the page was opened.

A Mower now holds a key. The Lawn gives one to a Mower that arrives without
one, keeps the score against it, and gives back the same id and the same score
when that key comes again. The client keeps it in `localStorage` under
`lawn:key`. The key is the whole of the proof, so:

- It travels in a message and never in the address of the socket. A query
  parameter is written to every log between here and the visitor.
- It is a UUID. A key the Lawn never issued is not an error: that Mower simply
  becomes somebody new.
- Whoever holds it is that Mower. There is no password, and no way back when a
  browser forgets it. That is the price of having no account.

Identity is the first thing a Mower says, and the client sends nothing else
until the Lawn has answered, so no Mow Stroke is ever filed under the id of a
socket instead of the id of the visitor. A client that never says who it is —
a tab that was open across the deploy — still mows and is still scored, under
its socket, for that visit only.

The name and the colour follow the id, so a Mower is the same Mower to look at
on every visit.

A score is written to storage on the same debounced alarm that writes the
Lawn, and once more when the socket closes. It never goes down: two tabs of
one visitor each count their own blades, and the one that counted fewer must
not undo the other.

A Mower never hears its own report, so the Lawn sends it a `score` message
every `SCORE_ECHO_MS`. The client takes that number only when it is higher
than its own. The echo is up to two seconds behind the grass, and a headline
that steps backwards every two seconds reads as a fault; the number every
other Mower sees is the Lawn's either way.

One row of storage is kept for every visitor, for ever. They are small, and
nothing prunes them yet.

## Who is on the Lawn

The heading over the board and the board itself must count the same Mowers,
and they did not. The board is built from presence: a Mower that has not
reported for `PEER_TIMEOUT` drops off it. The heading came from the server,
which counted sockets. A socket is not a Mower — a tab that is put in the
background stops reporting while its socket stays open, and a socket that
died without saying so is counted for ten minutes and more. Five sockets and
two Mowers on the board was the normal reading of that, not a fault.

The heading now counts what the board counts: the Mowers that have spoken,
and you. The server still says how many sockets it holds, in the hello and in
a `mowers` message, because that is the honest answer to a different question
and it is what the address count is made of. Nothing on the screen uses it.

## Agreement between client and server

The client applies a Mow Stroke immediately, before the server confirms it.
The server can refuse a Mow Stroke when the Mower is over the rate budget
(`STROKE_RATE` per second), and it can cut less than the Mower asked for when
the Mower is over its travel budget. Then the two lawns disagree. To correct
this, the server sends a new Snapshot to that Mower. Keep the mow maths in
`src/index.ts` and `public/index.html` identical.

The client sends a maximum of one Mow Stroke per frame. The Mow Stroke covers
the full movement since the last one. A fast drag thus cuts a continuous
swath with few messages.

## Driving with a thumb

A coarse pointer gets a stick in the bottom left corner and two buttons in the
bottom right. The stick is a **direction**, not a wheel: it says where on the
Lawn the Mower must go, and the Mower turns towards that heading as fast as it
can turn. This works because the camera holds one heading. Wheel controls read
as inverted every time the Mower faces the bottom of the screen, which is half
of the time.

The stick gives only the throttle and the steering. The Mower obeys the same
acceleration, drag and turn rate as the keys, so a Mow Stroke from a thumb and
a Mow Stroke from a keyboard are the same thing.

The base of the stick moves to the thumb that touches the zone. A stick with a
fixed base is a stick the thumb must find first, and a thumb that misses drives
the Mower into the hedge.

Three things must stay clear of the thumbs on a small screen: the score, the
title and the credit move to the top, the Lawn keeps the middle, and the World
Quest Tracker folds down to its heading. Folded, the Tracker still says which
Field you are in and how much of it is cut, because that is the part you read
while you drive.

A phone held sideways is 812 x 390: wide enough to pass a width breakpoint and
far too short for the layout behind it. The small layout therefore answers to
both, and the minimap is measured against the height as well as the width.

## Files

- `src/index.ts` — the Worker (routing) and the `Lawn` Durable Object.
- `public/index.html` — the whole client: WebGPU field, driving, socket, HUD.
  The Lawn is drawn as instanced 3D blades under one sun, from a camera that
  follows the Mower's position at a fixed heading. A rotating camera was tried
  and rejected: it makes a Lawn this size unreadable.

## Light

One directional sun, and a shadow map rendered from it each frame: the grass
and the Mowers draw into a 2048x2048 depth texture, and the main pass compares
against it with a 3x3 filter. Before this the Mower had a dark quad painted on
the ground, which the grass then drew over — it read as a rectangle of paint,
not a shadow.

`textureSampleCompare` may only be called from uniform control flow. A guard
that returns early makes the call non-uniform and the shader will not compile;
sample first, then mask the result.

The time of day comes from the server clock, so every Mower is in the same
hour of the same day. A full cycle is 10 minutes.

## Frame rate

Every frame the field grows itself on the GPU. One compute pass turns the
patch into a record per blade — root, lean, width, tint — and writes only the
blades it keeps into a buffer, with the count in the arguments of an indirect
draw. The blades the camera and the sun both miss never reach a vertex
shader, and the blade a vertex belongs to is worked out once, not twenty
times over. Flowers and clover take the same route, and an empty cell is
dropped there instead of drawing zero-sized geometry.

The Lawn itself is a texture, one texel per Tile: Blade Height in red, the
heading of the cut as cosine and sine in green and blue. The sampler does the
bilinear blend that shader code used to do by hand, and the heading takes two
`textureGather` calls instead of four reads and four trigonometric functions.
The texture is rebuilt only when a Mow Stroke touches it, while cut grass
settles, or four times a second — Regrowth cannot move a Blade Height by one
part in 255 faster than that.

The still parts of the ground — verge, lawn edge and the two coarse noises —
are baked into one texture the first time the Lawn says how big it is. Only
the finest grain is still worked out per pixel.

What remains is fill rate. A blade is one or two pixels wide, so the field
multisamples with four samples: without it the blades come apart into
speckles that crawl as the Mower drives. Four is the count every WebGPU
adapter must support, and it costs about 1.3 ms a frame.

Density is then dynamic, the way consoles hold a frame rate, but it never
goes above one device pixel per CSS pixel. Drawing more pixels than the
screen has was tried and dropped: with multisampling it changes almost
nothing that can be seen, it costs 4 ms, and it put the frame on the edge of
the display's interval, where the density rose, missed, and fell back in a
visible pulse. On a screen too large to hold the rate the field draws fewer
pixels instead, down to 0.7, a step at a time, and takes a step back only
after three good seconds.

The measure must be the mean frame gap and not the median: with vsync every
gap is a multiple of the display's interval, so a screen that misses every
second frame still has a median of exactly one interval and reads as
healthy. The HUD is a separate canvas and stays sharp throughout.

## Generated geometry

  A moving patch of procedural geometry must hash its **absolute world cell**,
  never a cell relative to the patch origin. The origin moves with the camera,
  so a relative hash re-randomises every blade each time it steps, and the
  whole field flashes. Thin moving geometry also needs MSAA, and geometry that
  sits on the ground plane needs the ground pushed a hair below it.

  Two WebGPU traps cost an hour here. A shader that uses a WGSL reserved word
  (`out`, `half`) still yields a pipeline object: draws with it are dropped in
  silence, so the screen stays empty with no error. And `layout: "auto"` builds
  a layout from the bindings a shader really reads, so a bind group that offers
  one more is invalid. Keep `getCompilationInfo()` and an error scope around
  pipeline and bind group creation.
- `wrangler.jsonc` — bindings. `/lawn` is the WebSocket; all other paths are
  static assets.

## Commands

    npm run dev        # wrangler dev on port 8788
    npm run typecheck
    npm run deploy
