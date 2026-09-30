/**
 * The strip.
 *
 * A drag strip is a very simple piece of geometry and a very specific piece of
 * art direction: two lanes of dark rubbered concrete, a white staging beam, a
 * set of tree lights on towers, and enough haze to catch the beams. Getting the
 * lighting right matters more than the geometry, because the scene is mostly
 * lit pools in the dark.
 */

import { mat4 } from 'gl-matrix';
import { buildBox, buildGround, buildQuad, type MeshData } from '../geometry/Mesh';
import { GPUMesh } from '../render/GL';

export const STRIP_HALF_WIDTH = 4.6; // metres from centre to each lane edge
export const LANE_CENTRE = 2.3;
export const START_Z = 0;
export const FINISH_Z = 402.34; // 1320 ft
export const BEACON_Z = 120; // tree, classic 120' point

export interface StripMeshData {
  ground: MeshData;
  lanes: MeshData;
  stagingBeam: MeshData;
  walls: MeshData;
  lightTowers: MeshData;
  trees: MeshData;
  stands: MeshData;
  barriers: MeshData;
}

export function buildStrip(): StripMeshData {
  const width = STRIP_HALF_WIDTH * 2 + 8;
  const depth = 460;

  return {
    // The racing surface: dark, low roughness, so it reflects the trees.
    ground: buildGround(width, depth, 64),
    // Painted lane markings, very slightly proud of the surface.
    lanes: buildLaneMarkings(),
    // The staging beam the player stages against.
    stagingBeam: buildQuad(0, 0.001, 0.1, width - 1.0, 0.22),
    // Side walls keep the light pools from leaking.
    walls: buildWalls(width, depth),
    lightTowers: buildLightTowers(),
    trees: buildTrees(),
    stands: buildStands(depth),
    barriers: buildBarriers(width, depth),
  };
}

function buildLaneMarkings(): MeshData {
  const positions: number[] = [];
  const normals: number[] = [];
  const uvs: number[] = [];
  const indices: number[] = [];
  const y = 0.004;

  const pushQuad = (
    x0: number, z0: number, x1: number, z1: number,
  ) => {
    const base = positions.length / 3;
    positions.push(
      x0, y, z0, x1, y, z0, x1, y, z1, x0, y, z1,
    );
    for (let i = 0; i < 4; i++) normals.push(0, 1, 0);
    uvs.push(0, 0, 1, 0, 1, 1, 0, 1);
    indices.push(base, base + 2, base + 1, base, base + 3, base + 2);
  };

  // Centre divider, dashed.
  for (let z = START_Z; z < FINISH_Z; z += 8) {
    pushQuad(-0.09, z, 0.09, z + 4.2);
  }
  // Lane edges.
  pushQuad(-STRIP_HALF_WIDTH, START_Z, -STRIP_HALF_WIDTH + 0.12, FINISH_Z);
  pushQuad(STRIP_HALF_WIDTH - 0.12, START_Z, STRIP_HALF_WIDTH, FINISH_Z);
  // Distance markers every 60ft-ish for readability of speed.
  for (let ft = 60; ft <= 1320; ft += 60) {
    const z = ft * 0.3048;
    pushQuad(-2.9, z, -2.5, z + 0.2);
    pushQuad(2.5, z, 2.9, z + 0.2);
  }
  // Finish line.
  pushQuad(-STRIP_HALF_WIDTH, FINISH_Z, STRIP_HALF_WIDTH, FINISH_Z + 0.35);

  return {
    positions: new Float32Array(positions),
    normals: new Float32Array(normals),
    uvs: new Float32Array(uvs),
    indices: new Uint32Array(indices),
  };
}

function buildWalls(width: number, depth: number): MeshData {
  const positions: number[] = [];
  const normals: number[] = [];
  const uvs: number[] = [];
  const indices: number[] = [];
  const h = 6;

  const side = (x: number, nx: number) => {
    const base = positions.length / 3;
    positions.push(
      x, 0, START_Z - 10,
      x, h, START_Z - 10,
      x, h, depth,
      x, 0, depth,
    );
    for (let i = 0; i < 4; i++) normals.push(nx, 0, 0);
    uvs.push(0, 0, 0, 1, 4, 1, 4, 0);
    indices.push(base, base + 1, base + 2, base, base + 2, base + 3);
  };
  side(-width / 2 + 1, 1);
  side(width / 2 - 1, -1);
  void FINISH_Z;
  return {
    positions: new Float32Array(positions),
    normals: new Float32Array(normals),
    uvs: new Float32Array(uvs),
    indices: new Uint32Array(indices),
  };
}

/**
 * Eight light towers, four per side, evenly spaced down the strip. These are the
 * scene's only significant light sources.
 */
function buildLightTowers(): MeshData {
  const parts: MeshData[] = [];
  const zs = [40, 140, 240, 340];
  for (const z of zs) {
    for (const side of [-1, 1]) {
      const x = side * (STRIP_HALF_WIDTH + 3.2);
      const h = 11;
      // Pole.
      const pole = buildBox(0.22, h, 0.22);
      parts.push(translate(pole, x, h / 2, z));
      // Head housing.
      const head = buildBox(1.5, 0.45, 0.5);
      parts.push(translate(head, x - side * 0.6, h, z));
    }
  }
  return mergeGeometries(parts);
}

/** The classic drag "tree": three red, two green, one white bulb per lane. */
function buildTrees(): MeshData {
  const parts: MeshData[] = [];
  for (const side of [-1, 1]) {
    const x = side * LANE_CENTRE;
    // Pole between the lanes at the starting line.
    const pole = buildBox(0.18, 5.2, 0.18);
    parts.push(translate(pole, x + side * 0.0, 2.6, 0.0));
    // Three bulb bars: red (0.42m), green (0.76m), white (1.1m).
    for (let i = 0; i < 3; i++) {
      const bar = buildBox(0.5, 0.16, 0.16);
      parts.push(translate(bar, x, 5.0 - i * 0.42, 0.0));
    }
  }
  return mergeGeometries(parts);
}

function buildStands(depth: number): MeshData {
  const parts: MeshData[] = [];
  for (const side of [-1, 1]) {
    for (let i = 0; i < 6; i++) {
      const z = 20 + i * 60;
      if (z > depth) break;
      const block = buildBox(9, 3.2 + i * 0.4, 26);
      parts.push(translate(block, side * (STRIP_HALF_WIDTH + 9), (3.2 + i * 0.4) / 2, z));
    }
  }
  return mergeGeometries(parts);
}

function buildBarriers(width: number, depth: number): MeshData {
  const parts: MeshData[] = [];
  for (const side of [-1, 1]) {
    const rail = buildBox(0.12, 0.5, depth);
    parts.push(translate(rail, side * (STRIP_HALF_WIDTH + 1.4), 0.5, depth / 2));
  }
  void width;
  return mergeGeometries(parts);
}

function translate(g: MeshData, x: number, y: number, z: number): MeshData {
  const positions = new Float32Array(g.positions.length);
  for (let i = 0; i < g.positions.length; i += 3) {
    positions[i] = g.positions[i] + x;
    positions[i + 1] = g.positions[i + 1] + y;
    positions[i + 2] = g.positions[i + 2] + z;
  }
  return { ...g, positions };
}

export function mergeGeometries(list: MeshData[]): MeshData {
  let vTotal = 0;
  let iTotal = 0;
  for (const g of list) {
    vTotal += g.positions.length / 3;
    iTotal += g.indices.length;
  }
  const positions = new Float32Array(vTotal * 3);
  const normals = new Float32Array(vTotal * 3);
  const uvs = new Float32Array(vTotal * 2);
  const indices = new Uint32Array(iTotal);
  let vo = 0;
  let io = 0;
  for (const g of list) {
    const n = g.positions.length / 3;
    positions.set(g.positions, vo * 3);
    normals.set(g.normals, vo * 3);
    uvs.set(g.uvs, vo * 2);
    for (let i = 0; i < g.indices.length; i++) indices[io + i] = g.indices[i] + vo;
    vo += n;
    io += g.indices.length;
  }
  return { positions, normals, uvs, indices };
}

/**
 * The night lighting rig. Two rows of sodium tower lights plus a cool fill from
 * the sky, which is what makes the paint read as paint.
 */
export function buildLights(): Array<{
  position: [number, number, number];
  color: [number, number, number];
  range: number;
  intensity: number;
}> {
  const lights: Array<{
    position: [number, number, number];
    color: [number, number, number];
    range: number;
    intensity: number;
  }> = [];
  const zs = [40, 140, 240, 340];
  for (const z of zs) {
    for (const side of [-1, 1]) {
      lights.push({
        position: [side * (STRIP_HALF_WIDTH + 2.6), 10.6, z],
        color: [1.0, 0.86, 0.66],
        range: 78,
        intensity: 900,
      });
    }
  }
  return lights;
}

export function uploadStrip(gl: WebGL2RenderingContext, s: StripMeshData): Record<string, GPUMesh> {
  const out: Record<string, GPUMesh> = {};
  for (const [k, v] of Object.entries(s)) {
    out[k] = new GPUMesh(gl, v.positions, v.normals, v.uvs, v.indices);
  }
  return out;
}

export const identity = (): Float32Array => mat4.create() as unknown as Float32Array;
