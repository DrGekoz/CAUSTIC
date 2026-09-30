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

### BMW M4 Competition M Package — **CC BY 4.0, reusable with attribution**
- **Author:** 𝙎𝙍𝙏 𝙋𝙚𝙧𝙛𝙾𝙼𝙞𝙣𝙚™ — https://sketchfab.com/TheRealSRT
- **Source:** https://sketchfab.com/3d-models/bmw-m4-competition-m-package-5c0a2dafb1ad408d9fc9eeef9aee531b
- **Licence:** Creative Commons Attribution 4.0 International (CC BY 4.0) — http://creativecommons.org/licenses/by/4.0/
- **Obtained via:** `lukaizj/car-mod-saas/public/models/`, which preserves the author's
  attribution in the GLB's embedded `asset.extras` block.
- **Changes made by the source repo, preserved here:** Meshopt geometry compression, WebP
  texture compression, textures limited to 1024px, geometry simplification disabled.
  The `.web.glb` runtime variant additionally removes four cabin/engine meshes hidden in a
  closed car, removes three textures replaced by runtime materials, and limits remaining
  textures to 512px.
- **Our changes (to be recorded at adoption):** none yet. If CAUSTIC modifies the mesh,
  textures or material assignment, the change is noted here per the CC BY 4.0 attribution
  requirement.
- **Use in CAUSTIC:** optional low-tier fallback car model. The shipping cars are
  procedurally generated.

**Project licence floor: any third-party 3D model in this repository must be CC0 or CC BY.**
A pre-commit hook rejects binary blobs over 64KB that lack a matching entry above.

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
- **`lukaizj/car-mod-saas` Audi RS6** — the repo's own attribution declares it *"editorial,
  non-commercial license… must not be used commercially or redistributed until the asset
  owner and license are confirmed."* Excluded.
- **`lukaizj/car-mod-saas` Tesla Model 3** — attribution states *"verify the upstream model
  license and replace the asset if required."* Unverified. Excluded.
  (The BMW M4 from the same source is CC BY 4.0 and **is** used — see above.)
- **Six shell repositories** — `niceguy704/Top-Speed-Drag-Fast-Racing-Full-Version`,
  `elisha-39/Ultra-Drag-Racing-Full-Version`, `everalon-20/Ultra-Drag-Racing`,
  `bait-3071taxied/CLUTCH-Early-Prototype-2026`, `updraft63-enemata/STUNTBOOST-PC`,
  `capacityknights88/Lead-The-Dragon-Devlog-2026`. These contain **zero game code** and use
  scheduled GitHub Actions workflows to inflate their commit history so they appear actively
  maintained. They were identified as bait for "free full-version game download" pages and
  were **never cloned**. See `plan.md` §1.2.
