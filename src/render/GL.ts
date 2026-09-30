/**
 * WebGL2 context, programs, targets and meshes.
 *
 * The render graph is the product, so this layer is deliberately thin: it owns
 * GL state and resource lifetime and knows nothing about lighting or shading.
 */

export interface GLContext {
  gl: WebGL2RenderingContext;
  canvas: HTMLCanvasElement;
  /** True when EXT_color_buffer_float is available, for HDR targets. */
  hdr: boolean;
  /** True when the OES_texture_float_linear extension is present. */
  floatLinear: boolean;
  width: number;
  height: number;
  dpr: number;
}

export function createContext(canvas: HTMLCanvasElement): GLContext | null {
  const gl = canvas.getContext('webgl2', {
    alpha: false,
    antialias: false, // we do our own TAA
    depth: true,
    stencil: false,
    powerPreference: 'high-performance',
    preserveDrawingBuffer: false,
    desynchronized: false,
  });
  if (!gl) return null;

  const hdr = !!gl.getExtension('EXT_color_buffer_float');
  const floatLinear = !!gl.getExtension('OES_texture_float_linear');
  // Half-float linear filtering is core in WebGL2, but ask anyway for RGBA16F
  // colour attachments where the driver may still require it.
  gl.getExtension('EXT_float_blend');

  const dpr = Math.min(window.devicePixelRatio || 1, 2);

  return {
    gl,
    canvas,
    hdr,
    floatLinear,
    width: canvas.width,
    height: canvas.height,
    dpr,
  };
}

export function resizeToDisplay(ctx: GLContext, maxDpr = 2): boolean {
  const dpr = Math.min(window.devicePixelRatio || 1, maxDpr);
  const w = Math.max(1, Math.floor(ctx.canvas.clientWidth * dpr));
  const h = Math.max(1, Math.floor(ctx.canvas.clientHeight * dpr));
  if (w === ctx.width && h === ctx.height && dpr === ctx.dpr) return false;
  ctx.canvas.width = w;
  ctx.canvas.height = h;
  ctx.width = w;
  ctx.height = h;
  ctx.dpr = dpr;
  return true;
}

export type UniformMap = Record<string, number | Float32Array | Int32Array | number[]>;

export class Program {
  readonly program: WebGLProgram;
  private uniforms = new Map<string, WebGLUniformLocation | null>();

  constructor(
    private gl: WebGL2RenderingContext,
    vertexSrc: string,
    fragmentSrc: string,
    label = 'program',
  ) {
    const vs = compile(gl, gl.VERTEX_SHADER, vertexSrc, `${label}.vert`);
    const fs = compile(gl, gl.FRAGMENT_SHADER, fragmentSrc, `${label}.frag`);
    const p = gl.createProgram();
    if (!p) throw new Error(`${label}: createProgram returned null`);
    gl.attachShader(p, vs);
    gl.attachShader(p, fs);
    gl.linkProgram(p);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) {
      const log = gl.getProgramInfoLog(p);
      throw new Error(`${label}: link failed: ${log}`);
    }
    gl.deleteShader(vs);
    gl.deleteShader(fs);
    this.program = p;
  }

  use(): void {
    this.gl.useProgram(this.program);
  }

  private loc(name: string): WebGLUniformLocation | null {
    if (!this.uniforms.has(name)) {
      this.uniforms.set(name, this.gl.getUniformLocation(this.program, name));
    }
    return this.uniforms.get(name) ?? null;
  }

  set(name: string, value: number): void {
    const l = this.loc(name);
    if (l) this.gl.uniform1f(l, value);
  }

  /** Alias for set(), for readability at call sites that pass a scalar uniform. */
  setFloat(name: string, value: number): void {
    this.set(name, value);
  }

  setInt(name: string, value: number): void {
    const l = this.loc(name);
    if (l) this.gl.uniform1i(l, value);
  }

  setVec2(name: string, x: number, y: number): void {
    const l = this.loc(name);
    if (l) this.gl.uniform2f(l, x, y);
  }

  setVec3(name: string, x: number, y: number, z: number): void {
    const l = this.loc(name);
    if (l) this.gl.uniform3f(l, x, y, z);
  }

  setVec4(name: string, x: number, y: number, z: number, w: number): void {
    const l = this.loc(name);
    if (l) this.gl.uniform4f(l, x, y, z, w);
  }

  /** Accepts a Float32Array or a gl-matrix mat4 (which is a plain array). */
  setMat4(name: string, m: ArrayLike<number>): void {
    const l = this.loc(name);
    if (!l) return;
    this.gl.uniformMatrix4fv(l, false, m as Float32Array);
  }

  /** 3x3 matrix, e.g. a normal matrix. */
  setMat3(name: string, m: ArrayLike<number>): void {
    const l = this.loc(name);
    if (!l) return;
    this.gl.uniformMatrix3fv(l, false, m as Float32Array);
  }

  setVec3Array(name: string, v: Float32Array): void {
    const l = this.loc(name);
    if (l) this.gl.uniform3fv(l, v);
  }

  dispose(): void {
    this.gl.deleteProgram(this.program);
  }
}

function compile(gl: WebGL2RenderingContext, type: number, src: string, label: string): WebGLShader {
  const sh = gl.createShader(type);
  if (!sh) throw new Error(`${label}: createShader returned null`);
  gl.shaderSource(sh, src);
  gl.compileShader(sh);
  if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
    const log = gl.getShaderInfoLog(sh) ?? '';
    const numbered = src
      .split('\n')
      .map((l, i) => `${String(i + 1).padStart(3)} | ${l}`)
      .join('\n');
    gl.deleteShader(sh);
    throw new Error(`${label}: compile failed: ${log}\n${numbered}`);
  }
  return sh;
}

export interface TargetOptions {
  /** Colour format. Accepted for API symmetry; texStorage2D fixes the layout. */
  internalFormat?: number;
  format?: number;
  type?: number;
  /** Attach a depth buffer. */
  depth?: boolean;
  /** Wrap mode, defaults to CLAMP_TO_EDGE. */
  wrap?: number;
  filter?: number;
}

export class RenderTarget {
  framebuffer: WebGLFramebuffer;
  textures: WebGLTexture[] = [];
  depthBuffer: WebGLRenderbuffer | null = null;
  /**
   * A sampleable copy of the depth attachment. Needed because GTAO, SSR,
   * volumetrics and TAA all reconstruct world position from depth, and a
   * renderbuffer cannot be bound as a texture.
   */
  depthTexture: WebGLTexture | null = null;
  width: number;
  height: number;

  constructor(
    private gl: WebGL2RenderingContext,
    width: number,
    height: number,
    private opts: TargetOptions = {},
    private attachmentCount = 1,
  ) {
    this.width = Math.max(1, width);
    this.height = Math.max(1, height);
    const fb = gl.createFramebuffer();
    if (!fb) throw new Error('createFramebuffer returned null');
    this.framebuffer = fb;
    this.build();
  }

  private build(): void {
    const gl = this.gl;
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.framebuffer);
    const internal = this.opts.internalFormat ?? gl.RGBA8;
    const wrap = this.opts.wrap ?? gl.CLAMP_TO_EDGE;
    const filter = this.opts.filter ?? gl.LINEAR;

    const attachments: number[] = [];
    for (let i = 0; i < this.attachmentCount; i++) {
      const tex = gl.createTexture();
      if (!tex) throw new Error('createTexture returned null');
      gl.bindTexture(gl.TEXTURE_2D, tex);
      gl.texStorage2D(gl.TEXTURE_2D, 1, internal, this.width, this.height);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, filter);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, filter);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, wrap);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, wrap);
      gl.framebufferTexture2D(
        gl.FRAMEBUFFER,
        gl.COLOR_ATTACHMENT0 + i,
        gl.TEXTURE_2D,
        tex,
        0,
      );
      attachments.push(gl.COLOR_ATTACHMENT0 + i);
      this.textures.push(tex);
    }
    gl.drawBuffers(attachments);

    if (this.opts.depth) {
      const dtex = gl.createTexture();
      if (!dtex) throw new Error('createTexture failed for depth attachment');
      gl.bindTexture(gl.TEXTURE_2D, dtex);
      gl.texStorage2D(gl.TEXTURE_2D, 1, gl.DEPTH_COMPONENT24, this.width, this.height);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, gl.TEXTURE_2D, dtex, 0);
      this.depthTexture = dtex;
    }

    const status = gl.checkFramebufferStatus(gl.FRAMEBUFFER);
    if (status !== gl.FRAMEBUFFER_COMPLETE) {
      throw new Error(`framebuffer incomplete: 0x${status.toString(16)}`);
    }
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  }

  resize(width: number, height: number): void {
    const w = Math.max(1, width);
    const h = Math.max(1, height);
    if (w === this.width && h === this.height) return;
    const gl = this.gl;
    this.width = w;
    this.height = h;
    for (const t of this.textures) gl.deleteTexture(t);
    this.textures = [];
    if (this.depthBuffer) {
      gl.deleteRenderbuffer(this.depthBuffer);
      this.depthBuffer = null;
    }
    if (this.depthTexture) {
      gl.deleteTexture(this.depthTexture);
      this.depthTexture = null;
    }
    this.build();
  }

  bind(clear = false, r = 0, g = 0, b = 0, a = 1): void {
    const gl = this.gl;
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.framebuffer);
    gl.viewport(0, 0, this.width, this.height);
    if (clear) {
      gl.clearColor(r, g, b, a);
      gl.clear(gl.COLOR_BUFFER_BIT | (this.depthBuffer ? gl.DEPTH_BUFFER_BIT : 0));
    }
  }

  dispose(): void {
    const gl = this.gl;
    for (const t of this.textures) gl.deleteTexture(t);
    if (this.depthBuffer) gl.deleteRenderbuffer(this.depthBuffer);
    if (this.depthTexture) gl.deleteTexture(this.depthTexture);
    gl.deleteFramebuffer(this.framebuffer);
  }
}

/** A VAO wrapping a mesh plus optional per-instance buffers. */
export class GPUMesh {
  vao: WebGLVertexArrayObject;
  private buffers: WebGLBuffer[] = [];
  indexCount: number;
  indexType: number;

  constructor(
    private gl: WebGL2RenderingContext,
    positions: Float32Array,
    normals: Float32Array,
    uvs: Float32Array,
    indices: Uint32Array | Uint16Array,
  ) {
    const vao = gl.createVertexArray();
    if (!vao) throw new Error('createVertexArray returned null');
    this.vao = vao;
    gl.bindVertexArray(vao);

    const attr = (data: Float32Array, loc: number, size: number) => {
      const buf = gl.createBuffer();
      if (!buf) throw new Error('createBuffer returned null');
      gl.bindBuffer(gl.ARRAY_BUFFER, buf);
      gl.bufferData(gl.ARRAY_BUFFER, data, gl.STATIC_DRAW);
      gl.enableVertexAttribArray(loc);
      gl.vertexAttribPointer(loc, size, gl.FLOAT, false, 0, 0);
      this.buffers.push(buf);
    };
    attr(positions, 0, 3);
    attr(normals, 1, 3);
    attr(uvs, 2, 2);

    const ibo = gl.createBuffer();
    if (!ibo) throw new Error('createBuffer returned null');
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, ibo);
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, indices, gl.STATIC_DRAW);
    this.buffers.push(ibo);

    this.indexCount = indices.length;
    this.indexType = indices instanceof Uint32Array ? gl.UNSIGNED_INT : gl.UNSIGNED_SHORT;

    gl.bindVertexArray(null);
  }

  draw(): void {
    const gl = this.gl;
    gl.bindVertexArray(this.vao);
    gl.drawElements(gl.TRIANGLES, this.indexCount, this.indexType, 0);
  }

  dispose(): void {
    const gl = this.gl;
    for (const b of this.buffers) gl.deleteBuffer(b);
    gl.deleteVertexArray(this.vao);
  }
}

/** A single triangle covering the screen, for fullscreen passes. */
export class FullscreenTriangle {
  private vao: WebGLVertexArrayObject;
  private buffer: WebGLBuffer;

  constructor(private gl: WebGL2RenderingContext) {
    const vao = gl.createVertexArray();
    const buf = gl.createBuffer();
    if (!vao || !buf) throw new Error('fullscreen triangle alloc failed');
    this.vao = vao;
    this.buffer = buf;
    gl.bindVertexArray(vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    // One oversized triangle rather than two: no diagonal seam, one fewer
    // vertex, and the rasteriser clips it to the viewport for free.
    gl.bufferData(
      gl.ARRAY_BUFFER,
      new Float32Array([-1, -1, 3, -1, -1, 3]),
      gl.STATIC_DRAW,
    );
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    gl.bindVertexArray(null);
  }

  draw(): void {
    const gl = this.gl;
    gl.bindVertexArray(this.vao);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  }

  dispose(): void {
    const gl = this.gl;
    gl.deleteBuffer(this.buffer);
    gl.deleteVertexArray(this.vao);
  }
}
