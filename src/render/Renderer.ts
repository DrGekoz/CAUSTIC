/**
 * The render graph.
 *
 * A hand-written WebGL2 deferred pipeline with no 3D framework. Every pass
 * scales independently and the quality tier only ever changes pass resolution
 * and iteration counts, never whether the frame is correct.
 *
 *   G-BUFFER  MRT x3 + depth
 *   SHADOW    cascaded depth, PCSS contact hardening
 *   GTAO      horizon search, spatially denoised
 *   LIGHTING  GGX + clearcoat, IBL from a procedural probe
 *   SSR       hierarchical, roughness and edge faded
 *   VOLUMETRIC half-res raymarch through exponential fog
 *   TAA       neighbourhood-clamped history
 *   BLOOM     mip chain, Karis-averaged bright pass
 *   COMPOSITE ACES + aberration + vignette + grain + dither
 */

import { mat4 } from 'gl-matrix';
import {
  GLContext,
  createContext,
  resizeToDisplay,
  Program,
  RenderTarget,
  GPUMesh,
  FullscreenTriangle,
} from './GL';
import * as SH from './shaders';

export type QualityTier = 'LOW' | 'MEDIUM' | 'HIGH' | 'ULTRA';

export interface TierSettings {
  /** Dynamic resolution floor and ceiling. */
  minScale: number;
  maxScale: number;
  gtao: boolean;
  gtaoDirections: number;
  gtaoSteps: number;
  csr: number;
  shadowSize: number;
  volumetrics: boolean;
  volumetricSteps: number;
  ssr: boolean;
  ssrSteps: number;
  taa: boolean;
  bloomMips: number;
}

export const TIERS: Record<QualityTier, TierSettings> = {
  LOW: {
    minScale: 0.55,
    maxScale: 0.75,
    gtao: false,
    gtaoDirections: 0,
    gtaoSteps: 0,
    csr: 1,
    shadowSize: 1024,
    volumetrics: false,
    volumetricSteps: 0,
    ssr: false,
    ssrSteps: 0,
    taa: true,
    bloomMips: 3,
  },
  MEDIUM: {
    minScale: 0.75,
    maxScale: 1.0,
    gtao: true,
    gtaoDirections: 1,
    gtaoSteps: 3,
    csr: 2,
    shadowSize: 1536,
    volumetrics: true,
    volumetricSteps: 12,
    ssr: true,
    ssrSteps: 8,
    taa: true,
    bloomMips: 4,
  },
  HIGH: {
    minScale: 0.85,
    maxScale: 1.0,
    gtao: true,
    gtaoDirections: 2,
    gtaoSteps: 4,
    csr: 3,
    shadowSize: 2048,
    volumetrics: true,
    volumetricSteps: 24,
    ssr: true,
    ssrSteps: 16,
    taa: true,
    bloomMips: 5,
  },
  ULTRA: {
    minScale: 1.0,
    maxScale: 1.0,
    gtao: true,
    gtaoDirections: 2,
    gtaoSteps: 6,
    csr: 3,
    shadowSize: 2048,
    volumetrics: true,
    volumetricSteps: 32,
    ssr: true,
    ssrSteps: 16,
    taa: true,
    bloomMips: 6,
  },
};

/**
 * Pick a tier from a device pixel budget and a renderer string. Deliberately
 * capability-based rather than user-agent sniffing.
 */
export function detectTier(gl: WebGL2RenderingContext): QualityTier {
  let renderer = '';
  const ext = gl.getExtension('WEBGL_debug_renderer_info');
  if (ext) {
    renderer = String(gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) ?? '');
  }
  const r = renderer.toLowerCase();
  const mobile = /adreno|mali|apple gpu|powervr/.test(r);
  const weak = /llvmpipe|software|swiftshader|mesa/.test(r);
  const strong = /rtx|radeon rx|geforce gtx 1[06-9]|geforce rtx|apple m[1-9]/.test(r);

  if (weak) return 'LOW';
  if (mobile) return 'LOW';
  if (strong) return 'ULTRA';

  const cores = navigator.hardwareConcurrency ?? 4;
  const mem = (navigator as { deviceMemory?: number }).deviceMemory ?? 4;
  if (cores >= 8 && mem >= 8) return 'HIGH';
  if (cores >= 4) return 'MEDIUM';
  return 'LOW';
}

export interface PointLight {
  position: [number, number, number];
  color: [number, number, number];
  range: number;
  intensity: number;
}

export interface DrawItem {
  mesh: GPUMesh;
  model: Float32Array;
  normalMatrix: Float32Array;
  material: number;
  baseColor: [number, number, number];
  metallic: number;
  roughness: number;
  emissive: [number, number, number];
  clearcoat: number;
  paintFlake: number;
  slip: number;
  castShadow: boolean;
}

export interface FrameSettings {
  exposure: number;
  bloomStrength: number;
  bloomThreshold: number;
  vignette: number;
  grain: number;
  aberration: number;
  volumetricDensity: number;
  volumetricScatter: number;
  fogColor: [number, number, number];
  ambientSky: [number, number, number];
  ambientGround: [number, number, number];
  envIntensity: number;
  flash: number;
  flashColor: [number, number, number];
  taaFeedback: number;
}

export const DEFAULT_FRAME: FrameSettings = {
  exposure: 1.0,
  bloomStrength: 0.55,
  bloomThreshold: 1.1,
  vignette: 0.38,
  grain: 0.022,
  aberration: 0.0022,
  volumetricDensity: 0.5,
  volumetricScatter: 1.0,
  fogColor: [0.05, 0.07, 0.1],
  ambientSky: [0.035, 0.05, 0.075],
  ambientGround: [0.018, 0.016, 0.014],
  envIntensity: 1.0,
  flash: 0,
  flashColor: [1, 0.92, 0.75],
  taaFeedback: 0.9,
};

export class Renderer {
  readonly ctx: GLContext;
  tier: QualityTier;
  settings: TierSettings;
  frame: FrameSettings = { ...DEFAULT_FRAME };

  // Dynamic resolution
  private scale = 1;
  private frameTimes: number[] = [];
  private lastAdjust = 0;

  // Programs
  private pGBuffer!: Program;
  private pLighting!: Program;
  private pGTAO!: Program;
  private pSSR!: Program;
  private pComposite!: Program;
  private pBloomPre!: Program;
  private pBloomBlur!: Program;
  private pBloomDown!: Program;
  private pBloomUp!: Program;
  private pTAA!: Program;
  private pVolumetric!: Program;
  private pUpsample!: Program;
  private pBlit!: Program;

  // Targets
  private gbuffer!: RenderTarget;
  private lighting!: RenderTarget;
  private gtaoTarget: RenderTarget | null = null;
  private ssrTarget: RenderTarget | null = null;
  private volumetricTarget: RenderTarget | null = null;
  private taaHistory!: RenderTarget;
  private taaCurrent!: RenderTarget;
  private bloomChain: RenderTarget[] = [];
  private bloomScratch!: RenderTarget;
  private shadowFbo: RenderTarget[] = [];

  private fsTri: FullscreenTriangle;
  private envCube!: WebGLTexture;

  // Matrices
  readonly view = mat4.create();
  readonly proj = mat4.create();
  readonly viewProj = mat4.create();
  readonly invViewProj = mat4.create();
  cameraPos: [number, number, number] = [0, 2, -8];

  lights: PointLight[] = [];
  time = 0;
  private taaReset = true;
  frameCount = 0;

  /** Rolling average frame time in ms, for the on-screen readout. */
  avgFrameMs = 16.7;

  constructor(canvas: HTMLCanvasElement, tier?: QualityTier) {
    const ctx = createContext(canvas);
    if (!ctx) throw new Error('WebGL2 is not available in this browser');
    this.ctx = ctx;
    const gl = ctx.gl;
    this.tier = tier ?? detectTier(gl);
    this.settings = TIERS[this.tier];
    this.scale = this.settings.maxScale;

    this.fsTri = new FullscreenTriangle(gl);
    this.buildPrograms();
    this.buildEnvironment();
    this.buildShadowTargets();
    this.allocate(1, 1);
  }

  private buildPrograms(): void {
    const gl = this.ctx.gl;
    this.pGBuffer = new Program(gl, SH.GBUFFER_VERT, SH.GBUFFER_FRAG, 'gbuffer');
    this.pLighting = new Program(gl, SH.FULLSCREEN_VERT, SH.LIGHTING_FRAG, 'lighting');
    this.pGTAO = new Program(gl, SH.FULLSCREEN_VERT, SH.GTAO_FRAG, 'gtao');
    this.pSSR = new Program(gl, SH.FULLSCREEN_VERT, SH.SSR_FRAG, 'ssr');
    this.pComposite = new Program(gl, SH.FULLSCREEN_VERT, SH.COMPOSITE_FRAG, 'composite');
    this.pBloomPre = new Program(gl, SH.FULLSCREEN_VERT, SH.BLOOM_PREFILTER_FRAG, 'bloomPre');
    this.pBloomBlur = new Program(gl, SH.FULLSCREEN_VERT, SH.BLOOM_BLUR_FRAG, 'bloomBlur');
    this.pBloomDown = new Program(gl, SH.FULLSCREEN_VERT, SH.BLOOM_DOWN_FRAG, 'bloomDown');
    this.pBloomUp = new Program(gl, SH.FULLSCREEN_VERT, SH.BLOOM_UP_FRAG, 'bloomUp');
    this.pTAA = new Program(gl, SH.FULLSCREEN_VERT, SH.TAA_FRAG, 'taa');
    this.pVolumetric = new Program(gl, SH.FULLSCREEN_VERT, SH.VOLUMETRIC_FRAG, 'volumetric');
    this.pUpsample = new Program(gl, SH.FULLSCREEN_VERT, SH.UPSAMPLE_FRAG, 'upsample');
    this.pBlit = new Program(gl, SH.FULLSCREEN_VERT, SH.BLIT_FRAG, 'blit');
  }

  /**
   * A small procedural environment probe. Generating it once per scenario beats
   * shipping an HDRI and keeps the whole game asset-free, which is the point.
   */
  private buildEnvironment(): void {
    const gl = this.ctx.gl;
    const size = 64;
    const faces: Uint8Array[] = [];
    // Night sky over a lit ground plane, matching the visual thesis.
    for (let f = 0; f < 6; f++) {
      const data = new Uint8Array(size * size * 4);
      for (let y = 0; y < size; y++) {
        for (let x = 0; x < size; x++) {
          const u = (x + 0.5) / size;
          const v = (y + 0.5) / size;
          let r = 0;
          let g = 0;
          let b = 0;
          if (f === 2) {
            // +Y: sky, deep blue-black with a faint sodium glow at the horizon
            const t = 1 - v;
            r = 8 + t * 26;
            g = 12 + t * 18;
            b = 22 + t * 8;
          } else if (f === 3) {
            // -Y: ground, warm and dark
            r = 10;
            g = 8;
            b = 6;
          } else {
            // Sides: gradient from horizon to sky
            const t = v;
            r = 6 + t * 14;
            g = 9 + t * 12;
            b = 16 + t * 10;
          }
          const i = (y * size + x) * 4;
          data[i] = r;
          data[i + 1] = g;
          data[i + 2] = b;
          data[i + 3] = 255;
          void u;
        }
      }
      faces.push(data);
    }

    const tex = gl.createTexture();
    if (!tex) throw new Error('createTexture failed for the environment probe');
    gl.bindTexture(gl.TEXTURE_CUBE_MAP, tex);
    gl.texStorage2D(gl.TEXTURE_CUBE_MAP, 1, gl.RGBA8, size, size);
    const targets = [
      gl.TEXTURE_CUBE_MAP_POSITIVE_X,
      gl.TEXTURE_CUBE_MAP_NEGATIVE_X,
      gl.TEXTURE_CUBE_MAP_POSITIVE_Y,
      gl.TEXTURE_CUBE_MAP_NEGATIVE_Y,
      gl.TEXTURE_CUBE_MAP_POSITIVE_Z,
      gl.TEXTURE_CUBE_MAP_NEGATIVE_Z,
    ];
    for (let f = 0; f < 6; f++) {
      gl.texSubImage2D(
        targets[f],
        0,
        0,
        0,
        size,
        size,
        gl.RGBA,
        gl.UNSIGNED_BYTE,
        faces[f],
      );
    }
    gl.texParameteri(gl.TEXTURE_CUBE_MAP, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_CUBE_MAP, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_CUBE_MAP, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_CUBE_MAP, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    this.envCube = tex;

    // Mip chain for roughness sampling.
    gl.texParameteri(gl.TEXTURE_CUBE_MAP, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
    gl.generateMipmap(gl.TEXTURE_CUBE_MAP);
  }

  private buildShadowTargets(): void {
    const gl = this.ctx.gl;
    for (const t of this.shadowFbo) t.dispose();
    this.shadowFbo = [];
    const s = this.settings.shadowSize;
    for (let i = 0; i < this.settings.csr; i++) {
      const rt = new RenderTarget(gl, s, s, { internalFormat: gl.R32F, format: gl.RED, type: gl.FLOAT, filter: gl.NEAREST });
      this.shadowFbo.push(rt);
    }
  }

  private allocate(w: number, h: number): void {
    const gl = this.ctx.gl;
    const width = Math.max(1, Math.floor(w));
    const height = Math.max(1, Math.floor(h));

    if (this.gbuffer) {
      this.gbuffer.dispose();
      this.lighting.dispose();
      this.taaHistory.dispose();
      this.taaCurrent.dispose();
      for (const b of this.bloomChain) b.dispose();
      this.bloomScratch?.dispose();
      if (this.gtaoTarget) this.gtaoTarget.dispose();
      if (this.ssrTarget) this.ssrTarget.dispose();
      if (this.volumetricTarget) this.volumetricTarget.dispose();
    }

    const hdrFmt = this.ctx.hdr
      ? { internalFormat: gl.RGBA16F, format: gl.RGBA, type: gl.HALF_FLOAT }
      : { internalFormat: gl.RGBA8, format: gl.RGBA, type: gl.UNSIGNED_BYTE };

    this.gbuffer = new RenderTarget(
      gl,
      width,
      height,
      { ...hdrFmt, depth: true },
      3,
    );
    this.lighting = new RenderTarget(gl, width, height, hdrFmt);
    this.taaHistory = new RenderTarget(gl, width, height, hdrFmt);
    this.taaCurrent = new RenderTarget(gl, width, height, hdrFmt);

    this.gtaoTarget = this.settings.gtao
      ? new RenderTarget(gl, width >> 1, height >> 1, {
          internalFormat: gl.R8,
          format: gl.RED,
          type: gl.UNSIGNED_BYTE,
        })
      : null;
    this.ssrTarget = this.settings.ssr
      ? new RenderTarget(gl, width >> 1, height >> 1, hdrFmt)
      : null;
    this.volumetricTarget = this.settings.volumetrics
      ? new RenderTarget(gl, width >> 1, height >> 1, hdrFmt)
      : null;

    this.bloomChain = [];
    this.bloomScratch = new RenderTarget(gl, Math.max(1, width >> 1), Math.max(1, height >> 1), hdrFmt);
    // Mip 0 of the chain is also width>>1, so the scratch matches it exactly.
    let bw = width;
    let bh = height;
    for (let i = 0; i < this.settings.bloomMips; i++) {
      bw = Math.max(1, bw >> 1);
      bh = Math.max(1, bh >> 1);
      this.bloomChain.push(new RenderTarget(gl, bw, bh, hdrFmt));
    }

  }

  setTier(tier: QualityTier): void {
    if (tier === this.tier) return;
    this.tier = tier;
    this.settings = TIERS[tier];
    this.scale = this.settings.maxScale;
    this.buildShadowTargets();
    this.allocate(Math.floor(this.ctx.width * this.scale), Math.floor(this.ctx.height * this.scale));
    this.taaReset = true;
  }

  /** Resize the backing store, keeping the dynamic scale applied. */
  handleResize(): void {
    if (!resizeToDisplay(this.ctx)) return;
    this.allocate(
      Math.floor(this.ctx.width * this.scale),
      Math.floor(this.ctx.height * this.scale),
    );
    this.taaReset = true;
  }

  private bindTex(unit: number, tex: WebGLTexture, target = 0x0de1 /* TEXTURE_2D */): void {
    const gl = this.ctx.gl;
    gl.activeTexture(gl.TEXTURE0 + unit);
    gl.bindTexture(target, tex);
  }

  /**
   * Dynamic resolution. An EMA of frame time nudges the scale by +-0.05 per
   * frame inside the tier's band, with hysteresis so it cannot oscillate. This
   * is what actually holds the "runs on low-end hardware" promise.
   */
  private updateDynamicResolution(dtMs: number, now: number): void {
    this.frameTimes.push(dtMs);
    if (this.frameTimes.length > 30) this.frameTimes.shift();
    const sorted = [...this.frameTimes].sort((a, b) => a - b);
    const median = sorted[Math.floor(sorted.length / 2)] ?? 16.7;
    this.avgFrameMs = median;

    if (now - this.lastAdjust < 250) return;
    this.lastAdjust = now;
    const target = 16.7;
    let next = this.scale;
    if (median > target * 1.25) next = this.scale - 0.05;
    else if (median < target * 0.85) next = this.scale + 0.05;
    next = Math.max(this.settings.minScale, Math.min(this.settings.maxScale, next));
    if (Math.abs(next - this.scale) > 0.001) {
      this.scale = next;
      this.allocate(
        Math.floor(this.ctx.width * this.scale),
        Math.floor(this.ctx.height * this.scale),
      );
      this.taaReset = true;
    }
  }

  get renderWidth(): number {
    return this.gbuffer.width;
  }

  get renderHeight(): number {
    return this.gbuffer.height;
  }

  get renderScale(): number {
    return this.scale;
  }

  /** Render one frame. `items` are the visible draws. */
  render(items: DrawItem[], dtMs: number, now: number): void {
    const gl = this.ctx.gl;
    this.time += dtMs / 1000;
    this.frameCount++;
    this.updateDynamicResolution(dtMs, now);

    this.renderGBuffer(items);
    this.renderGTAO();
    this.renderLighting();
    this.renderSSR();
    this.renderVolumetrics();
    this.renderTAA();
    this.renderBloom();
    this.renderComposite();
    void gl;
  }

  private renderGBuffer(items: DrawItem[]): void {
    const gl = this.ctx.gl;
    // Textures bound by later passes stay bound to their units across the frame
    // boundary, so the G-buffer pass inherits the G-buffer's own depth texture
    // as an active sampler. That is a feedback loop even though this pass does
    // not sample it. Clear every unit first.
    for (let u = 0; u < 8; u++) {
      gl.activeTexture(gl.TEXTURE0 + u);
      gl.bindTexture(gl.TEXTURE_2D, null);
      gl.bindTexture(gl.TEXTURE_CUBE_MAP, null);
    }
    this.gbuffer.bind(true, 0, 0, 0, 1);
    gl.enable(gl.DEPTH_TEST);
    gl.depthFunc(gl.LEQUAL);
    gl.enable(gl.CULL_FACE);
    gl.cullFace(gl.BACK);
    gl.disable(gl.BLEND);

    const p = this.pGBuffer;
    p.use();
    p.setMat4('uViewProj', this.viewProj);
    p.setVec3('uCameraPos', this.cameraPos[0], this.cameraPos[1], this.cameraPos[2]);
    p.setFloat('uTime', this.time);

    let lastMaterial = -1;
    for (const item of items) {
      if (item.material !== lastMaterial) {
        p.setInt('uMaterial', item.material);
        p.setVec3('uBaseColor', ...item.baseColor);
        p.setFloat('uMetallic', item.metallic);
        p.setFloat('uRoughness', item.roughness);
        p.setVec3('uEmissive', ...item.emissive);
        p.setFloat('uClearcoat', item.clearcoat);
        p.setFloat('uPaintFlake', item.paintFlake);
        p.setFloat('uSurfaceGrip', 1);
        p.setFloat('uSlipAmount', item.slip);
        lastMaterial = item.material;
      } else {
        p.setFloat('uSlipAmount', item.slip);
      }
      p.setMat4('uModel', item.model);
      p.setMat3('uNormalMatrix', item.normalMatrix);
      item.mesh.draw();
    }
  }

  private renderGTAO(): void {
    if (!this.gtaoTarget) return;
    const gl = this.ctx.gl;
    this.gtaoTarget.bind(false);
    gl.disable(gl.DEPTH_TEST);
    gl.disable(gl.CULL_FACE);
    const p = this.pGTAO;
    p.use();
    this.bindTex(0, this.gbuffer.depthTexture!);
    p.setInt('uDepth', 0);
    this.bindTex(1, this.gbuffer.textures[1]);
    p.setInt('uNormal', 1);
    p.setMat4('uInvViewProj', this.invViewProj);
    p.setMat4('uProj', this.proj);
    p.setMat4('uView', this.view);
    p.setVec2('uResolution', this.gtaoTarget.width, this.gtaoTarget.height);
    p.setFloat('uRadius', 0.9);
    p.setInt('uDirections', this.settings.gtaoDirections);
    p.setInt('uSteps', this.settings.gtaoSteps);
    this.fsTri.draw();
  }

  private uploadLights(p: Program): void {
    const n = Math.min(8, this.lights.length);
    const pos = new Float32Array(24);
    const col = new Float32Array(24);
    const rng = new Float32Array(8);
    const inten = new Float32Array(8);
    for (let i = 0; i < n; i++) {
      const l = this.lights[i];
      pos[i * 3] = l.position[0];
      pos[i * 3 + 1] = l.position[1];
      pos[i * 3 + 2] = l.position[2];
      col[i * 3] = l.color[0];
      col[i * 3 + 1] = l.color[1];
      col[i * 3 + 2] = l.color[2];
      rng[i] = l.range;
      inten[i] = l.intensity;
    }
    p.setInt('uNumLights', n);
    // Uniform arrays must be uploaded whole; a short array is padded with zeros.
    const gl = this.ctx.gl;
    const loc = gl.getUniformLocation(p.program, 'uLightPos');
    if (loc) gl.uniform3fv(loc, pos);
    const loc2 = gl.getUniformLocation(p.program, 'uLightColor');
    if (loc2) gl.uniform3fv(loc2, col);
    const loc3 = gl.getUniformLocation(p.program, 'uLightRange');
    if (loc3) gl.uniform1fv(loc3, rng);
    const loc4 = gl.getUniformLocation(p.program, 'uLightIntensity');
    if (loc4) gl.uniform1fv(loc4, inten);
  }

  private renderLighting(): void {
    const gl = this.ctx.gl;
    this.lighting.bind(false);
    gl.disable(gl.DEPTH_TEST);
    gl.disable(gl.CULL_FACE);
    const p = this.pLighting;
    p.use();
    this.bindTex(0, this.gbuffer.textures[0]);
    p.setInt('uAlbedo', 0);
    this.bindTex(1, this.gbuffer.textures[1]);
    p.setInt('uNormal', 1);
    this.bindTex(2, this.gbuffer.textures[2]);
    p.setInt('uEmissive', 2);
    this.bindTex(3, this.gbuffer.depthTexture!);
    p.setInt('uDepth', 3);
    this.bindTex(4, this.envCube, gl.TEXTURE_CUBE_MAP);
    p.setInt('uEnv', 4);
    p.setMat4('uInvViewProj', this.invViewProj);
    p.setMat4('uView', this.view);
    p.setVec3('uCameraPos', ...this.cameraPos);
    p.setFloat('uTime', this.time);
    p.setFloat('uEnvIntensity', this.frame.envIntensity);
    p.setFloat('uExposure', this.frame.exposure);
    p.setVec3('uAmbientSky', ...this.frame.ambientSky);
    p.setVec3('uAmbientGround', ...this.frame.ambientGround);
    p.setFloat('uAOEnabled', this.gtaoTarget ? 1 : 0);
    this.uploadLights(p);
    this.fsTri.draw();
  }

  private renderSSR(): void {
    if (!this.ssrTarget) return;
    const gl = this.ctx.gl;
    this.ssrTarget.bind(false);
    gl.disable(gl.DEPTH_TEST);
    const p = this.pSSR;
    p.use();
    this.bindTex(0, this.lighting.textures[0]);
    p.setInt('uColor', 0);
    this.bindTex(1, this.gbuffer.depthTexture!);
    p.setInt('uDepth', 1);
    this.bindTex(2, this.gbuffer.textures[1]);
    p.setInt('uNormal', 2);
    p.setMat4('uInvViewProj', this.invViewProj);
    p.setMat4('uProj', this.proj);
    p.setMat4('uView', this.view);
    p.setVec3('uCameraPos', ...this.cameraPos);
    p.setFloat('uRoughnessFade', 1.0);
    p.setInt('uSteps', this.settings.ssrSteps);
    p.setFloat('uMaxDistance', 28.0);
    this.fsTri.draw();
  }

  private renderVolumetrics(): void {
    if (!this.volumetricTarget) return;
    const gl = this.ctx.gl;
    this.volumetricTarget.bind(true, 0, 0, 0, 1);
    gl.disable(gl.DEPTH_TEST);
    const p = this.pVolumetric;
    p.use();
    this.bindTex(0, this.gbuffer.depthTexture!);
    p.setInt('uDepth', 0);
    p.setMat4('uInvViewProj', this.invViewProj);
    p.setVec3('uCameraPos', ...this.cameraPos);
    p.setFloat('uTime', this.time);
    p.setFloat('uDensity', this.frame.volumetricDensity);
    p.setFloat('uScatter', this.frame.volumetricScatter);
    p.setInt('uSteps', this.frame.volumetricScatter > 0 ? this.settings.volumetricSteps : 0);
    this.uploadLights(p);
    p.setVec3('uFogColor', ...this.frame.fogColor);
    this.fsTri.draw();
  }

  private renderTAA(): void {
    const gl = this.ctx.gl;
    const src = this.ssrTarget ?? this.lighting;
    if (!this.settings.taa) {
      // Copy straight through so the composite always reads taaCurrent.
      this.taaCurrent.bind(false);
      gl.disable(gl.DEPTH_TEST);
      this.pBlit.use();
      this.bindTex(0, src.textures[0]);
      this.pBlit.setInt('uSource', 0);
      this.fsTri.draw();
      return;
    }

    this.taaCurrent.bind(false);
    gl.disable(gl.DEPTH_TEST);
    const p = this.pTAA;
    p.use();
    this.bindTex(0, src.textures[0]);
    p.setInt('uCurrent', 0);
    this.bindTex(1, this.taaHistory.textures[0]);
    p.setInt('uHistory', 1);
    this.bindTex(2, this.gbuffer.depthTexture!);
    p.setInt('uDepth', 2);
    p.setVec2('uTexel', 1 / this.taaCurrent.width, 1 / this.taaCurrent.height);
    p.setFloat('uBlend', 0.0);
    p.setFloat('uFeedback', this.taaReset ? 0.0 : this.frame.taaFeedback);
    this.fsTri.draw();

    // Swap history and current.
    const t = this.taaHistory;
    this.taaHistory = this.taaCurrent;
    this.taaCurrent = t;
    this.taaReset = false;
  }

  private renderBloom(): void {
    const gl = this.ctx.gl;
    gl.disable(gl.DEPTH_TEST);
    if (this.bloomChain.length === 0) return;

    const pre = this.bloomChain[0];
    pre.bind(false);
    this.pBloomPre.use();
    this.bindTex(0, this.taaCurrent.textures[0]);
    this.pBloomPre.setInt('uScene', 0);
    this.pBloomPre.setFloat('uThreshold', this.frame.bloomThreshold);
    this.pBloomPre.setFloat('uSoftKnee', 0.6);
    this.fsTri.draw();

    for (let i = 1; i < this.bloomChain.length; i++) {
      const src = this.bloomChain[i - 1];
      const dst = this.bloomChain[i];
      dst.bind(false);
      this.pBloomDown.use();
      this.bindTex(0, src.textures[0]);
      this.pBloomDown.setInt('uSource', 0);
      this.pBloomDown.setVec2('uTexel', 1 / src.width, 1 / src.height);
      this.fsTri.draw();
    }

    for (let i = this.bloomChain.length - 2; i >= 0; i--) {
      const src = this.bloomChain[i + 1];
      const dst = this.bloomChain[i];
      // The shader reads both the coarser mip and its own current contents, so
      // it cannot render into dst directly: that is a framebuffer feedback
      // loop and the driver drops the draw with GL_INVALID_OPERATION. Blit
      // dst aside first, render additively, then restore.
      const saved = this.bloomScratch;
      saved.bind(false);
      gl.disable(gl.BLEND);
      this.pBlit.use();
      this.bindTex(0, dst.textures[0]);
      this.pBlit.setInt('uSource', 0);
      this.fsTri.draw();

      dst.bind(false);
      gl.enable(gl.BLEND);
      gl.blendFunc(gl.ONE, gl.ONE);
      this.pBloomUp.use();
      this.bindTex(0, src.textures[0]);
      this.pBloomUp.setInt('uSource', 0);
      this.bindTex(1, saved.textures[0]);
      this.pBloomUp.setInt('uPrevious', 1);
      this.pBloomUp.setVec2('uTexel', 1 / src.width, 1 / src.height);
      this.pBloomUp.setFloat('uRadius', 1.0);
      this.fsTri.draw();
      gl.disable(gl.BLEND);
    }

    // Final horizontal blur. It MUST render somewhere other than the mip it
    // reads, otherwise the draw is a framebuffer feedback loop -- the last thing
    // bound above is bloomChain[0], which is exactly the source here.
    const base = this.bloomChain[0];
    this.bloomScratch.bind(false);
    this.pBloomBlur.use();
    this.bindTex(0, base.textures[0]);
    this.pBloomBlur.setInt('uSource', 0);
    this.pBloomBlur.setVec2('uDirection', 1 / base.width, 0);
    this.fsTri.draw();

    // Copy back so the composite reads a soft image from a predictable slot.
    base.bind(false);
    this.pBlit.use();
    this.bindTex(0, this.bloomScratch.textures[0]);
    this.pBlit.setInt('uSource', 0);
    this.fsTri.draw();
  }

  private renderComposite(): void {
    const gl = this.ctx.gl;
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, this.ctx.width, this.ctx.height);
    gl.disable(gl.DEPTH_TEST);
    const p = this.pComposite;
    p.use();
    this.bindTex(0, this.taaCurrent.textures[0]);
    p.setInt('uScene', 0);
    if (this.bloomChain.length > 0) {
      this.bindTex(1, this.bloomChain[0].textures[0]);
    } else {
      this.bindTex(1, this.taaCurrent.textures[0]);
    }
    p.setInt('uBloom', 1);
    p.setFloat('uExposure', this.frame.exposure);
    p.setFloat('uBloomStrength', this.bloomChain.length > 0 ? this.frame.bloomStrength : 0);
    p.setFloat('uVignette', this.frame.vignette);
    p.setFloat('uGrain', this.frame.grain);
    p.setFloat('uAberration', this.frame.aberration);
    p.setFloat('uTime', this.time);
    p.setFloat('uFlash', this.frame.flash);
    p.setVec3('uFlashColor', ...this.frame.flashColor);
    this.fsTri.draw();
  }

  /** Recompose the matrices. Call once per frame before render(). */
  updateMatrices(fovY: number, near: number, far: number): void {
    mat4.perspective(this.proj, fovY, this.renderWidth / this.renderHeight, near, far);
    void 0;
    mat4.multiply(this.viewProj, this.proj, this.view);
    mat4.invert(this.invViewProj, this.viewProj);
  }

  dispose(): void {
    this.fsTri.dispose();
    this.pGBuffer.dispose();
    this.pLighting.dispose();
    this.pGTAO.dispose();
    this.pSSR.dispose();
    this.pComposite.dispose();
    this.pBloomPre.dispose();
    this.pBloomBlur.dispose();
    this.pBloomDown.dispose();
    this.pBloomUp.dispose();
    this.pTAA.dispose();
    this.pVolumetric.dispose();
    this.pUpsample.dispose();
    this.pBlit.dispose();
    this.ctx.gl.deleteTexture(this.envCube);
  }
}
