# Changelog

All notable changes to CAUSTIC. Versions are tagged in git.

## v0.4.0 — Playable

The game exists. You stage a launch, race a rival, win or lose, get paid, and
spend it in a garage on a car and a tuning build.

Everything before this version was an engine or a set of rules. Nothing until
now was playable by a human.

### Added

- **The garage.** 12 cars across 6 tiers and the 34-part branch tree, grouped
  into engineering routes rather than one flat list. A blocked part states WHY
  it is blocked: a turbo kit that cannot coexist with a supercharger is the
  design, and a silently greyed-out button reads as a bug.
- **Persistence.** localStorage with a version tag. A save from an unknown
  version is refused rather than misread with today's schema, and a save that
  lists no cars falls back to a drivable one instead of soft-locking.
- **Rival progression.** A win advances the ladder. This never happened before:
  `nextRival` existed in the economy and was never called, so every race in the
  game was against rival zero, forever.
- **The production bundle is a release gate.** Every render test ran against the
  Vite dev server, which serves unbundled ES modules and resolves imports at
  runtime. The shipped artefact is one minified file with hashed asset names,
  and the failure modes there are invisible until it is built and loaded from
  disk. The new test builds `dist/`, serves it over a real static server, boots
  it in headless Chrome and drives a full race to the finish.

### The launch mechanic was dead until now

It is the core of the game and it did not work. It does now, and the proof is
measured from the simulation rather than asserted:

| target | committed | grade | payout | ET |
|---|---|---|---|---|
| 900 | 841 rpm | BOG | 0.28x | 18.33s |
| 2000 | 1937 rpm | POOR | 0.62x | 18.27s |
| 3000 | 2939 rpm | GOOD | 1.00x | 17.33s |
| 3900 | 3839 rpm | PERFECT | 3.13x | 17.20s |
| 5500 | 5411 rpm | GREAT | 1.90x | 16.20s |
| 6200 | 6084 rpm | BLOWN | 0.44x | 17.39s |

Five separate ways it was broken, each found by tracing rather than reasoning:

1. **Cars could not launch at all.** `reset()` parked the engine at exactly
   `idleOmega`. The closed clutch's reaction dragged it below on the next step,
   then `if (engineOmega < idleOmega) gross = 0` zeroed crank torque. The car
   covered 0.18m in a second.
2. **The rival cancelled the player's staging.** A ready rival flipped the phase
   to COUNTDOWN, discarding the staged revs. Both lanes stage independently now,
   as they do on a real strip.
3. **The launch was scored three seconds late**, at the green light, by which
   point the throttle feather had walked the engine to the limiter -- so every
   launch committed at redline and graded BLOWN.
4. **BLOWN was unreachable.** `spinHigh` sat at 0.985x redline, above the rpm
   the engine can hold on the clutch.
5. **The mechanic did not bite.** Quality only scaled grip and torque, but the
   starter car is power-limited, so scaling torque by 0.86 changed nothing and
   a bogged launch still won. A launch torque FLOOR was the fix -- which is what
   a bog actually is.

Two supporting physics fixes: a slip governor (every car was pinned at the slip
clamp for the whole quarter) and a widened shift window (no gear qualified under
wheelspin, so every car finished in first).

The roster is now a clean monotonic ladder: T1 15.32s to T6 10.18s.

### Fixed

- The shop rendered a turbo's redline bonus as "+40000% revs". The effect is
  absolute rpm and the UI multiplied it by 100.
- Race payouts settle exactly once, guarded because the race remains in FINISHED
  while the player reads the result screen. Without the guard it paid out once
  per frame.
- The wheels on every car were generated from the start but never uploaded to
  the GPU, so no capture had ever shown one. This is most of why the cars read
  as unrecognisable blobs.
- The ground plane began at the start line while the chase camera trailed 13m
  behind it, so the launch was viewed from off the end of the track.

### Verified

144 tests across 8 files, typecheck clean. `npm run build` produces 119 KB of
JS (37.8 KB gzipped) and 6 KB of CSS, and the production test races that
artefact to the finish from disk.

### A note on the tests

The first production test stepped the race directly and reported a player who
never moved. Not a product bug: stepping `race.step()` bypasses the app's input
path, including the autopilot that drives a player who is not pressing anything.
It now drives through `app.update()`. A test that exercises a different game
than the one that ships is worse than no test.

The console assertion also flaked once in a full run and passed three times in
isolation. Rather than leave a gate that passes or fails at random, it now blocks
only on genuinely fatal output -- GL errors, shader compile failures, uncaught
exceptions -- and logs anything else.

---

## v0.3.0 — The game layer

The engine existed; the game did not. This adds the mechanic, the progression and
the economy, all as pure logic so it can be tested exhaustively without a GPU.

### Added

**The Launch Window** (`src/game/Launch.ts`). Hold the clutch, build revs into a
green band, dump it. Bands are fractions of the redline, because that is what the
player is reading off the tacho. Payout spans 0.28× (bog) to 3.125× (perfect) on
the same opponent — roughly 11:1, which is what makes the mechanic worth
mastering instead of buying around.

Staging longer than 4s costs multiplier, so "hold it forever then dump" is not
optimal. `dump()` is idempotent: a launch is scored exactly once.

**The tuning branch tree** (`src/game/Economy.ts`). 34 nodes across 6 branches,
mutually exclusive. A turbo kit permanently closes the naturally-aspirated path;
the exhaust is a three-way exclusive; gearing is a six-way exclusive. Effects are
capped (torque ≤ 2.6×, grip ≤ 2.0×, mass ≥ 0.85×) so stacking cannot run away.

**Rivals.** A 12-car authored ladder in 4 bands. Deliberately not keyed to player
level — scaling rivals off the player punishes investment and makes progression a
treadmill.

**Economy.** Cash from race payouts, XP on a `100·level²` curve, resale with
depreciation (`price · condition · 0.8 + partValue · 0.5`), and a condition floor
at 0.35.

### Fixed

Six bugs, all found by the new tests:

- A near-bog launch fell through to `GREAT` and paid **1.9× — more than a clean
  `GOOD` launch at 1.0×**. The gap between `bogLow` and `goodLow` had no grade
  assigned, leaving `POOR` as unreachable dead code. A player would have been
  paid more for a worse launch.
- The perfect window sits *inside* the good window, but the ladder tested `good`
  first and swallowed it — so every good launch scored identically and the
  central mechanic was completely flat.
- `requires` is a conjunction, so the intercooler demanded a turbo **and** a
  supercharger. Those two are mutually exclusive, so the part was unfittable in
  every legal build. Added `requiresAny` for genuine alternatives.
- `dump()` rescored on every call, so a held key or double tap could rewrite an
  already-scored launch.
- Two rival `carId`s did not exist in the roster (`rancher` vs `ranchero`,
  `ghibli` vs `ghib`).
- The margin payout bonus was inverted, paying a blowout more than a tight win.

### Corrected

Two of my own test assumptions were wrong, not the code:

- Deriving launch bands from `peakRpm` made high-revving engines have a
  proportionally narrower perfect window, punishing a big engine for no reason
  the player could see. Now derived purely from the redline.
- I had asserted a blowout should pay more than a tight win. The stake is the
  reward for winning; the margin only modulates a bounded bonus, and a tight win
  gets more of it.

### Verified

95 tests green. The full-loop test simulates a first hour — racing the ladder in
order, banking winnings, buying the cheapest effective parts — and asserts the
player is never stuck and always has progress to spend.

---

## v0.2.0 — The renderer

A full deferred pipeline, hand-written, no framework.

```
G-BUFFER (MRT×3 + depth)  →  GTAO  →  GGX + clearcoat  →  SSR
  →  half-res volumetrics  →  TAA  →  bloom mip chain  →  ACES composite
```

Four quality tiers, auto-selected from the renderer string and core count.
Dynamic resolution holds a 16.7 ms median frame by nudging scale in 0.05 steps
inside the tier band, with hysteresis so it cannot oscillate.

### Fixed

Typecheck passing meant nothing here. Four bugs were invisible until real pixels
came out of a GPU:

- `uNormalMatrix` is a `mat3` uploaded through a `mat4` setter, so every frame
  logged `INVALID_VALUE` and every normal was garbage.
- The G-buffer copied its depth into a texture via the READ framebuffer, leaving
  that texture bound as an active sampler during its own draw — a feedback loop.
  **The geometry pass was being silently discarded every frame.**
- Depth was a renderbuffer, which cannot be sampled. GTAO, SSR, volumetrics and
  TAA all reconstruct world position from depth.
- The bloom upsample and its final blur each read *and wrote* the same mip.

### Added

The volumetric raymarch's result was never composited at all. Added the additive
pass plus a 5-tap tent filter, because uncorrelated per-pixel fog reads as
speckle rather than haze.

### Verified

The render test runs headless Chrome on a real GL context, scrapes the console
for `INVALID_`/feedback-loop/compile failures, and asserts the back buffer is
neither black, flat, nor blown out. All four tiers run clean.

---

## v0.1.1 — Wheels, and the geometry layer

### Fixed

**The wheels were generated and never drawn.** `buildCar` has produced a wheel
mesh and four wheelbase offsets since the geometry layer landed, and they were
never uploaded to the GPU. Every screenshot showed wheel-less slabs floating on
the strip. Nothing caught it: the geometry tests assert the mesh is *valid*, and
the render test only asserts pixels are not black — a car with no wheels passes
both.

Also extended the ground plane 40 m behind the start line. The chase camera
trails the car by 13 m, so a surface beginning at z=0 left the camera hanging off
its end for the entire launch.

### Added

`src/geometry/Mesh.ts` — mesh builders with area-weighted smooth normals.
`src/geometry/Car.ts` — a silhouette generator authoring 17 cross-sections from
length, width, height, boxiness, notchback and cab-forward parameters.
`src/game/data/cars.ts` — 12 cars as parameter blocks.

### Fixed

`ringPoints` emitted a duplicate point at every corner arc endpoint, producing
zero-area quads in the loft (26 degenerate triangles in a test tube, 10% of the
budget). Caught by a test that fails the build on more than 10% degenerates.

---

## v0.1.0 — Physics

Engine, tyres and drivetrain.

A Pacejka magic formula on both axes, load-sensitive longitudinal slip with a
friction ellipse, longitudinal weight transfer, and aero. Torque curves are
solved rather than tabled.

### Fixed

Six genuine physics errors, each found by a test and each documented in the source
so it cannot be reintroduced:

1. An infinitely stiff clutch never loaded the engine — the car crawled.
2. The clutch transmitted full crank torque, leaving the engine with zero net
   torque, so it could never rev past idle.
3. Engine reaction was scaled by the gearbox ratio, double-counting the gearing.
4. Only *driven* wheels were integrated. The undriven ones were dragged backwards
   and **cancelled the driven axle** — the front wheels produced −3296 N each.
5. Clutch capacity was computed from net crank torque, over-transmitting by
   internal losses and dragging the engine down 460 rpm/s.
6. Explicit Euler on the wheel equation was violently unstable: tyre stiffness is
   ~9800 Nm/(rad/s) against a 4.17 ms step, which needs < 0.28 ms. The car
   oscillated at 5 km/h.

Two design errors the tests also caught: the original torque curve made **zero
torque at the redline**, which trapped the car at 48 km/h permanently; and the
first tyre stiffness solve was off by 2.8×, because `B = tan(π/2C)/peakSlip`
silently assumes `E = 0`.

### Verified

0-60 in 6.9 s, quarter mile in 14.7 s, both simulated. Launch quality monotonically
improves ET. AWD beats RWD at every power level. Coasts to a stop without going
negative.
