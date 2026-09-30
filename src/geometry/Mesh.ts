/**
 * Procedural mesh construction.
 *
 * No 3D framework. These builders produce plain typed arrays that go straight
 * into a WebGL vertex buffer, so the geometry density of every car is decided
 * at generation time rather than shipped at 7.7MB and decimated at runtime.
 */

export interface MeshData {
  /** xyz per vertex. */
  positions: Float32Array;
  /** xyz per normal, one per vertex (not per face). */
  normals: Float32Array;
  /** uv per vertex. */
  uvs: Float32Array;
  /** Triangle indices, three per triangle. */
  indices: Uint32Array;
}

/** Growable mesh accumulator. */
export class MeshBuilder {
  private pos: number[] = [];
  private nrm: number[] = [];
  private uv: number[] = [];
  private idx: number[] = [];

  get vertexCount(): number {
    return this.pos.length / 3;
  }

  get triangleCount(): number {
    return this.idx.length / 3;
  }

  vertex(x: number, y: number, z: number, nx = 0, ny = 0, nz = 0, u = 0, v = 0): number {
    const i = this.pos.length / 3;
    this.pos.push(x, y, z);
    this.nrm.push(nx, ny, nz);
    this.uv.push(u, v);
    return i;
  }

  tri(a: number, b: number, c: number): void {
    this.idx.push(a, b, c);
  }

  quad(a: number, b: number, c: number, d: number): void {
    this.idx.push(a, b, c, a, c, d);
  }

  /**
   * Recompute smooth vertex normals from area-weighted face normals. Accumulate
   * un-normalised cross products, so a large face contributes proportionally
   * more than a small one; that weighting is what stops a low-poly loft from
   * looking faceted at the seams.
   */
  computeNormals(): void {
    const n = this.pos.length;
    const acc = new Float32Array(n);
    for (let t = 0; t < this.idx.length; t += 3) {
      const ia = this.idx[t] * 3;
      const ib = this.idx[t + 1] * 3;
      const ic = this.idx[t + 2] * 3;
      const ax = this.pos[ia];
      const ay = this.pos[ia + 1];
      const az = this.pos[ia + 2];
      const e1x = this.pos[ib] - ax;
      const e1y = this.pos[ib + 1] - ay;
      const e1z = this.pos[ib + 2] - az;
      const e2x = this.pos[ic] - ax;
      const e2y = this.pos[ic + 1] - ay;
      const e2z = this.pos[ic + 2] - az;
      const cx = e1y * e2z - e1z * e2y;
      const cy = e1z * e2x - e1x * e2z;
      const cz = e1x * e2y - e1y * e2x;
      acc[ia] += cx;
      acc[ia + 1] += cy;
      acc[ia + 2] += cz;
      acc[ib] += cx;
      acc[ib + 1] += cy;
      acc[ib + 2] += cz;
      acc[ic] += cx;
      acc[ic + 1] += cy;
      acc[ic + 2] += cz;
    }
    for (let i = 0; i < n; i += 3) {
      const x = acc[i];
      const y = acc[i + 1];
      const z = acc[i + 2];
      const len = Math.hypot(x, y, z);
      if (len > 1e-12) {
        this.nrm[i] = x / len;
        this.nrm[i + 1] = y / len;
        this.nrm[i + 2] = z / len;
      } else {
        this.nrm[i] = 0;
        this.nrm[i + 1] = 1;
        this.nrm[i + 2] = 0;
      }
    }
  }

  /** Append another builder's geometry, optionally transformed. */
  append(other: MeshBuilder, transform?: (x: number, y: number, z: number) => [number, number, number]): void {
    const base = this.vertexCount;
    const n = other.vertexCount;
    for (let i = 0; i < n; i++) {
      let x = other.pos[i * 3];
      let y = other.pos[i * 3 + 1];
      let z = other.pos[i * 3 + 2];
      let nx = other.nrm[i * 3];
      let ny = other.nrm[i * 3 + 1];
      let nz = other.nrm[i * 3 + 2];
      if (transform) {
        [x, y, z] = transform(x, y, z);
        // Rotations preserve normals; the car transforms are rigid.
        void nx;
        void ny;
        void nz;
      }
      this.pos.push(x, y, z);
      this.nrm.push(nx, ny, nz);
      this.uv.push(other.uv[i * 2], other.uv[i * 2 + 1]);
    }
    for (let i = 0; i < other.idx.length; i++) this.idx.push(other.idx[i] + base);
  }

  build(): MeshData {
    if (this.triangleCount === 0) this.computeNormals();
    return {
      positions: new Float32Array(this.pos),
      normals: new Float32Array(this.nrm),
      uvs: new Float32Array(this.uv),
      indices: new Uint32Array(this.idx),
    };
  }
}

/**
 * A rounded-rectangle cross-section in the XZ plane, walked counter-clockwise
 * from the bottom-left.
 *
 * Corner arcs are emitted at their exact endpoints, which means the last point
 * of each arc coincides with the first point of the next straight edge. Those
 * duplicates produced degenerate quads in the loft (a zero-height edge makes
 * two zero-area triangles per ring), so consecutive duplicates are dropped
 * here rather than being tolerated downstream.
 */
export function ringPoints(
  halfWidth: number,
  floorY: number,
  roofY: number,
  roundness: number,
  segments: number,
  topWidthScale = 1,
): Array<[number, number]> {
  const raw: Array<[number, number]> = [];
  const hw = halfWidth;
  const h = roofY - floorY;
  const r = Math.max(1e-4, Math.min(hw, h * 0.5) * roundness);
  const topHw = hw * topWidthScale;
  const push = (x: number, y: number) => raw.push([x, y]);

  const straightBottom = Math.max(0, hw - r);
  const straightTop = Math.max(0, topHw - r);

  push(-straightBottom, floorY);
  push(straightBottom, floorY);
  for (let i = 0; i <= segments; i++) {
    const a = (i / segments) * (Math.PI / 2);
    push(straightBottom + r * Math.sin(a), floorY + r - r * Math.cos(a));
  }
  push(topHw, floorY + h - r);
  for (let i = 0; i <= segments; i++) {
    const a = (i / segments) * (Math.PI / 2);
    push(topHw - straightTop + r * Math.cos(a), floorY + h - r + r * Math.sin(a));
  }
  push(-straightTop, floorY + h);
  for (let i = 0; i <= segments; i++) {
    const a = (i / segments) * (Math.PI / 2);
    push(-straightTop - r * Math.sin(a), floorY + h - r + r * Math.cos(a));
  }
  push(-hw, floorY + h - r);
  for (let i = 0; i <= segments; i++) {
    const a = (i / segments) * (Math.PI / 2);
    push(-hw - r * Math.cos(a) + r, floorY + r - r * Math.sin(a));
  }

  // Drop consecutive duplicates, including the wrap-around pair.
  const out: Array<[number, number]> = [];
  const eps = 1e-7;
  for (const [x, y] of raw) {
    const last = out[out.length - 1];
    if (last && Math.abs(last[0] - x) < eps && Math.abs(last[1] - y) < eps) continue;
    out.push([x, y]);
  }
  while (out.length > 1) {
    const a = out[0];
    const b = out[out.length - 1];
    if (Math.abs(a[0] - b[0]) < eps && Math.abs(a[1] - b[1]) < eps) out.pop();
    else break;
  }
  return out;
}

/**
 * Loft a tube through a series of cross-sections. Every ring must have the
 * same point count. Caps the ends with fans.
 */
export function loft(rings: Array<Array<[number, number]>>, closeFront = true, closeBack = true): MeshBuilder {
  const mb = new MeshBuilder();
  if (rings.length < 2) return mb;
  const n = rings[0].length;

  for (let r = 0; r < rings.length; r++) {
    const ring = rings[r];
    for (let i = 0; i < n; i++) {
      const [x, y] = ring[i];
      mb.vertex(x, y, r, 0, 0, 0, i / n, r / (rings.length - 1));
    }
  }

  for (let r = 0; r < rings.length - 1; r++) {
    for (let i = 0; i < n; i++) {
      const a = r * n + i;
      const b = r * n + ((i + 1) % n);
      const c = (r + 1) * n + ((i + 1) % n);
      const d = (r + 1) * n + i;
      mb.quad(a, b, c, d);
    }
  }

  if (closeBack) {
    const ring = rings[0];
    const centre = mb.vertex(0, ring[0][1], 0, 0, 0, -1, 0.5, 0.5);
    const start = mb.vertexCount;
    for (const [x, y] of ring) mb.vertex(x, y, 0, 0, 0, -1, 0.5, 0.5);
    for (let i = 0; i < n; i++) mb.tri(centre, start + ((i + 1) % n), start + i);
  }

  if (closeFront) {
    const last = rings.length - 1;
    const ring = rings[last];
    const centre = mb.vertex(0, ring[0][1], last, 0, 0, 1, 0.5, 0.5);
    const start = mb.vertexCount;
    for (const [x, y] of ring) mb.vertex(x, y, last, 0, 0, 1, 0.5, 0.5);
    for (let i = 0; i < n; i++) mb.tri(centre, start + i, start + ((i + 1) % n));
  }

  mb.computeNormals();
  return mb;
}

/**
 * A parametric wheel: tyre torus approximated by a swept rounded profile, plus
 * a rim face with N spokes. Generated once and instanced four times per car.
 */
export function buildWheel(
  radius: number,
  width: number,
  spokes: number,
  segments = 24,
): MeshBuilder {
  const mb = new MeshBuilder();
  const hw = width * 0.5;
  const rimRadius = radius * 0.62;
  const profile: Array<[number, number]> = [
    [rimRadius, -hw],
    [radius * 0.86, -hw * 0.98],
    [radius * 0.985, -hw * 0.62],
    [radius, 0],
    [radius * 0.985, hw * 0.62],
    [radius * 0.86, hw * 0.98],
    [rimRadius, hw],
  ];

  // Tyre: revolve the profile around the X axis (the axle).
  const ringsIdx: number[][] = [];
  for (const [pr, px] of profile) {
    const ring: number[] = [];
    for (let i = 0; i < segments; i++) {
      const a = (i / segments) * Math.PI * 2;
      const y = Math.cos(a) * pr;
      const z = Math.sin(a) * pr;
      ring.push(mb.vertex(px, y, z, 0, 0, 0, i / segments, 0));
    }
    ringsIdx.push(ring);
  }
  for (let r = 0; r < ringsIdx.length - 1; r++) {
    for (let i = 0; i < segments; i++) {
      const a = ringsIdx[r][i];
      const b = ringsIdx[r][(i + 1) % segments];
      const c = ringsIdx[r + 1][(i + 1) % segments];
      const d = ringsIdx[r + 1][i];
      mb.quad(a, b, c, d);
    }
  }

  // Rim face, both sides, with spokes cut in as a ring of quads.
  for (const side of [-1, 1]) {
    const faceX = side * hw * 0.92;
    const hub = mb.vertex(faceX, 0, 0, side, 0, 0, 0.5, 0.5);
    const ringOuter: number[] = [];
    for (let i = 0; i < segments; i++) {
      const a = (i / segments) * Math.PI * 2;
      ringOuter.push(
        mb.vertex(faceX, Math.cos(a) * rimRadius, Math.sin(a) * rimRadius, side, 0, 0, 0.5, 0.5),
      );
    }
    for (let i = 0; i < segments; i++) {
      const a = ringOuter[i];
      const b = ringOuter[(i + 1) % segments];
      if (side > 0) mb.tri(hub, a, b);
      else mb.tri(hub, b, a);
    }
    // Spokes as raised ribs.
    for (let s = 0; s < spokes; s++) {
      const a0 = (s / spokes) * Math.PI * 2;
      const a1 = ((s + 0.55) / spokes) * Math.PI * 2;
      const inner = rimRadius * 0.28;
      const v0 = mb.vertex(faceX, Math.cos(a0) * inner, Math.sin(a0) * inner, side, 0, 0);
      const v1 = mb.vertex(faceX, Math.cos(a1) * inner, Math.sin(a1) * inner, side, 0, 0);
      const v2 = mb.vertex(faceX, Math.cos(a1) * rimRadius, Math.sin(a1) * rimRadius, side, 0, 0);
      const v3 = mb.vertex(faceX, Math.cos(a0) * rimRadius, Math.sin(a0) * rimRadius, side, 0, 0);
      if (side > 0) mb.quad(v0, v1, v2, v3);
      else mb.quad(v3, v2, v1, v0);
    }
  }

  mb.computeNormals();
  return mb;
}

/**
 * An axis-aligned box centred on the origin. Used for track furniture, where
 * exact silhouettes matter less than the triangle count staying trivial.
 */
export function buildBox(w: number, h: number, d: number): MeshData {
  const hw = w / 2;
  const hh = h / 2;
  const hd = d / 2;
  const positions = new Float32Array([
    // +X
    hw, -hh, hd, hw, -hh, -hd, hw, hh, -hd, hw, hh, hd,
    // -X
    -hw, -hh, -hd, -hw, -hh, hd, -hw, hh, hd, -hw, hh, -hd,
    // +Y
    -hw, hh, hd, hw, hh, hd, hw, hh, -hd, -hw, hh, -hd,
    // -Y
    -hw, -hh, -hd, hw, -hh, -hd, hw, -hh, hd, -hw, -hh, hd,
    // +Z
    -hw, -hh, hd, hw, -hh, hd, hw, hh, hd, -hw, hh, hd,
    // -Z
    hw, -hh, -hd, -hw, -hh, -hd, -hw, hh, -hd, hw, hh, -hd,
  ]);
  const normals = new Float32Array([
    1, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0,
    -1, 0, 0, -1, 0, 0, -1, 0, 0, -1, 0, 0,
    0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0,
    0, -1, 0, 0, -1, 0, 0, -1, 0, 0, -1, 0,
    0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1,
    0, 0, -1, 0, 0, -1, 0, 0, -1, 0, 0, -1,
  ]);
  const uvs = new Float32Array(24);
  for (let i = 0; i < 8; i++) {
    uvs[i * 2] = i % 2;
    uvs[i * 2 + 1] = (i >> 1) % 2;
  }
  const indices = new Uint32Array(36);
  for (let f = 0; f < 6; f++) {
    const b = f * 4;
    indices.set([b, b + 1, b + 2, b, b + 2, b + 3], f * 6);
  }
  return { positions, normals, uvs, indices };
}

/**
 * The racing surface. A subdivided plane so that per-vertex lighting and the
 * SSR raymarch both have geometry to work with; the shader adds the surface
 * detail, so this stays coarse.
 */
/**
 * A subdivided plane in the XZ plane. `zStart` extends the surface BACKWARD
 * from z=0, which the drag strip needs: the chase camera trails the car by
 * ~13m, so a ground plane beginning at the start line leaves the camera hanging
 * off its end for the whole launch.
 */
export function buildGround(
  w: number,
  d: number,
  subdivisions: number,
  zStart = 0,
): MeshData {
  const mb = new MeshBuilder();
  const rows: number[][] = [];
  for (let j = 0; j <= subdivisions; j++) {
    const row: number[] = [];
    const z = zStart + (j / subdivisions) * d;
    for (let i = 0; i <= subdivisions; i++) {
      const x = (i / subdivisions) * w - w / 2;
      row.push(mb.vertex(x, 0, z, i / subdivisions, j / subdivisions));
    }
    rows.push(row);
  }
  for (let j = 0; j < subdivisions; j++) {
    for (let i = 0; i < subdivisions; i++) {
      const a = rows[j][i];
      const b = rows[j][i + 1];
      const c = rows[j + 1][i + 1];
      const d2 = rows[j + 1][i];
      mb.tri(a, d2, c);
      mb.tri(a, c, b);
    }
  }
  return mb.build();
}

/** A flat quad in the XZ plane, centred on x/z at height y. */
export function buildQuad(x: number, y: number, z: number, w: number, d: number): MeshData {
  const hw = w / 2;
  const hd = d / 2;
  const positions = new Float32Array([
    x - hw, y, z - hd,
    x + hw, y, z - hd,
    x + hw, y, z + hd,
    x - hw, y, z + hd,
  ]);
  const normals = new Float32Array([0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0]);
  const uvs = new Float32Array([0, 0, 1, 0, 1, 1, 0, 1]);
  const indices = new Uint32Array([0, 2, 1, 0, 3, 2]);
  return { positions, normals, uvs, indices };
}
