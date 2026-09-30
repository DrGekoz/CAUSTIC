/**
 * Procedural car construction.
 *
 * A car is a parameter block, not a model. Section-lofting: author ~14
 * cross-sections along the length, each a rounded rect with its own width,
 * floor height, roof height and corner roundness, then loft them into a mesh.
 *
 * Everything visual that varies between cars (silhouette, ride height, wheel
 * size, glasshouse, lights, wing) comes from that block, so adding a car costs
 * about forty lines of data rather than a modelling session.
 */

import { MeshBuilder, loft, ringPoints, buildWheel, MeshData } from './Mesh';
import { TorqueCurve } from '../physics/TorqueCurve';
import { TireParams, DEFAULT_TIRE } from '../physics/Tire';
import { DriveLayout, VehicleConfig, DEFAULT_VEHICLE_CONFIG } from '../physics/Vehicle';

export interface CarSection {
  /** Position along the car, 0 = rear bumper, 1 = front bumper. Metres. */
  z: number;
  halfWidth: number;
  floorY: number;
  roofY: number;
  /** 0 = square, 1 = fully rounded. */
  roundness: number;
  /** Roof width as a fraction of halfWidth, for tapered greenhouses. */
  topWidthScale: number;
}

export interface CarSpec {
  id: string;
  name: string;
  /** Display tier, 1..6. */
  tier: number;
  /** Handling character, shown in the garage. */
  character: string;
  length: number;
  width: number;
  height: number;
  wheelbase: number;
  trackWidth: number;
  wheelRadius: number;
  wheelWidth: number;
  mass: number;
  peakTorque: number;
  curve: TorqueCurve;
  drive: DriveLayout;
  frontSplit: number;
  dragArea: number;
  downforce: number;
  /** Purchase price in cash. 0 = owned from the start. */
  price: number;
  /** Base paint colour as a hex string. */
  paint: string;
  /** Silhouette control points. */
  sections: CarSection[];
  /** Rear wing, 0 = none, 1 = full. */
  wing: number;
  /** Front splitter, 0..1. */
  splitter: number;
  /** Ride height in metres. */
  rideHeight: number;
}

/**
 * Silhouette generator. Produces a plausible body from a handful of shape
 * parameters rather than a hand-authored list, so a new car is a few numbers.
 */
export function makeSections(p: {
  length: number;
  width: number;
  height: number;
  /** 0 = long low sleek, 1 = short tall upright. */
  boxiness: number;
  /** 0 = fastback, 1 = squared-off notchback. */
  notchback: number;
  /** 0 = cab-rearward (long bonnet), 1 = cab-forward (long nose). */
  cabForward: number;
  wheelbase: number;
  /** Floor height above the ground plane. */
  rideHeightBase: number;
}): CarSection[] {
  const L = p.length;
  const W = p.width * 0.5;
  const H = p.height;
  const floor = p.rideHeightBase ?? 0.16;
  const cabinStart = 0.18 + p.cabForward * 0.22;
  const cabinEnd = 0.78 - p.notchback * 0.1;
  const roofTop = H - p.boxiness * 0.06;

  // Sample z from rear to front with denser sampling around the cabin.
  const stops: number[] = [];
  for (let i = 0; i <= 16; i++) {
    const t = i / 16;
    stops.push(t);
  }

  return stops.map((t) => {
    const z = t * L;
    // Body width: narrow at both bumpers, full through the middle.
    const endTaper = Math.min(1, Math.min(t, 1 - t) / 0.12);
    const widthF = 0.62 + 0.38 * Math.pow(endTaper, 0.6);

    // Roofline: rises from the rear deck, peaks in the cabin, falls to the nose.
    let roofY: number;
    if (t < cabinStart) {
      // rear deck
      const k = t / Math.max(0.01, cabinStart);
      roofY = floor + (roofTop - floor) * 0.62 * k;
    } else if (t < cabinEnd) {
      roofY = roofTop;
    } else {
      // bonnet: slopes down to the nose
      const k = (t - cabinEnd) / Math.max(0.01, 1 - cabinEnd);
      roofY = roofTop + (floor + (roofTop - floor) * 0.42 - roofTop) * Math.pow(k, 0.75);
    }
    // Add a subtle crown to the roof.
    const crown = Math.sin(Math.PI * Math.min(1, Math.max(0, (t - cabinStart) / (cabinEnd - cabinStart)))) * 0.012;
    roofY += crown;

    const isCabin = t >= cabinStart && t <= cabinEnd;
    // The greenhouse tapers inward and is more rounded than the body.
    const topWidthScale = isCabin ? 0.78 - p.boxiness * 0.08 : 0.95;
    const roundness = isCabin ? 0.55 + p.boxiness * 0.2 : 0.34;

    return {
      z,
      halfWidth: W * widthF,
      floorY: floor,
      roofY: Math.max(floor + 0.05, roofY),
      roundness,
      topWidthScale,
    };
  });
}

const RING_SEGMENTS = 5;

/** Build the body shell for a spec. */
export function buildBody(spec: CarSpec, lod: 0 | 1 | 2 = 0): MeshData {
  const stride = lod === 0 ? 1 : lod === 1 ? 2 : 3;
  const segs = lod === 0 ? RING_SEGMENTS : Math.max(2, RING_SEGMENTS - (lod === 2 ? 2 : 1));
  const sections = spec.sections.filter((_, i) => i % stride === 0);
  if (sections.length < 2) return new MeshBuilder().build();

  const rings = sections.map((s) => {
    // Centre the body on its own origin so it can be placed by the scene graph.
    const pts = ringPoints(s.halfWidth, s.floorY, s.roofY, s.roundness, segs, s.topWidthScale);
    return pts.map(([x, y]) => [x, y] as [number, number]);
  });

  // loft() lays sections along +Z, but our sections carry their own z. Rewrite
  // the z coordinate from the section list after lofting.
  const mb = loft(rings, true, true);
  const pos = mb.build();
  // Apply the true z spacing (sections are not evenly spaced in our sampling).
  const data = rewriteZ(pos, sections);
  return data;
}

function rewriteZ(mesh: MeshData, sections: CarSection[]): MeshData {
  const n = mesh.positions.length / 3;
  const rings = sections.length;
  if (rings < 2) return mesh;
  const perRing = n / rings;
  for (let r = 0; r < rings; r++) {
    const z = sections[r].z;
    for (let i = 0; i < perRing; i++) {
      const vi = Math.floor(r * perRing + i);
      mesh.positions[vi * 3 + 2] = z;
    }
  }
  return mesh;
}

/** Rear wing as a thin lofted aerofoil. */
function buildWing(spec: CarSpec): MeshBuilder | null {
  if (spec.wing <= 0.01) return null;
  const mb = new MeshBuilder();
  const w = spec.width * 0.42 * spec.wing;
  const h = spec.rideHeight + 0.12 + spec.wing * 0.10;
  const chord = 0.16 + spec.wing * 0.14;
  const z = spec.length * 0.06;
  const thick = 0.022;

  // Simple aerofoil: a wedge with a rounded leading edge.
  const sections = 4;
  for (let i = 0; i <= 3; i++) {
    const k = i / 3;
    const c = z - chord * 0.5 + chord * k;
    const th = thick * (1 - Math.abs(k - 0.35) * 1.4);
    const a = mb.vertex(-w, h + th, c, 0, 1, 0, 0, 0);
    const b = mb.vertex(w, h + th, c, 0, 1, 0, 1, 0);
    const cI = mb.vertex(w, h - th, c, 0, 1, 0, 1, 1);
    const d = mb.vertex(-w, h - th, c, 0, 1, 0, 0, 1);
    if (i < 3) {
      mb.quad(a, b, cI, d);
      // underside
      const e = mb.vertex(-w, h - th, c, 0, -1, 0, 0, 1);
      const f = mb.vertex(w, h - th, c, 0, -1, 0, 1, 1);
      const g = mb.vertex(w, h - th * 0.2, c, 0, -1, 0, 1, 0);
      const h2 = mb.vertex(-w, h - th * 0.2, c, 0, -1, 0, 0, 0);
      mb.quad(h2, g, f, e);
    }
  }
  void sections;
  mb.computeNormals();
  return mb;
}

/** Front splitter: a flat lip under the nose. */
function buildSplitter(spec: CarSpec): MeshBuilder | null {
  if (spec.splitter <= 0.01) return null;
  const mb = new MeshBuilder();
  const w = spec.width * 0.46;
  const y = spec.rideHeight - 0.02;
  const z = spec.length * 0.965;
  const depth = 0.10 + spec.splitter * 0.14;
  const a = mb.vertex(-w, y, z, 0, 1, 0);
  const b = mb.vertex(w, y, z, 0, 1, 0);
  const c = mb.vertex(w * 0.9, y, z + depth, 0, 1, 0);
  const d = mb.vertex(-w * 0.9, y, z + depth, 0, 1, 0);
  mb.quad(a, b, c, d);
  mb.computeNormals();
  return mb;
}

/** Glasshouse: a separate material band so paint can be re-materialised. */
function buildGlass(spec: CarSpec): MeshBuilder | null {
  const cabin = spec.sections.filter((s) => s.topWidthScale < 0.85);
  if (cabin.length < 2) return null;
  const rings = cabin.map((s) =>
    ringPoints(s.halfWidth * 0.99, s.floorY, s.roofY, s.roundness, 3, s.topWidthScale).map(
      ([x, y]) => [x, y] as [number, number],
    ),
  );
  const mb = loft(rings, false, false);
  return mb;
}

/** Assemble the full car: body + parts. Wheels are separate and instanced. */
export interface CarMesh {
  body: MeshData;
  glass: MeshData | null;
  wing: MeshData | null;
  splitter: MeshData | null;
  wheel: MeshData;
  /** Wheel offsets in car-local space. */
  wheelOffsets: Array<[number, number, number]>;
}

export function buildCar(spec: CarSpec): CarMesh {
  const body = buildBody(spec, 0);

  const glassM = buildGlass(spec);
  const glass = glassM ? glassM.build() : null;

  const wingM = buildWing(spec);
  const wing = wingM ? wingM.build() : null;

  const splitM = buildSplitter(spec);
  const splitter = splitM ? splitM.build() : null;

  const wheel = buildWheel(spec.wheelRadius, spec.wheelWidth, 6).build();

  const hw = spec.trackWidth * 0.5;
  const frontZ = spec.wheelbase * 0.5;
  const rearZ = -spec.wheelbase * 0.5;
  const wheelOffsets: Array<[number, number, number]> = [
    [-hw, spec.wheelRadius, frontZ],
    [hw, spec.wheelRadius, frontZ],
    [-hw, spec.wheelRadius, rearZ],
    [hw, spec.wheelRadius, rearZ],
  ];

  return { body, glass, wing, splitter, wheel, wheelOffsets };
}

/** Turn a CarSpec into a physics VehicleConfig. */
export function toVehicleConfig(spec: CarSpec, upgrades: {
  torqueMult?: number;
  gripMult?: number;
  massMult?: number;
  redlineBonus?: number;
  curveP?: number;
} = {}): VehicleConfig {
  const tire: TireParams = {
    ...DEFAULT_TIRE,
    mu: DEFAULT_TIRE.mu * (upgrades.gripMult ?? 1),
  };
  return {
    ...DEFAULT_VEHICLE_CONFIG,
    mass: spec.mass * (upgrades.massMult ?? 1),
    peakTorque: spec.peakTorque * (upgrades.torqueMult ?? 1),
    curve: upgrades.redlineBonus
      ? { ...spec.curve, redline: spec.curve.redline + upgrades.redlineBonus, peakRpm: (spec.curve.p) * (spec.curve.redline + upgrades.redlineBonus) }
      : upgrades.curveP
        ? { ...spec.curve, p: upgrades.curveP, peakRpm: upgrades.curveP * spec.curve.redline }
        : spec.curve,
    drive: spec.drive,
    frontSplit: spec.frontSplit,
    dragArea: spec.dragArea,
    downforce: spec.downforce,
    tire,
    wheelbase: spec.wheelbase,
    trackWidth: spec.trackWidth,
    frontWeightBias: spec.drive === 'FWD' ? 0.6 : 0.53,
  };
}

export type { MeshData };
