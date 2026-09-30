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
import { buildCar, toVehicleConfig, type CarMesh, type CarSpec } from './geometry/Car';
import { CARS } from './game/data/cars';
import { buildStrip, buildLights, uploadStrip, buildLampBar, LANE_CENTRE } from './world/Strip';
import { Vehicle, NO_INPUT, type VehicleInputs } from './physics/Vehicle';

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
  vehicles: Vehicle[] = [];
  built: CarMesh[] = [];
  specs: CarSpec[] = [];
  gpu: Record<string, GPUMesh> = {};
  carMeshes: GPUMesh[] = [];
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

    // Two cars in the two lanes, 6 metres apart: player right, rival left.
    const player = CARS[0];
    const rival = CARS[1];
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
      this.vehicles.push(new Vehicle(toVehicleConfig(spec)));
      this.modelMats.push(new Float32Array(16));
      this.normalMats.push(new Float32Array(9));
      this.lampMats.push(new Float32Array(16));
      this.lampNorms.push(new Float32Array(9));
    }
    for (const v of this.vehicles) v.reset(1);
  }

  /** Advance the fixed-step simulation and rebuild the draw list. */
  update(dtReal: number): void {
    this.accumulator += Math.min(dtReal, 0.25);
    let steps = 0;
    while (this.accumulator >= FIXED_DT && steps < 12) {
      for (const v of this.vehicles) v.step(FIXED_DT, this.demoInput(v));
      this.accumulator -= FIXED_DT;
      steps++;
    }
    if (steps >= 12) this.accumulator = 0;
  }

  /**
   * A simple autopilot so the scene is alive without input. It stages on the
   * clutch to a launch rpm, dumps it, and then shifts at the redline -- which is
   * exactly what a player does, and it exercises every part of the drivetrain.
   */
  private demoInput(v: Vehicle): VehicleInputs {
    // Stage: hold the clutch and build revs toward the launch band.
    if (this.raceTime < 0.7) {
      return {
        ...NO_INPUT,
        throttle: Math.min(1, this.raceTime / 0.5),
        clutch: true,
      };
    }
    // Then dump the clutch and stay on the throttle, shifting at the redline.
    if (v.rpm > v.cfg.curve.redline * 0.95 && v.shiftReady) {
      return { ...NO_INPUT, throttle: 1, shiftUp: true };
    }
    return { ...NO_INPUT, throttle: 1 };
  }

  buildDrawList(): void {
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

  frame(now: number): void {
    const dt = this.lastNow === 0 ? FIXED_DT : (now - this.lastNow) / 1000;
    this.lastNow = now;

    this.renderer.handleResize();
    this.raceTime += dt;
    this.update(dt);
    this.buildDrawList();

    // Chase camera. Anchored BEHIND the car and looking at it, with the look
    // target pushed down the strip so the road ahead stays in frame.
    const v = this.vehicles[0];
    // Broadcast angle: high, well back, and angled down the strip. Low chase
    // cameras put the road surface across the lower third of frame and lose the
    // cars behind trackside furniture.
    const camX = 0.9;
    const camY = 4.4;
    const camZ = v.distance - 12.0;
    this.renderer.cameraPos = [camX, camY, camZ];
    mat4.lookAt(
      this.renderer.view,
      new Float32Array([camX, camY, camZ]),
      new Float32Array([0, 0.5, v.distance + 18]),
      new Float32Array([0, 1, 0]),
    );
    this.renderer.updateMatrices((42 * Math.PI) / 180, 0.3, 900);

    this.renderer.render(this.items, dt * 1000, now);
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
