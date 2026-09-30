/**
 * App bootstrap and the test harness.
 *
 * The renderer is verified against a real GL context in tests/render.test.ts,
 * which loads this module in headless Chrome and reads window.__CAUSTIC_TEST__.
 */

import { mat4, mat3 } from 'gl-matrix';
import { Renderer, DEFAULT_FRAME, type DrawItem, type QualityTier } from './render/Renderer';
import { NIGHT_GRADE } from './world/NightGrade';
import { GPUMesh } from './render/GL';
import { buildCar, type CarMesh, type CarSpec } from './geometry/Car';
import { buildStrip, buildLights, uploadStrip, buildLampBar, LANE_CENTRE } from './world/Strip';
import { Race, type RaceInput } from './game/Race';
import { CAR_BY_ID } from './game/data/cars';
import type { BranchId } from './game/Economy';
import { InputManager, TouchControls } from './ui/Input';
import { LaunchHud } from './ui/LaunchHud';
import { GarageUI } from './ui/Garage';
import { save as saveGame, load as loadGame } from './game/Save';
import {
  newPlayer, applyRace, resolveRace, RIVALS, type PlayerState,
} from './game/Economy';

declare global {
  interface Window {
    __CAUSTIC_TEST__?: {
      ready: boolean;
      error?: string;
      frames: number;
      tier: string;
      scale: number;
      drawCalls: number;
    };
  }
}

const FIXED_DT = 1 / 240;

class App {
  renderer!: Renderer;
  /**
   * The Race owns both vehicles and their clocks. The app drives it and reads
   * back a snapshot; it never steps a vehicle itself.
   */
  race: Race | null = null;
  /** Convenience handles onto the two lanes, for rendering. */
  vehicles: import('./physics/Vehicle').Vehicle[] = [];
  input = new InputManager();
  touch: TouchControls | null = null;
  hud: LaunchHud | null = null;
  /** True once the player has actually driven; before that the autopilot runs. */
  humanDriving = false;
  /** Tuning fitted, by car id. */
  tuning = new Map<string, BranchId[]>();
  activeCarId = 'rusty8';
  rivalCarId = 'hatch';
  /** Index into RIVAL_DRIVES. */
  rivalSkill = 0;
  /** Launch rpm the autopilot stages to. */
  demoLaunchRpm = 3900;
  /** Display name of the current rival, for the result panel. */
  rivalName = 'RIVAL';
  /** Persistent progression: cash, garage, tuning, XP. */
  player: PlayerState = newPlayer();
  garage: GarageUI | null = null;
  /** True once the current race has been paid out, so it pays exactly once. */
  private raceSettled = false;
  /** Seeds the rival's ET variation; incremented once per settled race. */
  private raceSettleCount = 0;
  built: CarMesh[] = [];
  specs: CarSpec[] = [];
  gpu: Record<string, GPUMesh> = {};
  carMeshes: GPUMesh[] = [];
  /** Integrated wheel rotation per wheel, radians. */
  wheelSpin: Float32Array | null = null;
  wheelMesh: GPUMesh | null = null;
  wheelOffsets: Array<Array<[number, number, number]>> = [];
  wheelMats: Float32Array[] = [];
  wheelNorms: Float32Array[] = [];
  lampMesh: GPUMesh | null = null;
  lampMats: Float32Array[] = [];
  lampNorms: Float32Array[] = [];
  modelMats: Float32Array[] = [];
  normalMats: Float32Array[] = [];
  /**
   * A test hook: when window.__CAUSTIC_READBACK__ is set, sample the live
   * back buffer at the end of a frame and stash the statistics. Reading after
   * the frame is composited would return black, because the context is created
   * without preserveDrawingBuffer to keep the shipping path fast.
   */
  private serviceReadback(): void {
    const w = window as unknown as Record<string, unknown>;
    if (!w.__CAUSTIC_READBACK__) return;
    w.__CAUSTIC_READBACK__ = false;
    const gl = this.renderer.ctx.gl;
    const width = this.renderer.ctx.width;
    const height = this.renderer.ctx.height;
    const px = new Uint8Array(width * height * 4);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.readPixels(0, 0, width, height, gl.RGBA, gl.UNSIGNED_BYTE, px);
    let min = 255;
    let max = 0;
    let sum = 0;
    const n = width * height;
    const buckets = new Set<number>();
    for (let i = 0; i < n; i++) {
      const l = (px[i * 4] * 0.299 + px[i * 4 + 1] * 0.587 + px[i * 4 + 2] * 0.114) | 0;
      if (l < min) min = l;
      if (l > max) max = l;
      sum += l;
      if (buckets.size < 8192) buckets.add(l >> 3);
    }
    w.__CAUSTIC_STATS__ = { width, height, min, max, mean: sum / n, distinct: buckets.size };
  }

  private accumulator = 0;
  private lastNow = 0;
  items: DrawItem[] = [];
  /** Seconds since boot, used by the demo autopilot. */
  raceTime = 0;
  frameCount = 0;

  init(canvas: HTMLCanvasElement): void {
    this.renderer = new Renderer(canvas);
    this.renderer.lights = buildLights();
    this.renderer.frame = { ...DEFAULT_FRAME, ...NIGHT_GRADE };

    const gl = this.renderer.ctx.gl;
    this.gpu = uploadStrip(gl, buildStrip());

    // Two cars in two lanes: the player in the right lane, the rival left.
    // The Race OWNS both vehicles and their timing, so the app never steps a
    // vehicle itself -- that would advance the physics without the race clock
    // and the ET would disagree with what is on screen.
    const player = CAR_BY_ID[this.activeCarId];
    const rival = CAR_BY_ID[this.rivalCarId];
    this.race = new Race(
      player,
      new Set(this.tuning.get(player.id) ?? []),
      rival,
      new Set<BranchId>(),
      this.rivalSkill,
    );
    this.race.begin();
    this.vehicles = [this.race.player.vehicle, this.race.rival.vehicle];
    this.rivalName = RIVALS[this.rivalSkill]?.name ?? 'RIVAL';

    for (const [i, spec] of [player, rival].entries()) {
      const built = buildCar(spec);
      this.built.push(built);
      this.specs.push(spec);
      this.gpu[`car${i}`] = new GPUMesh(gl, built.body.positions, built.body.normals, built.body.uvs, built.body.indices);
      this.carMeshes.push(this.gpu[`car${i}`]);
      if (!this.lampMesh) {
        const bar = buildLampBar(spec.width * 0.32, 0.09);
        this.lampMesh = new GPUMesh(gl, bar.positions, bar.normals, bar.uvs, bar.indices);
      }
      // The wheel mesh was generated all along but never uploaded, so no
      // capture has ever shown a wheel -- which is most of why the cars read
      // as unrecognisable blobs.
      if (!this.wheelMesh) {
        this.wheelMesh = new GPUMesh(
          gl, built.wheel.positions, built.wheel.normals, built.wheel.uvs, built.wheel.indices,
        );
      }
      this.wheelOffsets.push(built.wheelOffsets.map((o) => [o[0], o[1], o[2]] as [number, number, number]));
      this.modelMats.push(new Float32Array(16));
      this.normalMats.push(new Float32Array(9));
      this.lampMats.push(new Float32Array(16));
      this.lampNorms.push(new Float32Array(9));
      for (let w = 0; w < 4; w++) {
        this.wheelMats.push(new Float32Array(16));
        this.wheelNorms.push(new Float32Array(9));
      }
    }
  }

  /**
   * Advance the fixed-step simulation.
   *
   * The Race owns the vehicles and their clocks, so the app only feeds it
   * input. Stepping a vehicle directly would advance the physics without the
   * race clock, and the ET would disagree with what is on screen.
   */
  update(dtReal: number): void {
    if (!this.race) return;
    this.accumulator += Math.min(dtReal, 0.25);
    let steps = 0;
    const raceInput = this.sampleInput();
    while (this.accumulator >= FIXED_DT && steps < 12) {
      this.race.step(FIXED_DT, raceInput);
      this.accumulator -= FIXED_DT;
      steps++;
    }
    if (steps >= 12) this.accumulator = 0;
    this.input.endFrame();
  }

  /**
   * Player input, or the demo autopilot when nobody is driving. The autopilot
   * stages to a chosen rpm, dumps the clutch and shifts at the redline, which
   * is exactly what a player does -- so it exercises the whole drivetrain.
   */
  private sampleInput(): RaceInput {
    const kbd = this.input.sample(FIXED_DT);
    if (this.touch && this.touch.visible) {
      const t = this.touch.sample();
      kbd.throttle = Math.max(kbd.throttle, t.throttle);
      kbd.brake = Math.max(kbd.brake, t.brake);
      kbd.clutch = kbd.clutch && t.clutch;
      kbd.launch = kbd.launch || t.launch;
    }
    if (this.humanDriving) return kbd;

    const race = this.race;
    if (!race) return kbd;
    const v = race.player.vehicle;
    if (race.phase === 'STAGING') {
      const err = this.demoLaunchRpm - v.rpm;
      return {
        ...kbd,
        throttle: err > 0 ? Math.min(1, err / 600) : 0,
        clutch: true,
        launch: race.stageTime > 0.9,
      };
    }
    return {
      ...kbd,
      throttle: 1,
      shiftUp: v.rpm > v.cfg.curve.redline * 0.96 && v.shiftReady,
    };
  }

  /**
   * A simple autopilot so the scene is alive without input. It stages on the
   * clutch to a launch rpm, dumps it, and then shifts at the redline -- which is
   * exactly what a player does, and it exercises every part of the drivetrain.
   */

  buildDrawList(dtReal: number): void {
    const items = this.items;
    items.length = 0;

    const push = (
      mesh: GPUMesh,
      m: Float32Array,
      nm: Float32Array,
      material: number,
      baseColor: [number, number, number],
      metallic: number,
      roughness: number,
      emissive: [number, number, number] = [0, 0, 0],
      clearcoat = 0,
      paintFlake = 0,
      slip = 0,
    ) => {
      items.push({
        mesh, model: m, normalMatrix: nm, material, baseColor,
        metallic, roughness, emissive, clearcoat, paintFlake, slip,
        castShadow: true,
      });
    };

    const idm = identity16();
    const idn = identity9();

    // Track.
    push(this.gpu.ground, idm, idn, 4, [0.055, 0.055, 0.06], 0.0, 0.16);
    push(this.gpu.lanes, idm, idn, 4, [0.62, 0.62, 0.6], 0.0, 0.35);
    push(this.gpu.stagingBeam, idm, idn, 4, [0.85, 0.84, 0.8], 0.0, 0.4);
    push(this.gpu.walls, idm, idn, 0, [0.1, 0.1, 0.11], 0.0, 0.7);
    push(this.gpu.lightTowers, idm, idn, 5, [0.22, 0.23, 0.25], 0.9, 0.42);
    push(this.gpu.startFloods, idm, idn, 5, [0.3, 0.3, 0.32], 0.85, 0.38);
    push(this.gpu.trees, idm, idn, 5, [0.12, 0.12, 0.13], 0.8, 0.35);
    push(this.gpu.stands, idm, idn, 0, [0.14, 0.14, 0.16], 0.0, 0.8);
    push(this.gpu.barriers, idm, idn, 5, [0.3, 0.31, 0.33], 0.85, 0.4);

    // Cars. Paint is material 1: metal flake plus clearcoat.
    for (let i = 0; i < this.vehicles.length; i++) {
      const v = this.vehicles[i];
      const spec = this.specs[i];
      const lane = i === 0 ? LANE_CENTRE : -LANE_CENTRE;
      const z = v.distance;
      const yaw = 0;
      const m = this.modelMats[i];
      const nm = this.normalMats[i];

      mat4.identity(m);
      mat4.translate(m, m, [lane, 0, z]);
      mat4.rotateY(m, m, yaw);
      // Suspension squat and dive from the longitudinal acceleration.
      mat4.rotateX(m, m, Math.max(-0.05, Math.min(0.05, -v.tcCut * 0.02 + v.pitch * 0.9)));
      mat3.normalFromMat4(nm as unknown as mat3, m as unknown as mat4);

      const wheelSpin = v.clutchSlip;
      push(
        this.carMeshes[i], m, nm, 1,
        i === 0 ? [0.72, 0.06, 0.04] : [0.05, 0.16, 0.4],
        0.35, 0.28,
        [0, 0, 0],
        1.0,
        0.55,
        Math.min(1, Math.abs(wheelSpin) * 0.5),
      );

      // Wheels. The car body is parented by a single model matrix; each wheel
      // needs its own, because it also carries a steer angle on the front axle
      // and a spin angle on all four. Without these the cars read as floating
      // slabs.
      if (this.wheelMesh) {
        const offsets = this.wheelOffsets[i];
        // No steering in a drag race: the car tracks the lane centre. The
      // small yaw term comes from the vehicle's lateral dynamics, not input.
      const steer = Math.max(-0.08, Math.min(0.08, v.lateralSpeed * 0.05));
        for (let w = 0; w < 4; w++) {
          const off = offsets[w];
          if (!off) continue;
          const isFront = w < 2;
          // Accumulate real wheel rotation from the simulated angular velocity,
          // so a spinning wheel is visibly spinning.
          if (!this.wheelSpin) this.wheelSpin = new Float32Array(this.wheelMats.length);
          const slot = i * 4 + w;
          const ws = v.wheels?.[w];
          if (ws) this.wheelSpin[slot] += ws.omega * dtReal;
          const wm = this.wheelMats[i * 4 + w];
          const wn = this.wheelNorms[i * 4 + w];
          mat4.identity(wm);
          // wheelOffsets are in car-local space: x = side, y = height, z = along.
          const lx = off[0];
          const lz = off[2];
          const c = Math.cos(yaw);
          const sn = Math.sin(yaw);
          const wx = lane + (lx * c + lz * sn);
          const wz = z + (-lx * sn + lz * c);
          mat4.translate(wm, wm, [wx, off[1], wz]);
          mat4.rotateY(wm, wm, yaw);
          if (isFront) mat4.rotateY(wm, wm, steer);
          // Spin about the wheel's own axle, which is local X after the yaw.
          mat4.rotateX(wm, wm, this.wheelSpin[slot] ?? 0);
          mat3.normalFromMat4(wn as unknown as mat3, wm as unknown as mat4);
          // Rubber: dark, low clearcoat, and the slip term makes it sheen and
          // warm under wheelspin.
          // Slip and heat come straight from the tyre model, so the rubber
          // sheen and the smoke threshold track the simulation.
          const slipRatio = Math.min(1, Math.abs(ws?.slipRatio ?? 0) * 0.5);
          push(this.wheelMesh, wm, wn, 6, [0.045, 0.045, 0.05], 0.0, 0.72,
            [0, 0, 0], 0, 0, slipRatio);
        }
      }

      // Brake-light bar on the rear face. Emissive but restrained: the G-buffer
      // boosts lens edges by 1.55x, so the base value has to stay low or the
      // bloom turns the whole rear of the car into a white blob.
      const lm = this.lampMats[i];
      const ln = this.lampNorms[i];
      const lampY = 0.62;
      const lampZ = z - spec.length * 0.5 - 0.02;
      mat4.identity(lm);
      mat4.translate(lm, lm, [lane, lampY, lampZ]);
      mat4.rotateY(lm, lm, yaw);
      mat3.normalFromMat4(ln as unknown as mat3, lm as unknown as mat4);
      if (this.lampMesh) {
        const braking = v.brakeInput > 0.05 ? 1 : 0.12;
        push(
          this.lampMesh, lm, ln, 3,
          [0.35, 0.02, 0.02], 0.0, 0.3,
          [braking * 1.6, braking * 0.06, braking * 0.04],
          0, 0, 0,
        );
      }
    }
  }

  /** Put both cars back on the line for another run. */
  restart(): void {
    this.race?.begin();
    this.raceTime = 0;
    this.raceSettled = false;
  }

  toggleGarage(): void {
    if (!this.garage) return;
    this.garage.visible = !this.garage.visible;
  }

  /**
   * Swap the car in the queue. The Race is constructed from car specs and a
   * tuning set, so changing either means a new Race -- not mutating the one in
   * flight, which would leave its timing and its vehicle out of step.
   */
  selectCar(carId: string): void {
    if (carId === this.activeCarId) return;
    this.activeCarId = carId;
    this.rebuildRace();
  }

  /** Re-apply a restored save's car and rival without going through selectCar. */
  applyLoadedSelection(): void {
    this.rebuildRace();
  }

  private rebuildRace(): void {
    const spec = CAR_BY_ID[this.activeCarId];
    if (!spec) return;
    const tuning = new Set(
      this.player.garage.find((g) => g.carId === this.activeCarId)?.tuning ?? [],
    );
    const rival = CAR_BY_ID[this.rivalCarId];
    const race = new Race(spec, tuning, rival, new Set<BranchId>(), this.rivalSkill);
    race.begin();
    this.race = race;
    this.vehicles = [race.player.vehicle, race.rival.vehicle];
    this.rivalName = RIVALS[this.rivalSkill]?.name ?? 'RIVAL';
    this.raceSettled = false;
  }

  /**
   * Pay out a finished race -- exactly once.
   *
   * The guard matters: the race stays in FINISHED for as long as the player
   * sits on the result screen, and without it the payout would be applied once
   * per frame.
   */
  private settleRaceIfDone(): void {
    const race = this.race;
    if (!race || this.raceSettled) return;
    if (race.phase !== 'FINISHED') return;
    const snap = race.snapshot();
    const playerEt = snap.playerTiming.et;
    const rivalEt = snap.rivalTiming.et;
    if (!(playerEt > 0) || !(rivalEt > 0)) return;

    const rival = RIVALS[this.rivalSkill] ?? RIVALS[0];
    // A deterministic seed from the race number, so the rival's ET varies
    // band to band but a replay of the same race is reproducible.
    const seed = this.raceSettleCount;
    this.raceSettleCount++;
    const outcome = resolveRace(
      playerEt,
      rival,
      snap.playerTiming.launch?.multiplier ?? 1,
      seed,
    );
    const entry = this.player.garage.find((g) => g.carId === this.activeCarId);
    if (entry) {
      applyRace(this.player, outcome, rival, entry, snap.playerTiming.launch?.grade === 'PERFECT');
      // Advance the ladder when the player wins, so there is something to race
      // next. Without this every race was against rival zero forever.
      if (outcome.won) {
        const idx = RIVALS.findIndex((r) => r.id === rival.id);
        const nextIdx = Math.min(RIVALS.length - 1, idx + 1);
        if (nextIdx !== idx) {
          this.rivalSkill = nextIdx;
          this.rivalCarId = RIVALS[nextIdx].carId;
          this.rivalName = RIVALS[nextIdx].name;
          this.rebuildRace();
        }
      }
    }
    this.raceSettled = true;
    this.garage?.setState(this.player, this.activeCarId);
    saveGame(this.player, this.activeCarId, this.rivalSkill);
  }

  frame(now: number): void {
    const dt = this.lastNow === 0 ? FIXED_DT : (now - this.lastNow) / 1000;
    this.lastNow = now;

    this.renderer.handleResize();
    this.raceTime += dt;
    if (this.input.pressed('restart')) this.restart();
    if (this.input.pressed('garage')) this.toggleGarage();
    this.settleRaceIfDone();
    this.update(dt);
    this.buildDrawList(dt);

    // Chase camera. Anchored BEHIND the car and looking at it, with the look
    // target pushed down the strip so the road ahead stays in frame.
    const v = this.vehicles[0];
    // Broadcast angle: high, well back, and angled down the strip. Low chase
    // cameras put the road surface across the lower third of frame and lose the
    // cars behind trackside furniture.
    const camX = 0.6;
    const camY = 3.1;
    const camZ = v.distance - 13.5;
    this.renderer.cameraPos = [camX, camY, camZ];
    mat4.lookAt(
      this.renderer.view,
      new Float32Array([camX, camY, camZ]),
      new Float32Array([0, 1.15, v.distance + 4]),
      new Float32Array([0, 1, 0]),
    );
    this.renderer.updateMatrices((36 * Math.PI) / 180, 0.3, 900);

    this.renderer.render(this.items, dt * 1000, now);
    if (this.hud && this.race) {
      this.hud.draw(this.race.snapshot(), now, this.rivalName);
    }
    this.frameCount++;
    this.serviceReadback();
  }
}

function identity16(): Float32Array {
  const m = mat4.create();
  return new Float32Array([m[0], m[1], m[2], m[3], m[4], m[5], m[6], m[7], m[8], m[9], m[10], m[11], m[12], m[13], m[14], m[15]]);
}

function identity9(): Float32Array {
  return new Float32Array([1, 0, 0, 0, 1, 0, 0, 0, 1]);
}

export function boot(): App {
  const canvas = document.getElementById('view') as HTMLCanvasElement;
  const app = new App();
  try {
    app.init(canvas);
  } catch (e) {
    const msg = e instanceof Error ? `${e.message}` : String(e);
    window.__CAUSTIC_TEST__ = { ready: true, error: msg, frames: 0, tier: 'none', scale: 0, drawCalls: 0 };
    throw e;
  }

  window.__CAUSTIC_TEST__ = {
    ready: false,
    frames: 0,
    tier: app.renderer.tier,
    scale: 0,
    drawCalls: 0,
  };

  const loop = (now: number) => {
    try {
      app.frame(now);
      window.__CAUSTIC_TEST__!.frames = app.frameCount;
      window.__CAUSTIC_TEST__!.drawCalls = app.items.length;
      window.__CAUSTIC_TEST__!.scale = app.renderer.renderScale;
    } catch (e) {
      window.__CAUSTIC_TEST__!.error = e instanceof Error ? e.message : String(e);
      window.__CAUSTIC_TEST__!.ready = true;
      return;
    }
    if (app.frameCount >= 3) window.__CAUSTIC_TEST__!.ready = true;
    requestAnimationFrame(loop);
  };
  requestAnimationFrame(loop);
  return app;
}

export { App, FIXED_DT };

// Self-start when loaded as the page entry point. The render test imports this
// module into Node, where there is no canvas, so the guard is load-bearing.
if (typeof document !== 'undefined') {
  const el = document.getElementById('view');
  if (el instanceof HTMLCanvasElement) {
    try {
      const app = boot();
      (window as unknown as Record<string, unknown>).__CAUSTIC_APP__ = app;
      startHud(app);
      const root = document.getElementById('hud')?.parentElement ?? document.body;
      app.hud = new LaunchHud(root);
      app.touch = new TouchControls(root);
      app.touch.visible = 'ontouchstart' in window;

      // Restore a save if there is one, THEN build the garage against it. The
      // garage is where cash is spent, so it has to see the real player state.
      const restored = loadGame();
      if (restored) {
        app.player = restored.state;
        app.activeCarId = restored.activeCarId;
        app.rivalSkill = restored.rivalIndex;
        app.applyLoadedSelection();
      }
      app.garage = new GarageUI(root, app.player, app.activeCarId, {
        onSelectCar: (carId) => app.selectCar(carId),
        onChange: () => {
          app.garage?.setState(app.player, app.activeCarId);
          saveGame(app.player, app.activeCarId, app.rivalSkill);
        },
      });
    } catch (e) {
      const box = document.getElementById('err');
      if (box) {
        box.style.display = 'block';
        box.textContent = e instanceof Error ? (e.stack ?? e.message) : String(e);
      }
      window.__CAUSTIC_TEST__ = {
        ready: true,
        error: e instanceof Error ? e.message : String(e),
        frames: 0,
        tier: 'none',
        scale: 0,
        drawCalls: 0,
      };
    }
  }
}

/** Wire the readout. Kept here so main.ts owns everything the page needs. */
function startHud(app: App): void {
  const speed = document.getElementById('speedv');
  const rpmv = document.getElementById('rpmv');
  const fill = document.getElementById('fill');
  const diag = document.getElementById('diag');
  if (!speed || !rpmv || !fill || !diag) return;
  window.setInterval(() => {
    const v = app.vehicles[0];
    if (!v) return;
    speed.textContent = (Math.abs(v.speed) * 3.6).toFixed(1);
    rpmv.textContent = Math.round(v.rpm).toString();
    fill.style.width = `${Math.min(100, (v.rpm / 8000) * 100).toFixed(1)}%`;
    const t = window.__CAUSTIC_TEST__;
    diag.textContent =
      `${t ? t.tier : '?'}  ${app.renderer.avgFrameMs.toFixed(1)}ms  ` +
      `scale ${app.renderer.renderScale.toFixed(2)}  draws ${app.items.length}  ` +
      `f${app.frameCount}  z ${v.distance.toFixed(0)}m`;
  }, 100);
}
export type { QualityTier };
