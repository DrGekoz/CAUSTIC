# Changelog

All notable changes to CAUSTIC. Versions are tagged in git.

## v0.4.0 — Playable

The game exists. You can stage a launch, race a rival, win or lose, get paid,
and spend the money in a garage on a car and a tuning build.

Everything below v0.4.0 was an engine or a set of rules. Nothing before this
version was playable by a human.

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
