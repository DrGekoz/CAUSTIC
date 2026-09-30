<div align="center">

# CAUSTIC

**Photoreal drag racing. Runs on anything.**

A browser-native 1/8-mile drag racer on a hand-written WebGL2 deferred renderer.
No 3D framework. No backend. No accounts. One runtime dependency.

[![status](https://img.shields.io/badge/status-in%20development-amber)](https://github.com/DrGekoz/CAUSTIC)
[![tests](https://img.shields.io/badge/tests-95%20passing-brightgreen)](https://github.com/DrGekoz/CAUSTIC/actions)
[![license](https://img.shields.io/badge/license-MIT-blue)](./LICENSE)

</div>

```bash
npm install
npm run dev
```

---

## The pitch

Drag racing is won or lost in the first 1.8 seconds. **The Launch Window** is the
whole game: hold the car on the clutch, build revs into a green band on the tacho,
and dump it. A perfect launch pays **3.125×** the stake. A bog pays **0.28×**.

That is roughly 11:1 on the *same opponent* — which means launch skill beats
purchased power for the whole first hour, and a $0 car with a good launch beats
a $70,000 car with a bad one.

## What is built

| | |
|---|---|
| **Physics** | Pacejka tyres, weight transfer, aero, coupled engine/clutch/gearbox/wheel drivetrain at a fixed 240 Hz. 0-60 in 6.9s, quarter mile in 14.7s, both simulated. |
| **Renderer** | Hand-written WebGL2 deferred: G-buffer ×3, GTAO, GGX + clearcoat, SSR, half-res volumetrics, TAA, Karis-averaged bloom, ACES. Four quality tiers. |
| **Cars** | 12 procedural cars, 2,324 triangles each, 0.39 MB for the whole roster. Loomed in code from 17 cross-sections. |
| **Game** | Launch window, 34-node mutually exclusive tuning tree, 12-rival authored ladder, cash/XP/level/resale economy. |

**95 tests, all green.** The render tests run headless Chrome against a real GL
context and scrape the console for `INVALID_`/feedback-loop/compile failures —
because a dropped draw is silent, and a car with no wheels passes every
assertion you don't write by hand.

## What is not built yet

Being straight about this: **the game is not playable.** There is no race loop, no
input handling, no garage/shop UI, no save system and no audio. What exists is the
engine (physics + renderer + economy) and a scene that renders correctly with a
demo autopilot driving it. See [`plan.md`](./plan.md) for the full build phases.

## Why it looks the way it does

Ray-traced footage reads as ray-traced because of five specific visual signatures.
Each gets a cheap stand-in:

| RT signature | CAUSTIC's substitute |
|---|---|
| Correct specular occlusion | GTAO modulating ambient |
| Soft distance-growing shadows | Contact-hardening shadow filter |
| True mirror reflections | Roughness-aware screen-space reflection |
| Participating media | Half-res raymarch through exponential fog |
| Clean unaliased edges | TAA with a neighbourhood clamp |

CAUSTIC does **not** do hardware ray tracing and does not claim to. WebGPU RT is
not available on the hardware this targets. What it implements are the
*signatures*, at a fraction of the cost, scaling down to a 0.55-resolution LOW
tier that still holds 60fps.

## The tuning tree is a tree, not a ladder

Parts are **mutually exclusive**. A turbo kit permanently closes off the
naturally-aspirated path. The exhaust is a three-way exclusive; gearing is a
six-way exclusive. You are buying a coherent engineering philosophy, not watching
an opaque stat number tick up.

```
turbo_kit ─┬─ big_intercooler
           └─ (closes na_cams, supercharger)
catback ───┼── exhaust ──┼── straight_pipe     (three-way exclusive)
three_speed ┼── tall_gearbox ┼── diff_ratio     (six-way exclusive)
```

Parts sell back at half price, so a wrong branch genuinely costs you. There is no
gacha, no crates, no wheel — one faucet for power, one for options.

## The rivals are authored, not scaled

A fixed 12-car ladder in 4 bands, from a rusty straight-eight to the Nightlaw.
Deliberately **not** keyed to player level: scaling rival difficulty off the
player punishes investment and turns progression into a treadmill.

## Everything is generated

No art files ship. Cars are lofted in code from 17 cross-sections with
area-weighted smooth normals and three generated LODs. The environment probe is
generated at boot. The only third-party assets are Kenney's Car Kit (CC0) and a
BMW M4 (CC BY 4.0), reserved for low-tier fallbacks.

Licence floor: any third-party 3D model must be **CC0 or CC BY**.

## Stack

Vite 6 · TypeScript 5 strict · hand-written WebGL2 · `gl-matrix` · plain DOM.
One runtime dependency. MIT licensed.

---

<div align="center">

[`plan.md`](./plan.md) — full design, economy, render graph, build phases
[`CREDITS.md`](./CREDITS.md) — provenance and licensing
[`CHANGELOG.md`](./CHANGELOG.md) — what changed in each version

</div>
