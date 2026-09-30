# CAUSTIC

**Photoreal drag racing. Runs on anything.**

A browser-native 1/8-mile drag racer built on a hand-written WebGL2 deferred renderer —
cascaded shadow maps with PCSS, GTAO, screen-space reflections, raymarched volumetrics, TAA
and ACES. No 3D framework, no backend, no accounts, ~1MB total.

```bash
npm install
npm run dev
```

---

## What it is

One signature mechanic: **the Launch Window**. Every race is decided in the first 1.8
seconds. Stage the engine into the green rev band, hit the perfect-shift gold zone, and the
launch quality becomes a physical multiplier on rear-tyre grip and engine torque. A good car
with a bad launch loses to a cheap car with a good launch.

Around it: a **branch-tree** tuning system (~34 mutually-exclusive parts across 6 branches,
so buying turbo permanently closes off the naturally-aspirated path), 6 item **sets** that
reward coherent builds, 12 procedurally generated cars across 6 tiers, a fixed 24-rival
career ladder in 4 bands, a 30-node skill tree, and prestige. One faucet for power (race
payouts) and one for options (credits) — deliberately no crates, wheels or dailies.

## Why it looks like this

Ray-traced footage reads as ray-traced because of five specific visual signatures. Each has
a cheap analytic or screen-space stand-in that costs a fraction as much:

| RT signature | CAUSTIC's substitute |
|---|---|
| Correct specular occlusion | GTAO modulating ambient + reflection fade |
| Soft distance-growing shadows | PCSS blocker search over cascaded shadow maps |
| True mirror reflections | Hierarchical roughness-aware screen-space reflection |
| Participating media | Half-res raymarch through exponential fog, blue-noise dithered |
| Clean unaliased edges | TAA with a velocity buffer |

CAUSTIC does **not** do hardware ray tracing and does not claim to. WebGPU RT isn't available
on the hardware this targets. What it implements are the *signatures* — at 20–100× lower cost,
scaling down to nothing on a 0.55-resolution LOW tier.

## Rendering

```
G-BUFFER (MRT×3 + depth24)  →  CSM shadow (3 cascades, PCSS)  →  GTAO
  →  deferred GGX + clearcoat  →  SSR  →  half-res volumetrics
  →  TAA  →  mip-chain bloom  →  ACES composite
```

Four quality tiers, auto-selected by a frame-time probe at boot, each controlling pass
resolution and iteration counts. A dynamic-resolution controller holds the frame budget
against real GPU timing.

The car paint is a two-lobe BRDF: a metal-flake base coat with world-space procedural flake
that parallaxes correctly, plus a separate clearcoat lobe for the sharp second highlight.

## Everything is generated

No art files ship. Cars are lofted in code from ~14 cross-sections with area-weighted smooth
normals and three generated LODs. Engine audio is four detuned oscillators driven by the
actual torque curve, through a procedurally-generated convolution reverb — it changes as you
tune, because the harmonics come from the model. The whole audio layer is a few KB of
code.

The only third-party assets are Kenney's Car Kit (CC0) and a BMW M4 (CC BY 4.0), used for
low-tier fallback models. Licence floor: any third-party 3D model must be CC0 or CC BY.

## Controls

`W`/`↑` throttle · `A D`/`←→` steer · `S`/`↓` brake · `Space` shift ·
`R` restart · `Esc` pause. Gamepad (standard mapping) and touch are first-class.

## Stack

Vite 6 · TypeScript 5 strict · hand-written WebGL2 · `gl-matrix` · plain DOM UI.
One runtime dependency. MIT licensed.

See [`plan.md`](./plan.md) for the full design, economy, render graph and build phases.
See [`CREDITS.md`](./CREDITS.md) for provenance and licensing.

## Status

Pre-production. Design locked in [`plan.md`](./plan.md); build phases 0–10 not yet started.
