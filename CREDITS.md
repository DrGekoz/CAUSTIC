# Credits & Licensing

CAUSTIC is MIT licensed. All code in this repository is original.

## Third-party assets

### Kenney Car Kit
- **Source:** `CagriCatik/RaceTrack` → `assets/kenney_car-kit/`
- **Upstream:** https://kenney.nl/assets/car-kit
- **Licence:** Creative Commons Zero (CC0) — http://creativecommons.org/publicdomain/zero/1.0/
- **Licence text as shipped:**
  > License: (Creative Commons Zero, CC0)
  > You can use this content for personal, educational, and commercial purposes.
  > Support by crediting 'Kenney' or 'www.kenney.nl' (this is not a requirement)
- **Use in CAUSTIC:** low-tier fallback car models and garage/CRT props only. The shipping
  hero cars are procedurally generated (§8.1 of `plan.md`).
- Attribution is a courtesy here, not a requirement. Given anyway.

### Fonts (downloaded at build time, not committed)
- **Rajdhani** — SIL Open Font License 1.1
- **IBM Plex Mono** — SIL Open Font License 1.1

## Runtime dependencies

| Package | Licence | Use |
|---|---|---|
| `gl-matrix` | MIT | Matrix/vector math |
| Vite, TypeScript, ESLint, Vitest | MIT / Apache-2.0 | Build and dev tooling only |

No paid API, no token, no paid component tier, no telemetry.

## Inspiration & reimplemented techniques

Where a referenced project had **no licence file**, its code was not copied. Only published
mathematics and general technique were reimplemented from scratch in TypeScript. Where a
project *was* MIT, its structure was studied and rewritten.

| Reference | What was taken | Status |
|---|---|---|
| `AntonC9018/race` | Engine efficiency-curve derivation (5th-order polynomial satisfying f(0)=0, f(b)=1, f(c)=0, f'(b)=0, f''(x)<0). Reimplemented from the published algebra in `plan.md` §5.2. | No licence file. Mathematics reimplemented, no code copied. |
| `SkeloGH/dragster` | Launch/gear state-machine shape. | **MIT.** Structure reimplemented, no code copied. |
| `DevSwist06/togai` | Track spline format, binary-search `atDistance()`, and the `npm run verify` quality-gate policy. | No licence file. Technique reimplemented. |
| `lukaizj/car-mod-saas` | GLB optimisation command set; material-slot mapping concept. | No licence file. Its `.glb` car models are **not** used. |

## Assets explicitly NOT used

- **`TeggTTV/drag-racing` — all 31.5 MB of art and audio.** This repository has **no LICENSE
  file**, so its assets are all rights reserved by default. Nothing from it (car sprites, wheel
  sprites, UI sheets, crate/spoiler tilesets, seasonal trees, MP3s) is copied, vendored,
  sampled, traced, or used as a style reference. Only *ideas* about economy structure were
  taken from reading its source; ideas are not copyrightable, binary assets are.
- **`lukaizj/car-mod-saas` `.glb` models** (BMW M4, Tesla Model 3, Audi RS6) — no licence.
- **Six shell repositories** — `niceguy704/Top-Speed-Drag-Fast-Racing-Full-Version`,
  `elisha-39/Ultra-Drag-Racing-Full-Version`, `everalon-20/Ultra-Drag-Racing`,
  `bait-3071taxied/CLUTCH-Early-Prototype-2026`, `updraft63-enemata/STUNTBOOST-PC`,
  `capacityknights88/Lead-The-Dragon-Devlog-2026`. These contain **zero game code** and use
  scheduled GitHub Actions workflows to inflate their commit history so they appear actively
  maintained. They were identified as bait for "free full-version game download" pages and
  were **never cloned**. See `plan.md` §1.2.
