# The Lawn

One shared lawn on the web. A visitor drags the pointer to mow. The grass grows
back. If nobody mows, the lawn becomes fully overgrown again.

## Ubiquitous language

- **Lawn** — the one shared field. One Durable Object instance, name `the-lawn`.
- **Tile** — one cell of the Lawn. The grid is 408 x 272 = 110,976 Tiles.
- **Blade Height** — how tall the grass on a Tile is, from 0 (mown) to 1
  (fully overgrown).
- **Mow Stroke** — the swath between two pointer positions. The Mower cuts a
  capsule with radius `MOW_RADIUS` around that line.
- **Field** — one parcel of the Lawn, and one quest. There are nine. A Field
  is the ground that lies nearer its own seed than any other seed, so no
  Field is a box and no two are the same shape.
- **Slack** — the last part in a hundred of a Field, which may stand and the
  Field still count as cut. It is what turns the end of a quest back into
  mowing.
- **Seam** — the boundary between two Fields, where the two nearest seeds are
  the same distance away. Every seam is a Path, a Street or Water, and those
  three are the whole map.
- **Path** — the bare seam between two Fields. Nothing grows on it and every
  Mower drives over it at the speed it was going.
- **Street** — a seam a Mower drives fast on, and the one place a slipstream
  works. A Street is always a boundary and never a cut: it is either a seam,
  which lies between two Fields, or the ring, which lies outside all of them.
  No Street ever splits a Field.
- **Ring** — the Street round the kerb of the Lawn. It runs in the margin
  outside every Field, which is what keeps it from cutting the parcels it
  passes.
- **Verge** — the bare ground between the ring and the edge of the Lawn. It
  is what a Field gives up so the ring can be a boundary.
- **Water** — a seam a Mower cannot enter: it stops a Mower at the bank.
- **Bridge** — the dry crossing that cuts every run of Water, at the middle
  point between the two seeds it runs between. It is what keeps Water a
  detour and not a wall.
- **Bank** — the bare ground between the Water and the grass.
- **Report** — the one message a Mower sends about itself: where it is and
  which way it points. It is the Mow Stroke and the position at once, because
  both say the same thing about the same movement. See "What a report costs".
- **Mower** — one connected visitor.
- **Grip** — how hard a Mower may pull sideways. It is what makes the wheels
  the limit of a turn and not the key: the tightest circle a Mower can hold is
  its speed squared over the Grip, so the faster it goes the wider it comes
  round.
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
- **Cooldown** — the hour a Tile stays mown before its Regrowth starts. It is
  the same hour for every Tile. Without it the grass behind the Mower comes
  back before the far side of a Field is cut, and a Field never reads as
  wholly mown; with it a Mower can finish a Field and watch it stand at 100%.
- **Cycle** — the Cooldown and the Regrowth of one Tile together: the seconds
  from a Mow Stroke to a fully overgrown Tile.
- **Growth Rate** — the seconds one Tile needs for a full Regrowth, from 2 to
  6 hours. It is a smooth noise over the Lawn, in patches of `PATCH_TILES`,
  so the grass comes back in slow ground and quick ground. It is a pure
  function of the position of the Tile: no one stores it and no one sends it,
  and both sides build the same table.
- **Mower Key** — what says whose Score a Score is. The Lawn makes one, keeps
  the Score under it, and gives it to the Mower to bring back next visit. It
  is not the Score. The name and the colour of a Mower follow it; the `id`
  does not.
- **Score** — how many blades one Mower has cut. The Lawn counts them as it
  cuts them. It is the sum of the Blade Height of each Tile of grass the
  Mower took, so tall grass is worth more than stubble.
- **Achievement** — a thing the Lawn saw one Mower do, kept for ever under the
  Mower Key beside the Score. The Lawn awards it; a Mower never claims one.
- **Crowning** — the giving of a Field's Achievement to every Mower standing
  in that Field at the moment it is finished. The Lawn judges both: whether
  the Field is cut, and who is in it.
- **Log** — the corner that says what has lately happened on the Lawn: who
  arrived, who left, who won something, and which Field has just been finished.
- **Note** — one line of the Log, as the Lawn remembers it. It is kept in
  memory and never written down.
- **Snapshot** — how far each Tile is through its Cycle, from 0 to
  `SNAPSHOT_SCALE`, sent as a `Uint16Array`. No two Tiles share a Cycle, so
  the wire carries the fraction and not the age in seconds. The wire therefore
  stays the same when the Growth Rate or the Cooldown changes. The fraction
  spans the whole Cycle and not the Regrowth alone, so one entry still says
  everything about one Tile.

## The water wanders, or it is a box

`across` and `along` are the two sides of a rectangle drawn in a seam's own
frame, so Water measured from them is a rectangle — and that is exactly what
it looked like beside ground that had learned to be irregular. A Path already
wanders, and so does the bare earth around a tree.

`shoreWander` is three sines of the unwarped point, mean zero, added to the
Water's half-width and to both of its ends. The Water keeps its width on
average and only its edge moves, so the crossing is still a crossing and every
Field is still reachable — `scripts/check-map.mjs` is what says so, and it is
the reason the wander is a Tile and not three.

It is one wander per point and not one per run of Water: it depends on where
the point is and not on which seam is being measured, and `placeAt` is read
once per Tile of the Lawn on both sides.

The shoreline is clamped on the Street, and that is only safe because the
Street answers with a distance. It first answered with a choice — "does my
nearest pair of seeds carry a Street, yes or no" — and a choice is not a
smooth function of the point: the answer changed along the line where the
second-nearest seed changes, which put a step in the shoreline there, an
invisible bank a Mower stopped at. `scripts/check-junctions.mjs` is what found
it.

It goes in `placeAt` and not in the shading, so the water a Mower sees is the
water it cannot drive into. Softening only the drawn edge would have been half
the work and a lie.

## One table draws the map

The map is not a drawing and it is not stored. One table of nine seeds says
where each Field sits, in fractions of the Lawn, and everything else follows
from it: a point belongs to the Field whose seed is nearest, and the seam
between two Fields is where the two nearest seeds are the same distance away.
A second table, `SEAMS`, says what each seam is made of — a Street, Water, or
the Path that a seam is when nothing names it. The ground is bent by a pair of
sines before the seeds are measured against it, so no seam is a straight line.

A Street has to be a seam, because a seam lies between two Fields by
construction and so can never cut through one. The ring is the exception that
proves it: it is not a seam, so it is held outside every Field instead, and
the ground it would have taken out of a parcel is Verge and not Field at all.
That is the whole of the rule "no Street splits a Field", and it is worth the
five parts in a hundred of grass that the Verge costs.

That shape is why the Lawn can grow. Nothing in the map is tied to 408 x 272:
the seeds are fractions, so the same table draws the same map on a bigger
Lawn, and the Fields keep their names and their places.

There are three readers of that table, and only one writer of it. The client
and the minimap import `public/fields.js`. The shader is handed its own copy
of the map as WGSL, built from the same table by that same file. The Lawn
keeps a mirror in `src/index.ts`, for the same reason it mirrors the Growth
Rate: it counts the blades, so it has to know which Tiles are grass. That one
copy must stay identical.

Being built from the same table is what keeps the widths and the seams from
drifting. It is not what keeps the answers together, and it was easy to read
it as though it were. The working — nine seeds measured, three kept, eight
seams weighed — is written twice over, once in JavaScript and once in WGSL,
and two hands write two answers. Two checks hold the three copies to one:
`scripts/check-junctions.mjs` reads the Lawn against the client over a third
of a million points, and `public/check-shader.html` reads the shader against
the client over the same ground, by compiling `PLACE_WGSL` and running it on
the GPU. The second needs a GPU, so it is a page and not a script: serve the
site and open `/check-shader.html`.

Both were written against a fault, not against a hope. The shader check was
shown three of them — a Street that never ends, a warp out by one part in
five hundred, and a shader naming the second-nearest seed — and it named all
three before it was believed.

`node scripts/check-map.mjs` reads the map the way a Mower does and says
whether it holds together: how much of the Lawn is grass, Path, Street and
Water, and whether every Tile of every Field can still be cut. It holds the
map to three rules and fails when one breaks — every Field is one piece, every
Tile of dry ground can be reached, and no Tile is both wet and on a Street.
The first is the one that says no Street splits a Field.

A crumb is not a split. The bank is narrower than a Mower is wide, so the odd
Tile of grass ends up in a pocket no Mower can enter, and the wander of a Path
now and then pinches one off. The Slack is what says how much of that a quest
can carry, and it is the same Slack the tracker measures against: below it,
nothing on the screen can tell.

## Finishing a Field is worth a moment

Finishing a Field used to look exactly like walking into one: the same
banner, the same animation, a different word in the label. The one thing on
this Lawn a Mower can finish read as an announcement.

It now happens where the Mower is looking, which is the Lawn and not the
corner of the screen. The parcel itself lights up — a ring of warm light runs
out of the middle of the Field and a wash follows it, gone in three seconds —
so what answers is the shape the Mower has just spent its afternoon on. The
light is the Field's own and is added after the shading, so it lifts ground
the sun is not on.

It is a glow and not a flash. The first cut of it washed the whole screen to
white and took the grass, the stripes and the banner with it; a Field lit that
hard shows the Mower nothing of what it has just done.

Three smaller things carry the rest. The banner has a second mood — gold, a
tally of the Fields cut, and a spring instead of a slide — because those two
events were never the same event. The Mower throws a handful of gold
clippings. And the map fills in: a finished parcel is painted the pale, warm
green of grass that has just been cut, so the map answers "how much of the
Lawn is done" at a glance and keeps answering it long after the moment.

A Field that was already finished when a Mower arrives gets none of this. The
tracker reads the whole Lawn on its first pass, and what it finds there is
what other people did, or what this Mower did yesterday. Only a Field
finished after that first reading is worth a fanfare — before this, opening
the page on a cut Lawn threw a celebration for somebody else's work.

The flare is motion, so a visitor who asks for less of it keeps the banner,
the tracker and the map, and the Lawn stays as it was.

## The end of a quest is mowing, not searching

A Field is ten thousand Tiles. Asking for every one of them made the last
minute of a quest a different game: the grass was plainly cut, the tracker
said 99%, and the Mower drove the parcel again looking for one tuft it could
not see from the seat.

So a Field counts as cut with one part in a hundred still standing. That is
about a hundred Tiles — a patch some ten Tiles across, which is a thing a
Mower can miss without being careless, and not a thing it can leave half the
Field standing behind.

The number on the screen is measured against that goal, not against the last
blade. The bar therefore fills exactly as the quest completes, and it never
reads 97% and then jumps: 97% really is 3% standing. Slack is what the
progress is measured against; it is never taken off the end of it.

## Driving has weight

Three things say how fast a Mower is going, and none of them is a number on
the screen.

**The grass is heavy.** Deep grass costs a Mower a quarter of its speed:
11.3 Tiles a second on ground it has already cut, 8.0 in a standing Field.
It is drag and not a limit, so a Mower leaving a cut swath settles into the
grass instead of hitting a wall, and the reading is taken across the leading
edge of the deck — the Tile under the middle of a Mower was cut by that
Mower, and a Mower measured there would never meet grass at all.

Nothing here ever makes a Mower faster than it was. The speed of a cut swath
is the speed the Lawn has always allowed; the grass is what takes it away.
That matters, because a boost would have to be bought from `MAX_SPEED` on the
Lawn, and every Tile a second added there is a Tile a second a rewritten
client may shave. This costs nothing, and the Lawn never sees a swath it has
to refuse.

**The camera leads.** A camera nailed to the Mower holds it dead still in the
middle of the frame, and then the only thing on the screen that says thirteen
Tiles a second is the ground going past. The camera looks up to five Tiles
ahead and takes 0.16 seconds to get there, so the Mower runs out ahead of the
middle as it picks up speed and settles back as it stops. It stands further
off the faster the Mower goes, which widens the view ahead where there is
most of it to read.

It leads on the travel and never on the throttle. A Mower held against a bank
or another Mower is going nowhere however hard it pushes, and a camera that
read the throttle would walk away and leave it behind. Measured: 2.43 Tiles
of lead on a cut swath, 1.80 in deep grass, 0 in the corner of the Lawn at
full throttle.

**The body wears it.** The nose lifts about two and a half degrees under
power and dips as much off it, and the body rolls three and a half degrees
out of a corner — out of it and not into it, because a Mower turning right
throws its weight to the left. The normals turn with the body, or the light
slides off the paint while the machine leans under it, and the whole machine
lifts by as much as the lean takes down, or a wheel goes through the ground.
Everyone else leans too, worked out from the reports they are drawn between.

None of it moves a Mower one Tile. The lean is worn, the camera is a view,
and the grass is the only one of the three that touches the driving.

A camera that moves on its own is what reduced motion asks about, so that one
keeps the camera nailed and the bodies flat.

## A Street is measured, not chosen

The first Street read the map by asking whether the nearest pair of seeds
carried one. That is a yes or a no, and it is why the gravel used to stop dead
in the middle of open ground: the answer flips along the line where the
second-nearest seed changes, so the Street ended on a straight hard edge with
grass and earth carrying on either side of it, and a Mower lost its speed
mid-corner for no reason it could see.

A Street is measured now. Each seam that carries one is measured on its own:
`across` is the distance to the seam, and the junction where a third Field
comes nearer is where the seam ends. Before that junction the answer is
`across`, exactly as it was. Past it, the answer is the distance to the
junction itself, so a Street that ends rounds off over its own width instead
of being cut with a knife. The map takes the nearest of those and the kerb.

That is also what lets the Water be clamped on the Street again, which is what
the ring alone used to do: a distance can be clamped on, and a choice cannot.
It costs a third seed in the main loop and eight cheap sums, and it buys every
edge on the map being one a Mower can see coming.

## The Streets and overtaking

There are two Streets and they are one route. `src/road.ts` defines the ring,
a gently warped loop at the kerb of the Lawn; `SEAMS` in `public/fields.js`
names the eight seams between the top row of Fields and the bottom row, which
together read as one run of road across the whole width. The run meets the
ring at both ends, so a Mower can stay on a Street from any part of it to any
other — `scripts/check-driving.mjs` is what says so.

A Street is 14 Tiles wide, which leaves room for two mower decks to pass. A
Street clears the Water it crosses; its signed distance is shared by the
server and the client, and mirrored in WGSL. The minimap draws the same
Streets.

`src/driving.ts` owns movement and the shared 25 Tiles/second speed ceiling.
Street cruising is about 20 Tiles/second, versus 8.4 in standing grass. Grip
is 32 on a Street and 14 on grass. Speed eases down when leaving one.

Space brakes. A tap while steering above 7 Tiles/second starts a drift lasting
up to 1.6 seconds; the tap may precede steering by 0.25 seconds. Travel lags
behind the mower's heading during the slide. Releasing Space lets it continue;
straightening, slowing below 5, or a Stun ends it. Brake pressure builds over
0.22 seconds; drift grip eases in over 0.16 and out over 0.2 seconds. Holding
Space keeps braking and cannot repeatedly trigger a slide. Touch uses a held
Brake button. Rear wheels leave ground-anchored skid marks while sliding,
including other mowers based on their observed sideways travel. Marks last
12 seconds, fade over the last five, and are capped at 1,200 segments.

A moving mower 5–28 Tiles ahead on a Street gives a slipstream when its travel
direction agrees with the follower's. The tow builds over 0.8 seconds and fades
over 3 seconds after pulling out, giving the follower speed to pass. Stale,
stationary, opposing, and side-by-side peers give no tow. Reports carry the actual travel vector after collisions, so drifting and
stopping against a bank reach other players without extra incoming messages.

Run `npm run test:driving` for movement and passing-clearance checks, and
`npm run test:junctions` for client/server map agreement and water continuity.

## Field cornering

A Mower at full throttle used to come round inside 6.8 Tiles on a cut swath and
4.9 in a standing Field, against a deck 5.2 Tiles wide: in the grass it turned
inside its own width. Full throttle and full lock drew a perfect circle, so
neither the corner nor the straight asked anything of the driver.

Off a Street, the wheels hold 14 Tiles a second squared sideways and
no more, so the tightest circle a Mower can hold is its speed squared over
that: 15.0 Tiles across on a cut swath and 7.7 in a standing Field. Under about
four and a half Tiles a second the wheels never run out, and the Mower steers
as it always did — a Mower at a walk still turns on the spot.

So a corner is bought with the throttle. Come off it and the drag takes half
the speed in an eighth of a second and the turn shuts to a quarter of the
width; stay on it and the Mower goes wide. That is the whole of the skill: the
throttle is the steering at speed, and a straight pass through a Field is
worth driving because the turn at the end of it costs something.

Steering alone does not scrub speed. The brake and drift add drag; the Grip
limits the turn, and the Lawn caps travel using the shared `MAX_SPEED`.

## The water says no, and the Lawn says it too

Water is the first thing on the Lawn a Mower cannot drive through, so both
sides have to hold it. The client keeps a Mower a whole Mower's width from
the water, and a step that would end in Water is tried again along each
axis on its own, so a Mower that meets a bank at an angle slides along it
instead of stopping dead.

The Lawn then walks every swath before it cuts it, in steps of 0.75 Tiles —
short enough that no step strides over water 5.2 Tiles wide — and stops the
swath at the water's edge. A client that says it swam gets the near bank and
a fresh Snapshot.

This costs an honest Mower nothing. Its own client already holds it 2.2 Tiles
from the water, and the Lawn stops only at the water itself, so the two
never disagree. What it closes is the whole of the gain: the far bank stands
6.8 Tiles from the near water's edge and a Mow Stroke reaches about 2.03, so no
Mower cuts across Water, however its client is written.

One hole stays open, and it is the one that was already there: a Mower the
Lawn has not seen is believed once, so a reconnection can put a Mower down on
the far side of the Water. It cuts nothing on the way — the first Mow Stroke
of a Mower only says where it starts — so Water costs a cheat one reconnection
and buys it no grass.

Every run of Water is cut by one Bridge, and `scripts/check-map.mjs` proves the
result is one piece of ground: if it were not, a Field behind the water could
never reach 100% and its quest could never be completed.

## Why there is no server tick

The Durable Object stores one number per Tile: the epoch second of the last
Mow Stroke. Blade Height is a pure function of `now - mownAt`, the Cooldown,
and the Growth Rate of the Tile, which is itself a pure function of where the
Tile is. Therefore:

- No timer runs to make the grass grow. The Lawn stays correct while the
  Durable Object hibernates.
- The client uses the same function, so it animates growth with no traffic.
  The server sends only Mow Strokes.
- The state is 444 kB (`Uint32Array`), and it stays that size for ever. It is
  written in chunks, because one storage value holds 128 KiB.

An alarm exists, but only to write the state to storage 10 seconds after a
change. It is a debounce, not a simulation step. See "What a report costs".

## Presence

A Mow Stroke carries the position, heading and actual travel velocity, so it
is the position report as well. The server relays it and keeps nothing on disk, because a position has
no meaning after the Mower leaves. A client forgets a Mower it has not heard
from for 4 seconds. Hibernation therefore costs almost nothing: a Lawn that
wakes has forgotten where each Mower stands, and the next Mow Stroke says it
again.

`{t:"pos"}` is the older message that carried a position on its own. The
server still takes it, because a tab open across a deploy keeps sending it.
Nothing writes it any more.

`src/positions.ts` samples remote movement with 50 ms of interpolation delay
and at most 150 ms of prediction. Small corrections ease over 60 ms; stale
mowers stop predicting. The client samples peers before driving, so drawing,
collisions and slipstream all use the same positions. Prediction respects
banks, trees and map edges. Reports from older tabs fall back to measured
travel, and histories are bounded while a tab is in the background.

Each new report has a sequence number. The server replies with the accepted
position, including the first report. The driver applies any difference while
preserving movement since that report; corrections already applied are
subtracted from later replies for reports still in flight. This prevents a
speed or water limit from correcting everyone except the driver. Reconnecting
clears pending reports and peer history. These are bounded estimates: network
latency and abrupt turns can still require corrections; collisions remain
client-simulated rather than server-authoritative.

`npm run test:positions` checks prediction, jitter, drafting, corrections and
the server's speed limit.

## What a report costs

Cloudflare counts 20 incoming WebSocket messages as one request, and every
alarm as one more. The Workers Free plan allows 100,000 requests a day and
100,000 rows written a day, and one write of the Lawn is 4 rows. The whole
world shares them. What a Mower sends is therefore a budget, not a free
choice:

- **One report, not two.** A Mow Stroke and a position say the same thing
  about the same movement. They were two messages and are now one.
- **A report every 100 ms.** The swath the Lawn cuts between two reports is a
  straight one, up to 2.5 Tiles long against a Mower 5 Tiles wide, so the
  grass still comes off where the Mower drove. Your own Lawn is cut every
  frame, so nothing about the driving reads slower.
- **A Mower that stands still says so every 500 ms.** A report that repeats
  the last one is news to nobody and still costs the Lawn. It cannot stop
  altogether: a client forgets a Mower it has not heard from for 4 seconds.
- **The Lawn is written every 10 seconds, not every 2.** A Lawn nobody drives
  on is put out of memory after a while, and what it had not written down
  goes with it. The price is 10 seconds of Mow Strokes on a Lawn that takes
  hours to grow back.

Together these are about a quarter of what a Mower used to cost while it
drives, and a twentieth while it stands still.

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

The velocity of the other Mower comes from its reported travel vector, capped
at the shared speed ceiling. This follows actual movement rather than the
nose or throttle. A brief gap between reports preserves travel for drafting
and collision checks; once prediction expires the Mower counts as stopped.

Then a Stun buys `STUN_GRACE_MS` of Grace. Without it, one Mower parks beside
another and rams it again the moment it comes round, and the Mower under the
wheels never drives again. With it, the worst a Mower can do to another is one
second in four, and the Mower it holds keeps the other three to drive away in.

The Grace is kept by the Mower that was dazed, because a Mower only ever
dazes itself. A rewritten client therefore cannot hold anybody: the answer to
"may I be dazed again" is never asked of the Mower that is doing the ramming.

## An Emote is read from across the Lawn

An Emote is held on E, and not on the space bar. The hand that drives lies on
W A S D, and E is under the finger beside it; a thumb on the space bar is a
hand that has left the wheel. Space is nobody's key now, so it goes back to
the buttons on the page: a visitor who tabs to one and presses it has it
press.

There are five: a wave, a thumb, a smile, a heart and a skull. The first four
say a friendly thing, and a Lawn where every answer is friendly has no answer
for a Mower that has just driven you into the Water. The skull is that answer,
and it is the mildest one the Lawn will ever hand out.

The pictures live on the client, and the Lawn knows only how many there are:
`EMOTES` in `public/index.html` holds the glyphs and `EMOTE_COUNT` in
`src/index.ts` is the number the Lawn will relay. A sixth Emote is two edits,
and one of them without the other is an Emote nobody else can see.

A card in the air, and a card too small is a card nobody reads at
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
factor every frame — 110 Tiles across in the corner, the whole Lawn when it is
out — so the ground under the frame runs out at an even pace instead of
bolting at the end. And the names of the Fields arrive late, because a map
that fills the screen has the room to write them and the corner has room for
none of it.

The World Quest Tracker steps aside while the map is out, the way it already
stands down for the Field banner. It stands over the right of the map, and it
says what the map says.

The map is held, like the board, and not switched on. A key you hold cannot be
left on, so a hand that leaves the keyboard always leaves the Lawn in view.

Everything else in that corner is measured from the map and not from a guess
at how big the map is. `drawMap` publishes `--map-top` and `--map-side` when
they move. The keys stand on the middle of those two — the map's right edge
is the margin it is drawn with and its left edge is `--map-side` in from the
right, so the middle of the two is the middle of the map at any size. The
World Quest Tracker takes the height that is left above them on desktop.
Touch controls use their own bottom-corner layout, independent of map size.

The Tracker takes that height as a whole, and its list takes what the heading
and the summary leave. Capping the list instead means guessing what those two
come to, and on a narrow window the summary wraps and they come to more — how
the list came to lie across the keys. A corner measured in fixed pixels is a
corner that overlaps itself on some window nobody tried.

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
second comes 100 ms later, by which time it has earned 1.5 Tiles and needs
1.3.

A client that is rewritten thus gets no advantage. It can send a Mow Stroke
every millisecond and still cuts 13 Tiles a second, the same as a thumb on a
phone. A Mower is shown to the others where the Lawn drove it to, which is
within that same budget, so each Mower is seen where it mows.

The budget is held under the Mower Key, not under the socket. Windows are free
and hands are not, so the thing that may only be spent once has to belong to
the Mower and not to the connection.

Before this the server only clamped a stroke to `MAX_STROKE` Tiles, measured
back from the end the Mower gave. Forty of those in a second cut 240 Tiles a
second. The clamp also threw away the swath of an honest Mower whose messages
were held up, and told that Mower nothing.

One hole stays open, because it is cheap and what it lets through is not: a
Mower the Lawn has not seen — a new socket, or one the Lawn forgot while it
hibernated — is believed one time. Its first Mow Stroke only says where it
starts and cuts nothing, so the cost of a teleport is one reconnection for one
stroke.

- A Mower the Lawn has not seen — a new socket, or one the Lawn forgot while
  it hibernated — is believed one time. Its first Mow Stroke only says where
  it starts and cuts nothing, so a reconnection buys a place to stand and no
  grass.

## One address, twelve Mowers

Every socket earns its own travel, so one person with many sockets cuts what
many visitors cut. Nothing in what a client sends tells the two apart; only
where it comes from does. The Lawn therefore counts: `MOWERS_PER_ADDRESS`
sockets from one address at a time, and the next one gets a 429 instead of a
Lawn. A new socket also costs the Lawn a whole Snapshot of 222 kB, so this
holds down what it costs to open sockets as well as what they can cut.

The address is a tag on the socket and not a note in memory. The count is then
an index lookup, and it stays right while the Lawn hibernates — which is where
the budgets in the WeakMaps are lost. Cloudflare writes `CF-Connecting-IP`
itself, so a client cannot say it comes from somewhere else.

This is a blunt instrument, and that is the reason to write it down: a house,
an office and a whole mobile network each look like one address. It bounds
what one address can do; it does not stop it. Twelve sockets on twelve Keys
driven flat out shave 147 Tiles a second off the Lawn, against 13 for one
honest Mower. The cap is what decides that number, so lower it if the Lawn is
still being shaved.

What it no longer has to hold back is the board. Twelve sockets on twelve Keys
are twelve Scores, and twelve sockets on one Key share one budget, so no Score
grows faster than one Mower whatever this cap is set to. The cap is now about
the Lawn and what a socket costs, not about who is at the top.

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
NaN, for as long as the sum stands. On the Lawn that sum now outlives the
page, so one bad addend would follow a Mower between visits.

The gates stop this on both sides. `heightAt` on the client and `bladeHeight`
on the Lawn answer 0 for a Tile they cannot date, instead of NaN, which is why
the Lawn may add its answer without looking at it; the client adds only a
Blade Height above zero. And `updateScore` refuses a score that is not a
finite number, so nothing that is not a number reaches the screen. The board
reads the score of another Mower the same way, because `??` passes a NaN
through and only catches a null.

Nothing about the score is kept in the browser any more. A score in
`localStorage` is a score the visitor can write, and the Lawn holds the real
one.

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

There is one number, and the Lawn owns it. There used to be two: the count of
one visit, which the Lawn could vouch for, and a headline score kept by the
browser across visits, which it could not. The second was the one on the
screen, so the screen showed the one number a rewritten client could still
invent. The Mower Key below is what closed that: the Lawn now adds every visit
to the same Score, so nothing about a score is kept in the browser at all.

The client still counts along, so the digits roll without waiting for a round
trip, and the Lawn overwrites that guess four times a second with
`{t:"score"}`. It is the bargain the Snapshot already makes for the Tiles: mow
first, and be put right.

## A Score needs a name to belong to

A Score the Lawn counts is worth nothing if it dies with the socket, and a
name the client chooses is a name a client can take. So the Lawn makes a Mower
Key — one `crypto.randomUUID` — and the browser only carries it. The Lawn takes
a Key back only when it already holds a Score under it, so a Mower cannot name
itself into the Score of another, and a Mower that has never cut a blade has
no Score, gets a fresh Key, and loses nothing by it.

The Key travels in a message, `{t:"i"}`, and it is the first thing a Mower
says. It used to travel in the address of the socket, as `?m=`. An address is
written down by every machine it passes — the logs of this Worker among them —
and the Key is the whole of the proof of who a Mower is, so a Key in an
address is a Score anyone who reads a log can take. The client sends nothing
else until the Lawn has answered with `{t:"you"}`, so no Mow Stroke is ever
counted under the wrong Mower. A client that never says which Key it holds — a
tab that was open across the deploy — still drives and still cuts, but nothing
it cuts is written down, because there is nowhere to write it. It reloads and
it has its Score back.

The Key is not the `id` a Mower is seen by. That stays one per socket, so two
tabs of one browser are still two Mowers on the screen and neither writes over
the other on the board. What the Key does carry is the name and the colour,
in `nm`: those two tabs wear one name, and so does the Mower that comes back
tomorrow. A Score with a name nobody recognises is only half an identity.
Measured: two tabs on one Key are two Mowers on the board with one name
between them.

The travel budget hangs on the Key too, and that is what bounds a Score. One
Score can only ever be fed by one budget, so ten tabs on one Key cut what one
Mower cuts: measured, one tab is let through at 12 Tiles a second and ten tabs
at 18 between them, which is the refill rate plus the bank draining once.
Eleven tabs would be the same. A tab that brings no Key gets a budget of its
own, but a Score of its own with it, so nothing is concentrated — opening
windows can only ever make more Mowers, never a faster one. `seed` still
empties that budget when a socket arrives, so reconnecting cannot refill the
bank.

Two honest tabs pay for this, and that was chosen with open eyes. They share
one pair of hands: each drives at about three quarters of the speed of a lone
Mower and sees the odd resync.

A Score is written down, unlike a position: it is saved with the Tiles, on the
same debounced alarm. To keep the state of the Lawn bounded the way the Tiles
are, the Lawn keeps `SCORE_KEEP` Scores and forgets the lowest — never one of a
Mower that is driving, so nobody loses a Score while they are earning it.

## An Achievement is given, never claimed

The board already learned this once. A client asked what its score is answers
seven hundred million, so the Lawn counts the blades itself. An Achievement is
the same kind of thing and worth more to forge, because a Score can be mown
again in an afternoon and an Achievement is meant to be a thing that happened.

So the Lawn awards every one of them from what it counted itself, and the
client is never asked. It holds one `Uint32` per Mower Key, a bit per
Achievement, beside the name and the blades. One number, four bytes: the state
of the Lawn is bounded by what it costs to store a Mower, and a list of objects
per Mower is not a bound.

The bit is the whole of the wire format, so a bit is never renumbered and never
reused. A Mower that earned bit 9 last month must still read bit 9 as the same
thing when it comes back. A new Achievement takes the next free bit; a retired
one leaves its bit standing empty.

What is earned is worked out from the tally each time and ORed into what is
held, never assigned over it. Then a threshold that is lowered awards the
Achievement to everyone who already deserves it, and a threshold that is raised
takes it from nobody.

There are four things the Lawn counts, and they only ever grow: the blades
(which is the Score), the Tiles driven, the Bumps, and the blades cut while
drifting. The blades are split by
Field on the way past, which costs the Mow Stroke nothing — it has to know
which Tiles are grass to count them at all, and the table that says so now names
the Field in the same byte. That table replaced a `placeAt` call per Tile per
Mow Stroke, so the Lawn does less work than before, not more.

## What the Lawn can vouch for, and what it cannot

A Field reading 100% on the World Quest Tracker is worked out on the client,
over every Tile of the Field. An Achievement hung on the client's word would be
an Achievement a rewritten client awards itself.

So the Lawn works the same sum out for itself. It already holds the moment
every Tile was mown and the Growth Rate of each one, so `fieldStanding` is
`fieldProgress` from `public/fields.js` with the same Slack and the same
stubble allowance, over the Tiles of one Field. Those two must stay identical,
for a sharper reason than the others: the flare, the banner and the card are
one moment, and a Lawn that called the finish differently would put the medal a
second to one side of the thing it belongs to.

Reading a Field is some eleven thousand Tiles. That is cheap but not free, so
the Lawn reads a Field only when a Mow Stroke has just taken grass off it, and
then at most every `FIELD_CHECK_MS` — except when the last reading put that
Field above `FIELD_NEARLY`, when it reads every time. The stroke that takes the
last of a Field may be the last stroke anybody makes there, so the reading that
matters most is the one that must never be skipped.

Only the crossing counts. A Field stays finished until the Regrowth takes it
back under the line, and then it can be finished, and crowned, all over again —
which is what makes standing in one Field for three finishes a thing a Mower
can set out to do. The first reading of a Field crowns nobody: a Lawn waking
beside a Field that was finished while it slept would otherwise hand out medals
for somebody else's afternoon.

A Bump the Lawn is only told about is the other hole. The daze is still relayed
on the Mower's word, because a Mower only ever dazes itself and a liar wearing
its own Stars costs nobody anything. The tally is not: the Lawn asks its own
question first — is another Mower within `BUMP_REACH`, and were the two of them
closing faster than `BUMP_CLOSING`? — from the positions and speeds it already
keeps for the ball. It costs nothing to add, because all of it was already
there. A Mower alone in a corner claiming a Bump a second is awarded nothing;
measured, twelve claimed Bumps with nobody near came to none.

This does cost the honest Mower something, and it was taken with open eyes. The
Lawn works the Closing Speed out from reports 100 ms apart, so it reads a real
ram lower than the client does and `BUMP_CLOSING` is half of the client's
`STUN_SPEED`. A genuine Bump the Lawn happens not to see is a Bump nobody is
told about, and the ladder climbs a little slower than the Stars on the screen
do. The ladders are short for that reason.

A drift is a third hole, and a different shape from the other two: the Lawn
never runs the Mower's own physics, so it never sees the tyres let go the way
it sees a Bump's closing speed, and there is nothing here to relay on trust the
way a daze is. What it can see is that a sliding Mower stops going where it is
pointed. The swath is ground the Lawn itself drove the Mower over, and the nose
is the heading that same Mow Stroke already carries for drawing it, so the
angle between the two costs nothing to read and is exactly what a slide opens
up. Steering alone cannot open it: the wheels take the Mower where they point
until they break away. The hardest corner the drive model allows without losing
traction slips 0.15 radians, a real slide runs from 0.6 to 1.2, and
`DRIFT_SLIP` sits at 0.3, in the space between them.

Three things are asked at once, above `DRIFT_SPEED`, and the third is what
keeps the hole small. The nose must lie `DRIFT_SLIP` off the swath. The swath
must bend `DRIFT_BEND` across the stroke, so a nose held crooked down a
straight is nothing. And the bend must run the same way the nose is turned,
because a Mower slides with its nose inside the corner and never outside it. A
Mower that wanted a drift it had not done would have to forge all three
together while genuinely driving fast over real grass — which pays the Score
anyway. A Mower too old to send a heading never drifts, because the Lawn will
not guess a nose it was not told about.

This was got wrong once, and how it was wrong is worth keeping. The first
version read the bend between two Mow Strokes on its own and asked for 0.5
radians of it. The drive model caps steering at 3 radians a second and a Mow
Stroke is 100 ms, so a swath can bend 0.3 at the very most: the bar stood above
everything the physics could reach and the Achievement could not be earned at
all. Tests either side of it passed, because the Lawn was consistent with
itself and the drive model was consistent with itself. `check-drift` drives the
real drive model into the real Lawn for that reason, and fails both ways — if a
genuine slide earns nothing, and if a corner that never lost traction earns
something.

An Emote cannot be made honest at all, so nothing is hung on one.

## Being there is the whole of the test

A Field is earned by standing in it as the last of it is cut. Not by cutting a
Field's worth of grass yourself, which was tried first and dropped.

The reason is the moment. A Field finishing already lights the parcel up, drops
the banner and counts the Fields cut; hanging the Achievement on a private tally
put a second, unrelated celebration a few minutes to one side of that, for work
nobody could see being done. Now one thing happens: the ground flares, the
banner falls, and the card arrives for everyone who was there.

The cost is that the Lawn does not ask who cut what. A Mower that drives into a
Field at 99% is crowned beside the Mower that cut the parcel, and a Mower parked
in the right Field at the right moment is crowned having cut nothing at all —
it does not even need a Score yet; `crownField` opens one for it. That is a real
hole and it is left open on purpose, because closing it means a ledger of who
cut how much of every Field since it last grew back, and a share big enough to
keep a leech out is a share big enough to rob the ninth Mower of a nine-way cut.
What it costs is the value of one medal to the Mower who did not earn it. What
it buys is that the medal lands with the flare.

## An Achievement outlives a Score

The Lawn keeps `SCORE_KEEP` Scores and forgets the lowest of a Mower that is
not driving. Left alone, that rule would throw away Achievements, and the two
are not worth the same: a Score can be mown again and an Achievement cannot be
earned twice. Worse, `{t:"i"}` takes a Key back only when the Lawn already
holds a record under it, so a Mower whose record was pruned comes back as a
stranger.

A Mower that has earned an Achievement is therefore never spare. That exemption
has to stop somewhere, because every Score is written into one storage value
and one storage value holds 128 KiB; a record runs to some two hundred bytes,
so `KEY_KEEP` is set at 500 and leaves the write about a fifth of that ceiling
in hand. Past it the Lawn forgets the lowest Score it holds, decorated or not.

That is the hole this leaves open, and it opens only on a Lawn that has been
busy for a long time. Raise `KEY_KEEP` — and split the Scores across chunks,
the way the Tiles already are — before it does.

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

## The window shows the rung you are on

Twenty-six Achievements is twenty-six lines, and most of them say nothing a
Mower can act on. "Cut a million blades" is not a thing to read while you are
working on the first thousand: it is grey text burying the two lines that mean
something today.

So a ladder — the blades, the Tiles driven, the Bumps, the blades cut while
drifting — gives up the rungs it has climbed and then the one being climbed,
with a bar and a count, and stops.
Nothing above that is drawn until it is next.

The nine Fields are the exception, because they are a set and not a ladder:
they are climbed in any order, so there is no "next" among them. They come as
the ticked list inside `The Whole Lawn`, which is the Achievement that asks for
all nine. One line, nine ticks, and the same 0/9 the bar shows.

Every Achievement is therefore a number against a number — `have` against
`goal` — and the window draws the bar without knowing what any of them mean.
`scripts/check-achievements.mjs` proves each ladder's goals rise in the order
the table lists them, because the window shows the earned rungs and then one
more: a ladder out of order would hide the rung being climbed behind one
already passed.

Each Achievement is its own card — a dark inset behind a slim warm bevel, with
its name across the head of it and a tile there saying whether it is won. A
flat list reads as one long thing to get through; a card reads as a thing in
its own right, which is what an Achievement is.

Cards cost height, and the window is meant to be read at a glance rather than
scrolled, so everything in one is measured against that. A card already won is
its head and nothing else: a tick over a line spelling out what it asked for is
exactly the line that pushes the card you are working on off the bottom. The
nine take as many columns as the width allows, because one column is nine rows
and nine rows is the whole of the room on a phone.

Measured, by how tall a window has to be before the window stops scrolling:

| climbed on each ladder | cards | desktop | phone |
| --- | --- | --- | --- |
| none | 5 | 530 px | fits |
| one | 8 | 645 px | fits |
| two | 11 | 759 px | fits |
| three | 13 | 780 px | fits |
| all of them | 13 | 672 px | fits |

The worst of it is three rungs climbed on two ladders and two on the third,
which wants a desktop window 780 px tall. A phone fits every one of them. Below
that a window scrolls, and that is the honest cost of twenty-six Achievements
as twenty-six cards with every won one still standing. Showing only the highest
rung climbed on each ladder would cap it at eight cards and fit anywhere; it is
not done because a card you won is a card worth keeping on the shelf.

What is earned is the mask and never what the client works out. The bar may
reach its end a moment before the tick arrives, and that is the truth of it —
the blades are counted here and awarded there, the same bargain the Score
already makes.

The tally the bars are drawn from rides on `{t:"score"}`, which already goes to
that one Mower four times a second and is never broadcast. A bar cannot be
drawn from a number the client was never told.

## The Log says what happened, and survives a reload

Four things happen on the Lawn that a Mower would otherwise never know about:
somebody arrives, somebody leaves, somebody wins an Achievement, and a Field is
finished. A Lawn where none of that is said is a Lawn of strangers, so the
corner says it.

The Lawn keeps the last `NOTE_KEEP` of them with the moment each happened, and
hands them to every Mower that connects. That is the whole of what makes the
Log survive a reload, and it is also what tells a Mower arriving in the middle
of somebody else's afternoon what it has walked in on. A replayed line does not
spring in and is drawn dimmer: it did not happen just now.

The Notes are held in memory and never written to storage. A Lawn only
hibernates when nobody is driving on it, so a Lawn that has forgotten its Notes
is a Lawn where nothing has happened — which is exactly what an empty corner
says.

The line about a finished Field is the one thing the Lawn does not send. Each
client says it as it draws the flare, so the two land together; the Lawn only
remembers it, for whoever arrives afterwards.

## Arriving and leaving belong to the Key, not to the socket

A reload closes one socket and opens another. That is not a Mower leaving and
coming back — it is the same hands on the same machine — and a corner that says
so twice is a corner crying wolf.

So presence for the Log is a property of the Mower Key. A Key with any socket
open is here. Arriving is announced the first time a Key is seen and never
again, which also means the second tab of one browser announces nothing.
Leaving waits: a Key whose last socket has gone has `REJOIN_GRACE_MS` to come
back before anybody is told, and coming back inside that cancels the goodbye
without a word.

Nothing else moved. `{t:"left"}` still goes out the moment a socket closes,
because the other Mowers use it to forget where that machine stood, and that is
presence rather than news — it fires for a reload exactly as it does for a
goodbye. What the Log says about it is decided separately and later.

Later needs waking, and that was the bug worth writing down: the sweep ran only
when a socket opened or closed, so the last Mower out of an empty Lawn was
never said to have left at all. The alarm now serves two masters — writing the
Lawn down and deciding who has gone — and `wake` hands it to whichever wants it
first, so neither can push the other back.

One hole stays open, and it is the Mower Key's own. A Mower that has never cut
a blade has no Score, so the Lawn issues it a fresh Key every visit; each reload
is therefore a new Mower arriving, and the corner says so. It closes itself the
moment that Mower moves, because moving is what writes its record.

## A cut blade is pale, or the Score reads as a fault

A Mower reported that its Score climbed while it was mowing nothing. It was
not: the Lawn counts the blades it takes off, and standing still takes none —
measured, on both sides, a Mower that stands still gains nothing and one that
re-drives ground it has already cut gains nothing either.

What had happened is that the swath went invisible. Cut turf had come to sit at
the same green as the grass around it while standing grass grew bright tips, so
a Mower could not find what it had already done, drove over standing grass
believing it was cut, and read its own Score going up as a fault.

So cut turf is pale again, on the blade and on the ground under it, and
standing grass is deeper than it was. The one on the screen that is brightest
should be the one that has been cut: that is what a mown lawn looks like, and
it is the only thing that tells a Mower where it has been.

## The cut fits under the deck

`src/mowing.ts` shares the deck dimensions, blade radius and tile traversal
between the rendered model, optimistic client cuts and server scoring. The
blade radius is about 2.03 Tiles, inset inside the actual faceted housing,
including its shorter rear edge. Collision clearance stays at 2.21 Tiles;
shrinking the cut must not change passing or ball contact distances.

Grass height is sampled at each blade's root. Randomly displaced samples and
extra ground-height blur made grass appear cut beyond the deck, especially
in front. Bilinear tile sampling still softens the edge, so the boundary has
tile-resolution limits. Grass depth is measured just beyond the leading edge
of the housing, including when reversing.

`npm run test:mowing` checks containment against vertices from `mowerMesh`,
client/server cut and score agreement, and split strokes. The map check uses
the same blade radius and asserts that every field remains completable.

## A Bonk belongs to the Lawn, not to the ear that hears it

The hit is the Lawn's: it runs the ball, and `hitBall` is the only thing that
knows a contact happened rather than two shapes overlapping. So the Bonk rides
in on the ball message that reports the hit, as `bonk`, and everybody on the
field hears the same one at the same moment. Read off the client instead — a
jump in the ball's velocity, say — and the Mower that swung would hear a hit
nobody else did, and a Mower watching from the far side would hear nothing.

`force` on the contact is the impulse the ball took, 0 to 1. It is what the
Bonk is played at, and it is the only thing that tells you how well you caught
the ball: a dribble alongside it sounds like a dribble, a full-speed charge
sounds like one. Held flat, every touch is a home run.

The Bonk jumps the 50 ms throttle on ball messages. A ball message can wait —
the client is predicting between them anyway — but a knock heard a frame late
belongs to no hit anyone saw. It is on the hit message only, and never on the
one a Mower gets on arrival: a Bonk is something that happened, not something
the ball carries about with it.

The sound is built rather than loaded, like the engine beside it, and hangs off
the limiter rather than the master gain: the master follows the Mower and sits
at zero whenever it is parked, and a ball you sent rolling goes on bonking
about after you have stopped.

## A Bump is heard where it is felt

A Bump makes the heavy noise, and it is played on the screens the contact
happened on rather than relayed from the Lawn. That is the opposite of the
Ball, and for the opposite reason: the Lawn owns the Ball and is the only
thing that knows it was struck, while both Mowers in a Bump already measure
the same contact and each daze themselves on it. Asking the Lawn would be
asking it to repeat what both screens have already worked out. A Mower
standing off to one side therefore does not hear it, the same way the Bump
was never its event to begin with.

It is voiced apart from the Ball. A ball is hollow and rings at about 180 Hz;
two steel decks meeting are weight and no note, so the deck dives an octave and
a half inside the first fifty milliseconds and then sits at about 50 Hz while
it rings out. Where the pitch lands is stated in Hz and not as a fraction of
where it started: taken as a fraction it falls with the force as well, and a
light knock ends up under 30 Hz, which is not a quiet sound but no sound at
all on the speakers most people are on. Force moves how loud and how long a
Bump is, and never how deep it is beyond what a speaker can still carry.

## The board wears the medals

Every name on the board carries a star with a number in it: how many
Achievements that Mower holds. The board is built from presence, so anything
the board says about a Mower has to arrive with that Mower — the count
therefore rides on the report, beside the tally, and is worked out from the
mask the Lawn already holds. It is the count and not the mask, because the
board shows a number and a number is eight bytes where a mask is thirteen.

The star stands beside the tally and not in front of the name. In front it is
the first number on the row, which reads as a placing — and it is not one, so
on a board sorted by Score it appears to run the wrong way.

Your own star is counted on your own screen instead of waited for, because the
Lawn tells you what you hold the moment it awards it, and the board should not
be the one place that lags a report behind the card.

The star is a chunky one — its inner points stand at 55% of the outer radius
rather than the usual 38% — because a star of ordinary sharpness has no width
at its waist to carry two digits, and twenty-six of them can be earned. The
slot stays when a Mower has earned nothing, so the names stand in one column
whatever anybody holds.

## Agreement between client and server

The client applies a Mow Stroke immediately, before the server confirms it.
The server can refuse a Mow Stroke when the Mower is over the rate budget
(`STROKE_RATE` per second), and it can cut less than the Mower asked for when
the Mower is over its travel budget. Then the two lawns disagree. To correct
this, the server sends a new Snapshot to that Mower. Keep the mow maths in
`src/index.ts` and `public/index.html` identical.

The client sends a maximum of one Mow Stroke every 100 ms. The Mow Stroke
covers the full movement since the last one. A fast drag thus cuts a
continuous swath with few messages. See "What a report costs".

## Driving with a thumb

A coarse pointer gets a stick in the bottom left corner and a two-by-two group
of Brake, Emote, Achievements and leaderboard buttons in the bottom right. The stick is a **direction**, not a wheel: it says where on the
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

The touch header holds the title, sound and score. Speed, driving mode and
the slipstream meter are not shown. Log and Map
are 44px toggles beside the folded World Quest Tracker. The tracker hides its
list completely until opened. The map, log and emote picker give way to each
other, keeping expanded controls out of the thumb zones. The map shrinks to
fit between the header and controls on short portrait screens; landscape
keeps the map between the thumb zones. Safe-area insets protect the edges.

Awards and the leaderboard open one at a time as scrollable touch dialogs.
An explicit close button, backdrop or Escape dismisses them. Opening one
clears held driving input and makes background elements inert; closing it
restores the trigger's focus. Desktop keeps its illustrated panels and
hold-key shortcuts. Entering touch mode also updates the help text.

A phone held sideways is 812 x 390: wide enough to pass a width breakpoint and
far too short for the layout behind it. The touch layout therefore answers to
both dimensions.

## Files

- `public/fields.js` — the map: the seeds, the seams and what each one is
  made of, and the WGSL the shader is built from. One file, three readers.
- `src/road.ts` — the ring Street at the kerb, and the only part of the map
  that is not a seam.
- `scripts/check-map.mjs` — reads that map and says whether it holds together.
- `public/check-shader.html` — the same proof for the third copy: it compiles
  `PLACE_WGSL` and runs it on the GPU against the client's `placeAt`. A GPU is
  not something node has, so this one is opened and not run.
- `scripts/check-junctions.mjs` — walks a third of a million points and proves
  the Lawn's copy of the map answers exactly what the client's does. It is the
  only thing that does, so it is wired into `package.json` as `test:junctions`;
  it had rotted unnoticed because nothing ran it.
- `src/achievements.ts` — the Achievements: the bits, the thresholds, and what
  each one is called. Built to `public/achievements.js` the way `src/ball.ts`
  is built to `public/ball.js`, so the Lawn and the client read one table and
  cannot drift. It touches no DOM, which is why it is shared where
  `public/fields.js` had to be mirrored.
- `scripts/check-achievements.mjs` — reads that table and says whether it holds
  together: one bit each, every Achievement reachable, none of them earned by a
  Mower that has done nothing, and the nine Field names the same as the map's.
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

## Trees

`src/trees.ts` defines nine trees, one inside each Field. The client and server
share their positions and trunk radii through the same build pattern as the
ball. Mowers slide around trunks; restored positions avoid them too. Crowns
are faceted clusters that cast shadows. Where a tree stands between the camera
and the local Mower, a soft screen-door cutout reveals the Mower and nearby
grass without needing to sort transparent faces. Shadows remain solid. A small
earth ring surrounds each trunk; its shared radius excludes it from grass and
quest totals, while the shader blends its edge back into the lawn.
