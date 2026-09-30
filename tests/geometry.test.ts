import { describe, it, expect } from 'vitest';
import { MeshBuilder, loft, ringPoints, buildWheel } from '../src/geometry/Mesh';
import { buildCar, buildBody, toVehicleConfig } from '../src/geometry/Car';
import { CARS, CAR_BY_ID } from '../src/game/data/cars';

function checkMesh(label: string, m: { positions: Float32Array; normals: Float32Array; indices: Uint32Array }) {
  const verts = m.positions.length / 3;
  expect(verts, `${label} has vertices`).toBeGreaterThan(0);
  expect(m.positions.length % 3).toBe(0);
  expect(m.normals.length).toBe(m.positions.length);
  expect(m.indices.length % 3).toBe(0);
  expect(m.indices.length / 3, `${label} has triangles`).toBeGreaterThan(0);

  for (let i = 0; i < m.positions.length; i++) {
    expect(Number.isFinite(m.positions[i]), `${label} position ${i} finite`).toBe(true);
  }
  for (let i = 0; i < m.normals.length; i += 3) {
    const len = Math.hypot(m.normals[i], m.normals[i + 1], m.normals[i + 2]);
    expect(len, `${label} normal ${i / 3} is unit length`).toBeGreaterThan(0.99);
    expect(len, `${label} normal ${i / 3} is unit length`).toBeLessThan(1.01);
  }
  for (let i = 0; i < m.indices.length; i++) {
    expect(m.indices[i], `${label} index in range`).toBeLessThan(verts);
    expect(m.indices[i]).toBeGreaterThanOrEqual(0);
  }
  // No degenerate triangles: every triangle must have area.
  let degenerate = 0;
  for (let t = 0; t < m.indices.length; t += 3) {
    const a = m.indices[t] * 3;
    const b = m.indices[t + 1] * 3;
    const c = m.indices[t + 2] * 3;
    const e1 = [m.positions[b] - m.positions[a], m.positions[b + 1] - m.positions[a + 1], m.positions[b + 2] - m.positions[a + 2]];
    const e2 = [m.positions[c] - m.positions[a], m.positions[c + 1] - m.positions[a + 1], m.positions[c + 2] - m.positions[a + 2]];
    const cx = e1[1] * e2[2] - e1[2] * e2[1];
    const cy = e1[2] * e2[0] - e1[0] * e2[2];
    const cz = e1[0] * e2[1] - e1[1] * e2[0];
    if (Math.hypot(cx, cy, cz) < 1e-10) degenerate++;
  }
  expect(degenerate, `${label} degenerate triangles`).toBeLessThan(m.indices.length / 3 * 0.1);
}

describe('mesh builders', () => {
  it('computes unit-length smooth normals', () => {
    const mb = new MeshBuilder();
    const a = mb.vertex(0, 0, 0);
    const b = mb.vertex(1, 0, 0);
    const c = mb.vertex(0, 1, 0);
    mb.tri(a, b, c);
    mb.computeNormals();
    const m = mb.build();
    for (let i = 0; i < m.normals.length; i += 3) {
      expect(Math.hypot(m.normals[i], m.normals[i + 1], m.normals[i + 2])).toBeCloseTo(1, 5);
    }
    // A flat triangle in the XY plane has a +Z normal.
    expect(m.normals[2]).toBeCloseTo(1, 5);
  });

  it('lofts a tube with consistent winding', () => {
    const rings = [];
    for (let i = 0; i < 6; i++) rings.push(ringPoints(1, 0, 1, 0.3, 3));
    const m = loft(rings).build();
    checkMesh('loft tube', m);
  });

  it('ringPoints returns a closed outline of consistent size', () => {
    for (const [hw, fy, ry, r] of [
      [1, 0, 1.4, 0.3],
      [0.8, 0.2, 1.0, 0.8],
    ]) {
      for (const seg of [2, 3, 5]) {
        const pts = ringPoints(hw, fy, ry, r, seg);
        expect(pts.length).toBeGreaterThan(8);
        for (const [x, y] of pts) {
          expect(Number.isFinite(x)).toBe(true);
          expect(y).toBeGreaterThanOrEqual(fy - 1e-6);
          expect(y).toBeLessThanOrEqual(ry + 1e-6);
          expect(Math.abs(x)).toBeLessThanOrEqual(hw * 1.05);
        }
      }
    }
  });

  it('builds a valid wheel', () => {
    const m = buildWheel(0.33, 0.26, 6).build();
    checkMesh('wheel', m);
  });

  it('wheel size scales with the radius', () => {
    const small = buildWheel(0.28, 0.2, 5).build();
    const large = buildWheel(0.4, 0.34, 5).build();
    let smallMax = 0;
    let largeMax = 0;
    for (let i = 0; i < small.positions.length; i += 3) {
      smallMax = Math.max(smallMax, Math.hypot(small.positions[i + 1], small.positions[i + 2]));
    }
    for (let i = 0; i < large.positions.length; i += 3) {
      largeMax = Math.max(largeMax, Math.hypot(large.positions[i + 1], large.positions[i + 2]));
    }
    expect(largeMax).toBeGreaterThan(smallMax);
    expect(smallMax).toBeCloseTo(0.28, 1);
    expect(largeMax).toBeCloseTo(0.4, 1);
  });
});

describe('the roster', () => {
  it('has twelve unique cars', () => {
    expect(CARS).toHaveLength(12);
    expect(new Set(CARS.map((c) => c.id)).size).toBe(12);
    expect(new Set(CARS.map((c) => c.name)).size).toBe(12);
  });

  it('covers all six tiers', () => {
    const tiers = new Set(CARS.map((c) => c.tier));
    expect(tiers).toEqual(new Set([1, 2, 3, 4, 5, 6]));
  });

  it('has a plausible price ladder', () => {
    const prices = CARS.map((c) => c.price).sort((a, b) => a - b);
    expect(prices[0]).toBe(0); // one starter car is free
    for (let i = 1; i < prices.length; i++) {
      expect(prices[i]).toBeGreaterThan(prices[i - 1]);
    }
    expect(prices[prices.length - 1]).toBeGreaterThan(1000000);
  });

  it('has sane physical dimensions on every car', () => {
    for (const c of CARS) {
      expect(c.length, `${c.name} length`).toBeGreaterThan(3.5);
      expect(c.length).toBeLessThan(5.2);
      expect(c.width).toBeGreaterThan(1.5);
      expect(c.width).toBeLessThan(2.1);
      expect(c.height).toBeGreaterThan(1.0);
      expect(c.height).toBeLessThan(1.8);
      expect(c.wheelbase).toBeLessThan(c.length);
      expect(c.trackWidth).toBeLessThan(c.width);
      expect(c.mass).toBeGreaterThan(900);
      expect(c.mass).toBeLessThan(2200);
      expect(c.peakTorque).toBeGreaterThan(200);
      expect(c.peakTorque).toBeLessThan(1400);
      expect(c.wheelRadius).toBeGreaterThan(0.25);
      expect(c.wheelRadius).toBeLessThan(0.4);
    }
  });

  it('is indexable by id', () => {
    expect(CAR_BY_ID.rusty8.name).toBe('Rusty 8');
    expect(CAR_BY_ID.nightlaw.tier).toBe(6);
  });
});

describe('car geometry', () => {
  it('builds a valid body for every car in the roster', () => {
    for (const c of CARS) {
      const m = buildBody(c, 0);
      checkMesh(`${c.name} body`, m);
    }
  });

  it('produces more geometry at LOD0 than at LOD2', () => {
    const c = CARS[0];
    const lod0 = buildBody(c, 0);
    const lod2 = buildBody(c, 2);
    expect(lod0.indices.length).toBeGreaterThan(lod2.indices.length);
  });

  it('spans the car length and width', () => {
    for (const c of CARS) {
      const m = buildBody(c, 0);
      let minZ = Infinity;
      let maxZ = -Infinity;
      let maxX = -Infinity;
      for (let i = 0; i < m.positions.length; i += 3) {
        minZ = Math.min(minZ, m.positions[i + 2]);
        maxZ = Math.max(maxZ, m.positions[i + 2]);
        maxX = Math.max(maxX, Math.abs(m.positions[i]));
      }
      expect(maxZ - minZ, `${c.name} spans its length`).toBeCloseTo(c.length, 1);
      expect(maxX * 2, `${c.name} spans its width`).toBeLessThanOrEqual(c.width * 1.1);
    }
  });

  it('assembles a complete car with wheels placed on the wheelbase', () => {
    for (const c of CARS) {
      const car = buildCar(c);
      checkMesh(`${c.name} assembled body`, car.body);
      checkMesh(`${c.name} wheel`, car.wheel);
      expect(car.wheelOffsets).toHaveLength(4);
      const zs = car.wheelOffsets.map((o) => o[2]);
      expect(Math.max(...zs) - Math.min(...zs)).toBeCloseTo(c.wheelbase, 5);
      if (c.wing > 0.01) expect(car.wing, `${c.name} has a wing`).not.toBeNull();
      else expect(car.wing).toBeNull();
      if (c.splitter > 0.01) expect(car.splitter, `${c.name} has a splitter`).not.toBeNull();
      else expect(car.splitter).toBeNull();
    }
  });

  it('is deterministic: the same spec builds identical geometry', () => {
    const c = CARS[3];
    const a = buildBody(c, 0);
    const b = buildBody(c, 0);
    expect(Array.from(a.positions)).toEqual(Array.from(b.positions));
    expect(Array.from(a.indices)).toEqual(Array.from(b.indices));
  });

  it('builds every car without exceeding a sane triangle budget', () => {
    for (const c of CARS) {
      const tris = buildBody(c, 0).indices.length / 3;
      expect(tris, `${c.name} triangle count`).toBeLessThan(20000);
      expect(tris).toBeGreaterThan(200);
    }
  });
});

describe('physics config from a car', () => {
  it('maps a spec into a valid vehicle config', () => {
    for (const c of CARS) {
      const cfg = toVehicleConfig(c);
      expect(cfg.mass).toBe(c.mass);
      expect(cfg.peakTorque).toBe(c.peakTorque);
      expect(cfg.drive).toBe(c.drive);
      expect(cfg.curve.redline).toBe(c.curve.redline);
      expect(cfg.gearRatios.length).toBeGreaterThan(3);
    }
  });

  it('applies tuning multipliers', () => {
    const c = CARS[0];
    const tuned = toVehicleConfig(c, { torqueMult: 1.5, gripMult: 1.2, massMult: 0.9, redlineBonus: 500 });
    expect(tuned.peakTorque).toBeCloseTo(c.peakTorque * 1.5);
    expect(tuned.tire.mu).toBeCloseTo(1.15 * 1.2, 6);
    expect(tuned.mass).toBeCloseTo(c.mass * 0.9);
    expect(tuned.curve.redline).toBe(c.curve.redline + 500);
    expect(tuned.curve.peakRpm).toBeCloseTo(c.curve.p * (c.curve.redline + 500));
  });

  it('gives a front-engine car a front weight bias', () => {
    const hatch = CARS.find((c) => c.id === 'hatch')!;
    expect(toVehicleConfig(hatch).frontWeightBias).toBeGreaterThan(0.58);
  });
});
