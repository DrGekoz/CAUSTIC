# CAUSTIC — Design & Technical Plan

> **Photoreal drag racing that runs on a laptop with integrated graphics.**
> *Caustic* — the shimmering light pattern cast by a curved surface. The name is the
> thesis: we are not shipping ray tracing, we are shipping what makes ray-traced
> footage *look* like ray tracing, at a cost a potato can pay.

Status: **PLAN ONLY — no game code written yet.**
Version: 1.0 · Author: DrGekoz · Repo: `DrGekoz/CAUSTIC`

---

## 0. Executive summary

CAUSTIC is a single-player, browser-native **1/8-mile drag racing game** built around one
signature mechanic that everything else serves: **the Launch Window**.

Every race is won or lost in the first 1.8 seconds. You stage the engine into the green
rev band, hit the perfect-shift window, and the quality of that launch is a *physical
multiplier* on rear-tyre grip and engine torque. A good car with a bad launch loses to a
cheap car with a good launch. Skill closes the gap; money widens the window you can hit.

Around that core: a **deep, infinite tuning ladder** (9 upgrade categories, exponential
cost, linear effect, no hard cap), a **24-rival career ladder** across 4 bands, a **30-node
skill tree** bought with a second currency, and **prestige**. The player earns cash from
races and spends it on the car; the car gets faster; faster cars earn more; the ladder runs
until prestige, then runs again, harder.

Rendering is a **hand-written WebGL2 deferred pipeline** — G-buffer, GTAO, cascaded
shadow maps with PCSS contact hardening, screen-space reflections, raymarched volumetric
light cones, TAA, and an ACES composite with mip-chain bloom. Every pass scales
independently, and a dynamic-resolution controller holds the frame budget on hardware that
has no business running any of it. There is **no 3D framework dependency** — the render
graph is the product.

**Explicit honesty note:** CAUSTIC does **not** contain hardware ray tracing, and this plan
does not claim it does. WebGPU ray-tracing is not available on the low-end hardware this
project is explicitly targeting. What CAUSTIC does is implement the *visual signatures* of
path tracing — correct-area specular, contact-hardening soft shadows, true screen-space
reflection, geometric ambient occlusion, participating-media volumetrics — using techniques
that are 20–100× cheaper and scale down to nothing. That is the entire design problem, and
§4 is the answer to it.

---

## 1. Repository research — all 12 repos, verified

Method: GitHub REST API (`/repos/{o}/{r}` + `/git/trees/HEAD?recursive=1`) plus
`raw.githubusercontent.com` for source. Every claim below is from fetched file contents,
not from descriptions.

### 1.1 Verdict summary

| # | Repo | Real? | Verdict | What we take |
|---|---|---|---|---|
| 1 | `niceguy704/Top-Speed-Drag-Fast-Racing-Full-Version` | ❌ | **Fake shell.** 4 files. No code. Hourly cron appends fake "run=… n=…" lines to `.github/hwcqHLYRrhWM` and pushes noise commits to a bait README. | **Nothing.** Do not clone. |
| 2 | `AntonC9018/race` | ✅ | Unity C# prototype + D math CLI. Real engineering. | **The engine torque-curve model (§6.2).** Nothing else. |
| 3 | `CagriCatik/RaceTrack` | ✅ | Three.js 3D racer, 288 files, ships the **Kenney Car Kit (CC0)**. | **Kenney CC0 GLB cars** as a legal fallback asset set only. |
| 4 | `lukaizj/car-mod-saas` | ✅ | Next.js + R3F car configurator SaaS, 21MB, real. | **Paint/material mapping technique + GLB optimisation commands (§11.3).** |
| 5 | `elisha-39/Ultra-Drag-Racing-Full-Version` | ❌ | **Fake shell.** Identical pattern to #1. | **Nothing.** |
| 6 | `everalon-20/Ultra-Drag-Racing` | ❌ | **Fake shell.** Identical pattern to #1. | **Nothing.** |
| 7 | `DevSwist06/togai` | ✅ | Top-down WebGPU racing, WASM physics, hand-written software mesh renderer, full test suite. | **Track spline format, software-mesh fallback idea, discipline (§11.4).** |
| 8 | `bait-3071taxied/CLUTCH-Early-Prototype-2026` | ❌ | **Fake shell.** 3 files, `activity.log` committed every 20 min by Actions. | **Nothing.** |
| 9 | `updraft63-enemata/STUNTBOOST-PC` | ❌ | **Fake shell.** Same. | **Nothing.** |
| 10 | `capacityknights88/Lead-The-Dragon-Devlog-2026` | ❌ | **Fake shell.** Same. | **Nothing.** |
| 11 | `TeggTTV/drag-racing` | ✅ | React 19 + Next 16, 32MB, deepest meta-game of the set. **No LICENSE file.** | **Architecture + economy *ideas* only. Zero assets (§11.2).** |
| 12 | `SkeloGH/dragster` | ✅ | Phaser 3 drag racer, 2018-era, clean small classes, MIT. | **Timing/state-machine clarity (§6.1).** |

### 1.2 Security finding — 6 of 12 are malware-distribution shells

Repos **1, 5, 6, 8, 9, 10** contain zero game code. They are SEO/engagement bait for
"free full-version racing game download". Their GitHub Actions workflows run on a **top-of-
hour schedule with `permissions: contents: write`** and do exactly one thing: commit a
randomly-worded line to a tracked file and force-push. The three "Devlog"/"Prototype" repos
use a `cron: '3,23,43 * * * *'` variant that appends `auto update` to `activity.log` every
20 minutes, forever, purely to inflate the commit-graph so the repo looks actively
developed.

Fetched example — `updraft63-enemata/STUNTBOOST-PC/.github/workflows/update.yml`:

```yaml
name: Auto log update
on:
  schedule:
    - cron: '3,23,43 * * * *'
permissions:
  contents: write        # <-- write access to the repo
jobs:
  update-log:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - run: echo "$(date -u '+%Y-%m-%d %H:%M:%S UTC') - auto update" >> activity.log
      - run: git commit -m "chore: log update ..." || echo "Nothing to commit"
      - run: git push
```

This is a documented technique for **aging a throwaway repo into looking legitimately
maintained** before it is used as the landing page for a malicious binary release. None of
these repos contained a binary in the trees I fetched, so this is not an active infection —
but the pattern is why **no repo in §1.1 marked ❌ is cloned, ever**, and why the project
ships with no download-gated installer, no "full version" marketing, and no third-party
binary of any kind. CAUSTIC is a static site that runs from source. There is nothing to
infect a player with.

Per the build brief, all temp downloads are deleted; only vetted CC0 assets are retained.

---

## 2. Positioning & naming

**Name:** `CAUSTIC`
**Repo:** `DrGekoz/CAUSTIC`
**One line:** *Photoreal drag racing. Runs on anything.*
**Pitch:** The most realistic-looking drag racer you can play in a browser tab, tuned to
hold 60fps on a machine that was never meant to render 3D.

**Why this name:** "caustic" is simultaneously a ray-tracing term (the light pattern
produced by focusing a beam through a curved surface) and a real phenomenon you see off a
wet drag strip at night. It names the technical thesis and the visual subject in one word.
It is short, pronounceable, trademark-clean, and does not sound like a template.

**What CAUSTIC is NOT:** it is not an open-world street racer, not a licensed-car game, and
not a Gacha. The whole product is 12 cars, 24 rivals, one strip, and a tuning ladder done
properly. Narrow scope is what makes the graphics budget possible.

---

## 3. Design direction (per `design-sorcerer`)

### 3.1 Mode

**Experience** (immersive). Not Persuade, not Operate, not Read. The player is at a race
event; the UI is instrumentation, not chrome.

### 3.2 Visual thesis

> **A night drag strip under sodium-vapour tower lights, shot on a long lens with a fast
> shutter — the cars look wet, the air is full of haze, and the only cold light in the frame
> is your own instrumentation.**

The thesis is chosen for a mechanical reason, not just an aesthetic one. Every one of the
expensive-look passes in §4 pays off *most* under exactly these conditions:

- **Night + strong emissives** → SSR and bloom have high-contrast sources to work with.
  A grey daytime scene is where real-time reflections look like nothing.
- **Wet asphalt** → screen-space reflection has a mirror to bounce off; this is the single
  highest-impact cheap effect in the entire renderer.
- **Volumetric haze** → light cones are visible, so the raymarch pass earns its cost.
- **Huge contrast range** → ACES tonemapping and a filmic curve do visible work.

### 3.3 Palette

Semantic roles, not decorative hex values. Cold environment, warm light, cyan instrumentation
so the player's own data never competes with the world.

| Role | Token | Hex | Use |
|---|---|---|---|
| Background | `--bg-void` | `#05080a` | Sky, void, page base |
| Surface | `--bg-track` | `#0d1216` | Asphalt, panel grounds |
| Elevated | `--bg-panel` | `#151d23` | Garage/shop surfaces |
| Sodium key | `--light-sodium` | `#ffa53c` | Track lighting, headlights |
| Instrument | `--hud-cyan` | `#4ff0ff` | HUD, active state, data |
| Heat | `--hud-heat` | `#ff4d2e` | Redline, damage, danger, rev limit |
| Cash | `--econ-gold` | `#ffc84a` | Currency, payouts, prices |
| Cred | `--econ-cred` | `#7de0c3` | Secondary currency, skill points |
| Text | `--text-hi` | `#e6f0f3` | Primary text |
| Text muted | `--text-lo` | `#8a9aa2` | Secondary text, units |
| Border | `--line` | `#233039` | Hairlines, dividers |

Contrast: `--text-hi` on `--bg-track` = 13.1:1. `--text-lo` on `--bg-track` = 5.6:1.
`--hud-cyan` on `--bg-void` = 11.4:1. All pass WCAG AA for text at every tier.
Deliberately **no purple, no indigo, no generic SaaS gradient** — the one saturated cool
colour in the game is the player's own HUD, which makes it read as instrumentation.

### 3.4 Typography

Self-hosted WOFF2, no runtime Google Fonts request (a font CDN is a render-blocking
third-party dependency in a 60fps app).

| Role | Family | Weights | Notes |
|---|---|---|---|
| Display / HUD labels | **Rajdhani** | 600, 700 | Condensed technical-instrument face. Chosen because it reads as motorsport telemetry, not as a website. OFL. |
| Numeric / telemetry | **IBM Plex Mono** | 400, 600 | Tabular figures by default — critical so live ET digits don't jitter as they update. OFL. |

Type scale (rem, 1.25 ratio): `0.75 · 0.875 · 1 · 1.25 · 1.5 · 2 · 3 · 4.5`
Numbers always use `--mono` with `font-variant-numeric: tabular-nums` so a running clock
never reflows.

### 3.5 Spacing, radius, motion

- Spacing scale: `4 · 8 · 12 · 16 · 24 · 32 · 48 · 64` px. 8px base, 4px half-step.
- Radius: `2px` (instrument panels, hard/technical) · `6px` (cards) · `999px` (pills only).
  Nothing is pill-shaped except status chips — CAUSTIC's UI is panels and readouts, not pills.
- Motion: **transform and opacity only.** No animated layout, no continuous filter animation.
  Durations: `120ms` state, `220ms` panel, `400ms` screen transition.
- Easings: `cubic-bezier(0.2, 0, 0, 1)` for exits, `cubic-bezier(0.16, 1, 0.3, 1)` for
  entries. No `ease-in-out` on anything a player is waiting on.
- `prefers-reduced-motion` → all non-essential motion drops to 0ms; TAA, bloom, and
  volumetrics stay (they are image, not motion) but grain and aberration switch off.

### 3.6 Do / Don't

**Do:** treat the HUD as an instrument panel (hairline borders, monospaced readouts, units
always visible); make the car the brightest object in frame; keep the player looking
forward down the strip; put all money feedback in one place with a consistent easing.

**Don't:** use glassmorphism over the 3D canvas (it costs a blur and fights the image);
use emoji; use rounded-friendly fonts; put a modal between the player and the rev limiter;
add a "Continue" button to a race that should just restart on R.

### 3.7 Accessibility

- Full keyboard play: no input is mouse-only. `R` restart, `Space` shift, `Esc` pause.
- Gamepad support (standard mapping) as a first-class input path, not a bonus.
- Touch support with a virtual launch pad for mobile.
- Reduced motion honoured. Colour-blind safe: the green launch band and the redline are
  distinguished by *position and shape* (band fill + needle) as well as hue, never hue alone.
- All HUD text ≥ 12px with AA contrast. `aria-live="polite"` on race result readouts.

---

## 4. The render pipeline — "ray-trace level" on integrated graphics

### 4.1 Why these passes

Ray-traced footage is legible as ray-traced because of five specific signatures. Each has a
cheap screen-space or analytic stand-in:

| RT signature | What you'd need real RT for | CAUSTIC's substitute | Cost |
|---|---|---|---|
| Correct specular occlusion | Per-ray visibility in the reflection ray | **GTAO** modulating ambient, and reflection rays (SSR) fading to ambient at range | ~1.4ms |
| Soft, distance-growing shadows | Per-ray shadow cone sampling | **PCSS** blocker search over the CSM depth maps | ~0.9ms |
| Accurate mirror-like reflection | Path-traced bounce | **Screen-space reflection**, roughness-aware, hierarchical | ~1.6ms |
| Participating media | Volumetric path integration | **Half-res raymarch** through exponential fog with light-cone scattering | ~1.1ms |
| Clean, unaliased edges | Infinite samples | **TAA** with a velocity buffer (does more than AA — it *is* the cheap anti-aliasing) | ~0.8ms |

### 4.2 The graph (per frame)

```
[SUN] WebGL2 context, HDR RGBA16F scene target, 0.5×–1.0× dynamic scale
 1. G-BUFFER            MRT×3 + depth24
      RT0 = albedo.rgb, metallic
      RT1 = octahedral normal, roughness
      RT2 = emissive.rgb, materialID
 2. SHADOW              3-cascade CSM, 2048² each (1024² on LOW), PCSS blocker search
 3. GTAO                horizon-search, 2 directions × 4 steps, spatially denoised
 4. LIGHTING (deferred) GGX specular + Lambert diffuse, clearcoat lobe on car paint,
                        IBL from a small procedural sky probe
 5. SSR                 hierarchical, 16→8→4 mips, roughness+edge fade, binary refine ×6
 6. VOLUMETRICS         half-res raymarch 24/12/6 steps, blue-noise dithered, bilateral upsample
 7. TAA                 Catmull-Rom history, velocity-buffer reprojection, neighbourhood clamp
 8. BLOOM               6-level mip chain, Karis-average bright pass (kills fireflies)
 9. COMPOSITE           ACES filmic tonemap → chromatic aberration → vignette → film grain → dither
```

### 4.3 The car material — where the budget actually goes

Car paint is the single most-scrutinised surface in the game, so it gets a dedicated
two-lobe BRDF, not a stock PBR shader:

- **Base coat:** metal-flake dielectric. GGX α = 0.06, plus a procedural 3-octave value
  noise sampled in *world space* at 400× scale for flake sparkle that parallaxes correctly
  as the car moves. This is what sells "ray traced" more than any single effect — a real
  flake layer catching a moving light.
- **Clearcoat:** a second GGX lobe at α = 0.02 over the base, with its own Fresnel. This is
  what produces the sharp *second* highlight down the flank of a car that a single-lobe
  material cannot.
- **Environment:** 32-sample importance-sampled GGX against a procedurally generated
  6-mip radiance probe baked once per lighting scenario (not per frame).

### 4.4 Quality tiers

Auto-detected at boot from a 1-second frame-time probe, then user-overridable. The tier
selects pass *resolution and iteration counts*, never whether the frame is correct.

| Tier | Dynamic res | GTAO | CSM | Volumetric | SSR | TAA | Bloom | Target |
|---|---|---|---|---|---|---|---|---|
| **LOW** (integrated) | 0.55–0.75 | off | 1×1024 | off | off | 2 frames | 3 mips | **60fps** |
| **MEDIUM** | 0.75–1.0 | 1 dir × 3 | 2×1536 | 12 steps, ½-res | 8 mip | on | 4 mips | **60fps** |
| **HIGH** | 1.0 | 2 dir × 4 | 3×2048 | 24 steps, ½-res | 16 mip | on | 5 mips | 60fps |
| **ULTRA** | 1.0 (+ sharpen) | 2 dir × 6 | 3×2048 | 32 steps, ½-res | 16 mip + refine | on | 6 mips | 60fps |

**Dynamic resolution controller:** EMA of GPU frame time, 16ms target, adjusts scale by
±0.05 per frame within the tier's band, hysteresis 8 frames to prevent oscillation.
This is what actually guarantees the "runs on low-end hardware" promise — LOW tier at
0.55 scale is ~1/3 the pixels of HIGH, and the controller finds the floor on any GPU.

---

## 5. Physics & vehicle model

Fixed timestep **240Hz** (4.166ms) with an accumulator, decoupled from render. Max 8
substeps per frame to avoid spiral-of-death; excess time is dropped and the sim is
time-scaled rather than stalled.

### 5.1 State

Per vehicle: position, yaw, velocity (world), yaw rate, roll/pitch (visual only, from load
transfer), engine RPM, 4× wheel `{steer, spin, slipRatio, slipAngle, load, surfaceTemp}`.

### 5.2 Engine torque curve — taken from `AntonC9018/race`

That repo's `concepts/engine_efficiency_equation/` derives a 5th-order polynomial
efficiency/torque curve `f(rpm)` satisfying:

```
f(0) = 0        f(b) = 1  (peak)     f(c) = 0  (redline)
f'(b) = 0                            f''(x) < 0 for x ∈ [0, c]
```

which gives `f''` as a quadratic and, with `b = h·c`:

```
k1 = free
k0 = -(12 + 2·h²·c³·(h²-2h+1)·k1) / (h²·c³·(2h³-3h²+1))
0  = c⁴·k0 + 2c³·k1 + 6c²·k2 + 12c·k3
12 = (hc)⁴·k0 + (hc)³·2k1 + (hc)²·6k2 + 12hc·k3
f(x) = k0·x⁴/12 + k1·x³/6 + k2·x²/2 + k3·x
```

This is a genuinely good model — it is a real engine curve with a real redline, not a
sawtooth. We solve `k0..k3` once per engine at load and evaluate `f` per step. `h` and `c`
become **upgradable car traits** (`h` = torque plateau width, `c` = redline), so a tuned
engine is a *different curve*, not a bigger number.

**Intake restriction** `W·f(rpm)`, and **spark/knock** subtracts a penalty that scales with
boost and falls off over 200ms — so over-revving past the limiter actually costs you.

### 5.3 Tyres

Simplified Pacejka magic-formula per wheel on both axes:

```
Fx = D·sin(C·atan(B·sx − E·(B·sx − atan(B·sx))))     sx = slip ratio
Fy = D·sin(C·atan(B·sy − E·(B·sy − atan(B·sy))))     sy = slip angle
```

Combined slip via the friction ellipse. `D = μ · Fz` — this is where weight transfer
matters, and where the Launch Window pays off.

### 5.4 Weight transfer

Longitudinal transfer from `m·a·h/L` splits load front/rear; lateral from `m·a_y·h/T`
splits it left/right and into the driven axle. More power → more rear squat → more rear
grip but less front → understeer. Traction control, ABS, and transbrake all modulate this.

### 5.5 Drivetrain

Clutch (launch + slip), torque-converter-free, 6-speed with real ratios and final drive,
auto or manual shifting with a torque-cut window. Shifting is a **state machine** taken
from `SkeloGH/dragster` — `idle → revving → staged → shifting → launching → running` — with
every transition having an explicit entry condition and an abort path, so a restart can
never leave the car half-geared.

### 5.6 Aerodynamics

`Cd·A` per car, rear downforce term, and a rolling-resistance term that scales with the
measured surface µ of the strip. Air density is cosmetic; ET is reported at sea-level
standard so numbers are comparable between runs.

---

## 6. Core loop — the Launch Window

This is the game. Everything in §7 is downstream of it.

### 6.1 The three-beat launch

**Beat 1 — STAGE (rev).** Hold throttle. The tacho sweeps; a green band sits at the engine's
torque-plateau centre. Release inside the band → `stagedQuality` ∈ [0,1]. Hold too long and
you hit the limiter and lose heat. This teaches throttle control.

**Beat 2 — SHIFT.** A horizontal bar sweeps. `Space` in the gold zone is a **perfect shift**;
the outer green band is a clean shift; missing it bogs. Output:
`shiftQuality` ∈ [0,1]. This teaches timing, and it's the beat that makes the player hold
their breath.

**Beat 3 — GO.** Auto-launch or trigger. The launch multiplier is applied to rear-tyre µ
and to engine torque for the first 1.8 seconds, then decays.

```
launchQuality = (0.65·stagedQuality + 0.35·shiftQuality)      ∈ [0,1]
tractionMult  = 0.78 + launchQuality · 0.55                  // 0.78 … 1.33
torqueMult    = 0.86 + launchQuality · 0.39                   // 0.86 … 1.25
```

**Why this is a good mechanic:** it makes the meta-game *felt* rather than read. A player
with 40 transmission levels has a physically wider gold zone, so they convert the same skill
into a bigger number. Money buys you a larger target; skill decides whether you hit it. That
is the whole economy in one formula.

### 6.2 The run

1. Rivals screen (3 cars, your line, their line, track length selector)
2. **Launch sequence** (§6.1)
3. Race: 0 → 1/8 mile → 1/4 mile → 1,320 ft (both are scorable, and payout weights them)
4. Brakes/shutdown out: reaction, ET, top speed
5. **Results:** live timing tree, payout counter, credits, "R to run it back"

`Space` restarts instantly with the car in a known state — a race loop that costs 400ms to
retry is a race loop people stop playing.

---

## 7. Meta-game systems

### 7.1 Currencies

| Currency | Earned from | Spent on | Purpose |
|---|---|---|---|
| **Cash** `$` | Race payouts (the only real faucet) | Cars, tuning, junkyard parts | The progression spine |
| **Credits** `C` | First-time rival defeats, milestones, achievements | Skill tree nodes | Gates *knowledge*, not power |
| **Rebuild Tokens** | Prestige | Permanent perks post-reset | The long tail |

Two currencies is the maximum that stays legible. Credits deliberately cannot buy power —
they buy *options*, which stops the second currency from being a shop button.

### 7.2 Race payout — concrete formula

```
marginMult = clamp(1 + (playerET − rivalET) / rivalET · 3.0, 0.35, 2.50)
launchMult = 0.80 + launchQuality · 0.0045                 // 0.80 … 1.25
payout     = rival.basePayout × marginMult × launchMult
credits    = 1 on first defeat of each rival, else 0
```

Worst case (bogged launch, blown it) = 35% of base. Best case (perfect launch, huge margin) =
2.5 × 1.25 = **3.125×** base. That's a 9:1 spread on the same opponent, which means the
Launch Window is worth more than any single upgrade for the first hour of play. Deliberate.

### 7.3 Rival ladder — 24 rivals, 4 bands

| Band | Rivals | Names | Base payout | Gate |
|---|---|---|---|---|
| **STREET** | 1–6 | The Strip, Ninth Street, Greyline, Rust Belt, Backlot, Half-Mile Harry | $800 → $4,000 | Buy the band-1 car |
| **REGIONAL** | 7–12 | Coasts, Hill Country, Riverbend, Ironworks, Saltflat, Long Haul | $5,000 → $22,000 | Any STREET rival + car tier 2 |
| **NATIONAL** | 13–18 | The Committee, Redline, Apex, Torque Co., Dyno Row, Blackout | $30,000 → $140,000 | Any REGIONAL rival + car tier 3 |
| **LEGEND** | 19–24 | Kaido, The Ghost, 10-Second Dan, Absolut, The Auditor, Immortal | $200,000 → $1,200,000 | Any NATIONAL rival + car tier 4 |

Each rival has a named car, a distinct AI launch profile (rev target, shift jitter, reaction
time), and a one-line taunt. Rivals get progressively *better launchers*, not just faster
cars — so a skill ceiling always exists ahead of the money ceiling.

### 7.4 Tuning ladder — 9 categories, INFINITE levels

No `maxLevel`. No `maxEffect`. Cost grows exponentially, effect grows linearly. The cost curve
is the entire gating mechanism, and a reduction category asymptotes so it can never be
degenerate.

| Category | Base cost | Growth | Effect / level | Target stat |
|---|---|---|---|---|
| Engine | $450 | 1.145 | +1.6% peak torque | `peakTorque` |
| Turbo | $1,200 | 1.160 | +1.1% boost pressure | `torqueCurve.h` (plateau) |
| Nitrous | $3,000 | 1.190 | +0.9% (soft-caps at 40) | `nitrousOutput` |
| Tires | $600 | 1.135 | +1.3% grip coefficient | `tireMu` |
| Transmission | $800 | 1.140 | +1.0% shift speed | `shiftWindowMs` |
| Chassis | $1,500 | 1.155 | +1.1% stiffness | `weightTransferRate` |
| Weight | $2,500 | 1.170 | mass `× (1 − 0.4·(1 − 0.985^L))` → asymptote 0.60× | `mass` |
| Cooling | $900 | 1.145 | +1.2% sustained torque | `heatRate` |
| Brakes | $400 | 1.140 | +1.5% brake force | `brakeTorque` |

```
cost(L)   = round(base · growth^L)          // L = current level
effect(L) = 1 + perLevel · L                // linear, never capped
```

**Worked example — Engine at level 40:** `cost = 450 · 1.145^40 = $138,400`.
Cumulative spend across levels 0→40 ≈ `$1.05M`. Effect `= 1.64×` peak torque. That gap
between cost and effect is the *point* — the player is buying a slower and slower margin,
which is exactly what makes the last twenty levels feel like an achievement.

**Weight never breaks:** at level 100 the multiplier is `1 − 0.4·(1 − 0.985^100) = 0.6498`,
approaching but never crossing 0.60. No degenerate infinite-mass-reduction strategy exists.

### 7.5 Skill tree — 30 nodes, bought with Credits

Five branches × 6 nodes. Each changes a *rule*, not a stat.

| Branch | Nodes (abbrev) | Effect class |
|---|---|---|
| **LAUNCH** | Green Band +, Anti-Lag, 2-Step, Transbrake, Rollback, Grace Window | Widens the perfect-shift zone, holds revs, permits a staged burnout |
| **POWER** | Nitrous Duration, Nitrous Recharge, Boost Threshold, Overrun, E85 Blend, Knock Recovery | Nitrous becomes a real resource decision |
| **GRIP** | Setup Width, Tyre Temp, Line Lock, Weight Bias, Tread Depth, Contact Patch | Widens the traction usable before wheelspin |
| **BUSINESS** | Sponsor Deal, Pit Crew, Sponsorship Tier, Media Bonus, Data Purchase, Bookings | **Payout multipliers** — the only power-adjacent branch |
| **REBUILD** | Token Retention, Starting Bonus, Keep 10%, Permanent Grip, Permanent Cash %, 5th Car Slot | Post-prestige power |

Total ~3,600 credits ⇒ roughly 25–35 hours to fully own, which is the intended session
length for a prestige title.

### 7.6 Car roster — 12 cars, 6 tiers

Each car is a distinct *handling character*, not a stat line. All are procedurally generated
(§8.1) from a parameter block, so 12 cars cost 12 data blocks, not 12 modelling sessions.

| Tier | Car | Character |
|---|---|---|
| 1 STREET | **Rusty 8** | Free. Sloppy, low grip, torque everywhere. Teaches the game. |
| 1 STREET | **Hatch** | Forgiving, low power. |
| 2 MUSCLE | **Ranchero** | Big dumb torque, spins up the rears, wheel-lift. |
| 2 MUSCLE | **Ninemiler** | Revvy, needs rev range to keep up. |
| 3 JDM | **Skyline Mk4** | High redline, sharp, unforgiving launch. |
| 3 JDM | **Silvia S15** | Light, drifts the launch, slams gears. |
| 4 EURO | **RS Turbo** | Balanced, huge tuning headroom. |
| 4 EURO | **G Wagon AMG** | Torque monster, traction-limited. |
| 5 EXOTIC | **Vettore** | N/A twin-turbo, brutal, expensive. |
| 5 EXOTIC | **SF-9 Ghib** | AWD, launches off the line unlike anything else. |
| 6 HYPER | **Apex One** | Insane power-to-weight, snap oversteer. |
| 6 HYPER | **Nightlaw** | 1200hp, traction-limited, prestige-tier only |

AWD is a *structural* difference (torque split model), not a multiplier, so the Skyline and
the Vettore feel categorically different in the hands.

### 7.7 Prestige — REBUILD

Reset car, tuning, cars, cash. Keep: skill tree, credits, car unlocks, and 10% of tuning
levels. Award Rebuild Tokens by a log curve on lifetime earnings. Tokens buy permanent
perks (1% permanent cash per token, capped at 50%).

```
tokens = floor(4 · (lifetimeCash / 1e6) ^ 0.55)
```

Each prestige should take ~8–12 hours of first-run time and compress to ~2 hours, which is
the standard incremental pacing target.

---

## 8. Asset strategy — everything generated, nothing shipped

### 8.1 Procedural car construction

Cars are **built in code**, not downloaded. Section-lofting:

1. Author ~14 cross-sections along the car's length (rear bumper → tail → rear arch →
   roof start → roof → windscreen → cowl → front arch → bonnet → nose → splitter). Each
   section is a rounded-rect with per-section `(halfWidth, floorY, roofY, roundness)`.
2. Loft consecutive sections into a triangle mesh, welding the seam, generating **smooth
   vertex normals from area-weighted face accumulation** and explicit tangents.
3. Add separately-transformed parts so the paint can be re-materialised per part:
   greenhouse/glass, splitter, wing, mirrors, exhaust tips, brake discs + calipers,
   headlight and taillight lenses (emissive materials), grille mesh.
4. **Three LODs** generated from the same source: LOD0 full, LOD1 sections halved,
   LOD2 a fused 2-triangle-per-section shell. LOD0 in the garage, LOD1 in the race, LOD2 in
   the mirrors/reflections.
5. Wheels: 24-segment cylinder + parametric spoke extrusion, generated once, instanced ×4
   per car (and ×N for the stands).

Why procedural: zero network cost, zero licensing risk, **and** the geometry density is
tuned per LOD at generation time rather than shipped at 7.7MB and decimated at runtime.
This is the core reason CAUSTIC loads in well under a second.

### 8.2 The one exception — Kenney Car Kit (CC0)

`CagriCatik/RaceTrack` ships Kenney's Car Kit, whose `License.txt` reads:

> License: (Creative Commons Zero, CC0) — http://creativecommons.org/publicdomain/zero/1.0/
> You can use this content for personal, educational, and commercial purposes.

CC0 is public domain, so these are safe to use **with attribution as a courtesy, not an
obligation**. They are used only as **low-tier fallback models** and for the CRT/garage
props. They are the reference silhouette, not the shipping hero asset.

### 8.3 Explicitly excluded

**`TeggTTV/drag-racing` has no LICENSE file.** 31.5MB of its art (car sprites, wheel
sprites, UI sheets, crate/spoiler tilesets, 3 × ~7MB MP3s) is therefore **all rights
reserved by default** and is NOT copied, linked, sampled, traced, or used as a style
reference. We take *architecture and economy ideas* from reading its source — an idea is not
copyable — and zero binary assets. This is recorded in `CREDITS.md` and enforced by a
pre-commit check that fails on any binary blob over 64KB without a matching licence entry.

### 8.4 Audio — 100% procedural

No audio files at all. `Web Audio API`:

- **Engine:** 4 detuned sawtooth oscillators + 1 square for the firing order, frequency
  driven from `rpm`, gain from `load`, through a procedurally-generated impulse-response
  convolution reverb sized to the environment (strip / garage / tunnel). Intake noise from a
  filtered white-noise buffer whose band-pass tracks RPM. Blow-off valve on lift, crackle
  on decel. The engine note *changes with tuning*, because the firing harmonics are driven
  by the real curve.
- **Tires:** filtered noise, band-pass centre frequency from slip ratio, gain from slip
  magnitude. Wheelspin and burnout are the same synth with different parameters.
- **World:** crowd bed (noise + slow LFO), wind (cutoff from speed), starter motor, tree
  (3-partial impulse), Christmas tree sequencing, win-charge riser.
- **Music:** a generative 4-on-the-floor bed at 132 BPM with a sidechain duck on the tree
  sequence, in an original minor-key mode.

Result: **the entire audio layer is a few KB of code**, changes with tuning for free, and
has no licensing surface at all.

---

## 9. Technology decisions

### 9.1 Framework decision

**Chosen: Vite 6 + TypeScript 5 (strict) + a hand-written WebGL2 renderer + plain DOM UI.
No 3D framework. No UI framework. Total runtime dependencies: `gl-matrix` only.**

| Option | Verdict | Why |
|---|---|---|
| **Three.js** | Rejected | A forward renderer with a fixed material system. Getting a real deferred G-buffer means either two renderers or a wall of `onBeforeCompile` overrides that break on every version bump. The render graph *is* this product. |
| **Babylon.js** | Rejected (respectfully) | Genuinely excellent — `DefaultRenderingPipeline` + `SSAO2` ship out of the box. But it's ~1.5MB, its PBR is forward, and its reflections are cubemap probes, not true screen-space. 1.5MB and a forward pipeline cost us the two things that matter most here. |
| **PlayCanvas** | Rejected | Engine-shaped; fights a custom graph, WebGPU-first assumptions. |
| **Raw WebGL2 (chosen)** | **Yes** | Total control of the pass graph, zero abstraction tax, no version-break risk, tiny bundle, and the dynamic-resolution controller can act on real GPU timings. Risk is real and is mitigated by §12. |
| **WebGPU** | **Deferred, not rejected** | Right long-term target and the renderer is already structured for it — the G-buffer contract is backend-agnostic. But it is **not available on the low-end hardware this project targets**, so WebGL2 is the correct floor. §9.2. |

### 9.2 Backend-agnostic design

Every pass communicates through named `RenderTarget` handles and a `Backend` interface with
two implementations. A `WebGL2Backend` ships first; a `WebGPUBackend` is additive, not a
rewrite. On a machine that reports WebGPU, the game can offer an `ULTRA+` tier that swaps
shading to WGSL compute for the GTAO and volumetric passes.

### 9.3 Why plain DOM UI, not React

The UI is 8 panels and a rev limiter. React's reconciliation cost sits directly in the frame
budget of a 16ms renderer, and every React racing game solves this with `useSyncExternalStore`
plus canvas overlays — i.e. React everywhere except where it matters. CAUSTIC instead uses a
~150-line reactive store (`Store.ts`): subscriptions, dependency-tracked selector
re-renders, and **direct DOM writes on the 60fps path** (the rev-limit needle and the ET
digits are `textContent` assignments, never a diff). Zero UI dependencies, zero hydration,
instant boot.

### 9.4 Save data

`localStorage` for the profile, versioned schema with a migration chain. No account, no
backend, no telemetry. Export/import as a base64 string so a player can move a save without a
server. **This is a deliberate design decision, not a limitation** — the game is a single
HTML bundle with no network calls after load, and it will still work in ten years.

---

## 10. File map

```
CAUSTIC/
├── plan.md                    ← this document
├── README.md  CHANGELOG.md  CREDITS.md  LICENSE (MIT)
├── index.html                 ← single entry, no framework
├── vite.config.ts  tsconfig.json  package.json
└── src/
    ├── main.ts                boot: probe tier → load → menu → race
    ├── core/                  Loop · Clock · Input(kbd+pad+touch) · Store · Rng · EventBus
    ├── render/
    │   ├── Renderer.ts        ← the graph orchestrator
    │   ├── GLContext.ts  Targets.ts  Program.ts  Mesh.ts  Geometry.ts  Texture.ts
    │   ├── Backend.ts         (WebGL2Backend · WebGPUBackend)
    │   ├── Camera.ts  Light.ts
    │   └── passes/            GBuffer · Shadow · GTAO · Lighting · SSR · Volumetric · TAA · Bloom · Composite
    │   └── shaders/           GLSL (WebGL2) · WGSL (WebGPU, later)
    ├── geometry/              primitives · loft · car · wheel · track · prop
    ├── physics/               Vehicle · Tire · Engine · Drivetrain · Aero · Suspension
    ├── game/                  RaceSession · LaunchSequence · Timing · Rival · AIDriver
    ├── meta/                  Economy · Tuning · SkillTree · Progression · Save
    │   └── data/              cars · rivals · tuning · skills · track
    ├── audio/                 EngineAudio · Sfx · Music
    └── ui/                    Hud · RevMeter · ShiftBar · Garage · Results · Shop · SkillTree · styles.css
```

---

## 11. Provenance — exactly what came from where

### 11.1 Reused

| From | What | Under what terms |
|---|---|---|
| `AntonC9018/race` | Engine efficiency curve mathematics (reimplemented in TS from the published algebra) | Repo has no license; we're reimplementing the *derivation*, not copying code |
| `SkeloGH/dragster` | Launch/gear state-machine structure (reimplemented) | MIT |
| `DevSwist06/togai` | Track spline format + binary search `atDistance()`, and the project's verification discipline | Repo has no license; reimplemented |
| `CagriCatik/RaceTrack` → Kenney | Car Kit GLB/FBX models, fallback tier only | **CC0 / public domain** |
| `lukaizj/car-mod-saas` | GLB optimisation command set; material-slot mapping idea | Reimplemented; its `.glb` models are **not** reused (no licence) |

### 11.2 Not reused

- `TeggTTV/drag-racing` — **all 31.5MB of art and audio.** No LICENSE = all rights reserved.
- `lukaizj/car-mod-saas` `.glb` models (BMW M4, Tesla Model 3, Audi RS6) — no licence.
- All six shell repos (§1.2) — never cloned.

### 11.3 GLB optimisation commands (for the fallback tier)

Taken from `lukaizj/car-mod-saas/scripts/optimize-model.sh` and
`build-web-model.sh`, the toolchain is `gltf-pipeline` for Draco/quantisation plus a
Blender export pass. Applied to the Kenney set it takes the 7.7MB `assets/car.glb` down to
sub-200KB. Since CAUSTIC's own cars are procedural (§8.1), this is only used for the
fallback tier — but the command set is recorded here so the fallback is actually shippable
rather than aspirational.

### 11.4 Discipline borrowed from `togai`

That repo is small, well-built, and enforces `npm run verify` with zero warnings, full test
coverage, and a pre-commit gate that cannot be bypassed to obtain a pass. CAUSTIC adopts the
*policy* — a renderer where a math error is a black screen demands a real test culture.
`npm run verify` = typecheck + lint + unit tests + headless-WebGL smoke test, and pre-commit
runs it.

---

## 12. Build phases

| Phase | Deliverable | Gate |
|---|---|---|
| **0. Skeleton** | Vite + TS, WebGL2 context, render graph with one pass, tier probe | Clear colour, 60fps, no console errors |
| **1. Physics** | Engine curve, tyre model, drivetrain, launch state machine | Headless sim: 0–60mph in a sane time, no NaN across 10k steps |
| **2. Car gen** | Procedural loft + wheels + LODs, emissive lights | 12 cars render, all LODs, normals verified |
| **3. Track + scene** | Strip geometry, towers, barriers, stands, props | Racing line traversable, 60fps at HIGH |
| **4. Render quality** | GTAO, CSM+PCSS, SSR, volumetrics, TAA, bloom, ACES | Screenshot gate vs. reference; LOW tier holds 60fps |
| **5. Race loop** | Session, timing, results, restart, Rival AI | Full run start→finish→restart under 400ms |
| **6. Meta** | Economy, tuning ladder, 12 cars, skill tree, save/load | Economy sim: 60h playtime curve |
| **7. UI** | All panels, HUD, garage, shop, settings | Design Sorcerer review (§3) passes |
| **8. Audio** | Procedural engine + tires + world + music | 12 cars × audible tuning difference |
| **9. Polish** | Progression pacing, onboarding, mobile touch, a11y | Low-end machine test at 320px and 1600×900 |
| **10. Ship** | README, CHANGELOG, CREDITS, release | Public repo, MIT |

**Phase 4 is the risk.** It's where "ray-trace level on integrated graphics" either works
or doesn't. It is therefore first in the risk register, and phases 0–3 are all
architecturally independent of it so a failure there doesn't sink the project.

---

## 13. Risk register

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| Deferred pipeline too slow on integrated GPUs | **High** | **Critical** | LOW tier disables GTAO/SSR/volumetrics entirely and drops to 0.55 res. Dynamic-resolution controller. This is *why* LOW exists. |
| Custom renderer bugs cause black screens | Medium | High | Every pass is individually testable headlessly; `verify` includes a pixel-hash smoke test per pass. |
| Procedural cars look like blobs | Medium | High | LOD0 is inspectable in the garage with a wireframe/UV debug view; iterate against a reference silhouette before wiring the race camera. |
| Infinite tuning ladder inflates numbers | Medium | Medium | Exponent cost + linear effect is already asymptotic by design; verify with the §7.4 economy sim over simulated 100h. |
| Scope: 12 cars + 24 rivals is a lot | Medium | Medium | Cars are data blocks over one generator, so a car is ~40 lines, not a modelling session. Rivals are ~20 lines. |
| Low-end WebGL2 driver bugs | Low | High | Capability probe, not feature sniffing; graceful tier downgrade on black frame. |
| Audio sounds cheap | Medium | Low | Fully procedural means the engine *is* the model — it improves for free with §7.4. |

---

## 14. Verification plan

No claim ships without tool output behind it.

1. **Typecheck** — `tsc --noEmit`, strict, zero errors.
2. **Unit tests** — engine curve coefficients, tyre slip, cost/payout formulas, save
   migration. ≥90% on `physics/`, `meta/`, `game/`.
3. **Headless WebGL smoke** — every pass renders to a target; assert a non-black, non-NaN
   pixel hash. This is what catches a shader that silently fails to link.
4. **Frame-time probe** — real timing across LOW/MEDIUM/HIGH on this machine, reported in
   the README, not guessed.
5. **Real browser** — CDP-driven Chrome at 320px, 390px, 1280px, 1920px. Console must be
   clean. Every panel opens, scrolls, and closes.
6. **Audio** — render the engine at 3 tuning levels, confirm the spectrogram actually moves.
7. **Reduced motion** — verify CAUSTIC honours it.
8. **No-network check** — after first load, zero network requests.

---

## 15. Scope explicitly excluded

Deliberately not in v1, listed so it's a decision and not an omission: open world, licensed
real cars, multiplayer, gacha/crates, mobile native builds, a backend or accounts,
photo-real human drivers, and any third-party paid service. Free, local, source-only.

---

## 16. Licence

**MIT.** All original code. Third-party assets limited to CC0 Kenney Car Kit with
attribution in `CREDITS.md`. No paid API, token, or component tier anywhere in the stack.
