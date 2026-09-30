import { describe, it, expect } from 'vitest';
import { solveTorqueCurve, evalCurve, efficiencyAt } from '../src/physics/TorqueCurve';
import {
  combinedForce,
  longitudinalForce,
  lateralForce,
  stiffnessForPeak,
  peakNormalizedSlip,
  DEFAULT_TIRE,
  type TireParams,
} from '../src/physics/Tire';

describe('torque curve constraints', () => {
  const shapes: Array<[number, number, number]> = [
    [6500, 0.72, 0.55],
    [8500, 0.9, 0.55],
    [7000, 0.78, 0.85],
    [5500, 0.5, 1.4],
    [9500, 0.95, 0.7],
    [6000, 0.65, 1.2],
  ];

  for (const [redline, p, a] of shapes) {
    it(`holds all constraints at redline=${redline} p=${p} a=${a}`, () => {
      const c = solveTorqueCurve(redline, p, a);
      expect(evalCurve(c, 0)).toBe(0);
      // The engine must still make real torque at the redline, otherwise a
      // limiter that clamps rpm to the redline traps the car permanently.
      expect(evalCurve(c, redline)).toBeCloseTo(1 - c.c, 9);
      expect(evalCurve(c, c.peakRpm)).toBeCloseTo(1, 9);
    });
  }

  it('has its maximum exactly at peakRpm for every shape', () => {
    for (const [redline, p, a] of shapes) {
      const c = solveTorqueCurve(redline, p, a);
      let best = -1;
      let bestRpm = 0;
      for (let rpm = 0; rpm <= redline; rpm += 5) {
        const v = evalCurve(c, rpm);
        if (v > best) {
          best = v;
          bestRpm = rpm;
        }
      }
      expect(bestRpm).toBeCloseTo(c.peakRpm, 0);
      expect(best).toBeCloseTo(1, 3);
    }
  });

  it('never goes negative anywhere in the rev range', () => {
    for (const [redline, p, a] of shapes) {
      const c = solveTorqueCurve(redline, p, a);
      for (let rpm = 0; rpm <= redline * 1.05; rpm += 10) {
        expect(evalCurve(c, rpm)).toBeGreaterThanOrEqual(0);
      }
    }
  });

  it('is strictly increasing below the peak and decreasing above', () => {
    const c = solveTorqueCurve(7000, 0.78, 0.55);
    for (let rpm = 100; rpm < c.peakRpm - 150; rpm += 50) {
      expect(evalCurve(c, rpm + 50)).toBeGreaterThan(evalCurve(c, rpm));
    }
    for (let rpm = Math.ceil(c.peakRpm / 100) * 100 + 100; rpm < 6950; rpm += 50) {
      expect(evalCurve(c, rpm + 50)).toBeLessThan(evalCurve(c, rpm));
    }
  });

  it('still makes substantial torque at the redline', () => {
    for (const [redline, p, a] of shapes) {
      const c = solveTorqueCurve(redline, p, a);
      const atRedline = evalCurve(c, redline);
      expect(atRedline).toBeGreaterThan(0.5);
      // ...and past it, it holds rather than collapsing to zero.
      expect(evalCurve(c, redline * 1.2)).toBeGreaterThan(0.4);
    }
  });

  it('is strictly concave across the usable range', () => {
    // f is log-concave by construction, so g'' < 0. Verify numerically away
    // from the endpoints where finite differences are ill-conditioned.
    for (const [redline, p, a] of shapes) {
      const c = solveTorqueCurve(redline, p, a);
      const h = 50;
      for (let rpm = redline * 0.06; rpm < c.peakRpm - 100; rpm += 100) {
        const d2 = (evalCurve(c, rpm + h) - 2 * evalCurve(c, rpm) + evalCurve(c, rpm - h)) / (h * h);
        // Tolerance absorbs the ~1e-7 rounding of a second difference on O(1) values.
        expect(d2).toBeLessThan(1e-5);
      }
    }
  });

  it('returns finite efficiency across a wide sweep', () => {
    const c = solveTorqueCurve(8500, 0.88, 0.55);
    for (let rpm = 0; rpm <= 12000; rpm += 25) {
      const e = efficiencyAt(c, rpm);
      expect(Number.isFinite(e)).toBe(true);
      expect(e).toBeGreaterThanOrEqual(0);
      expect(e).toBeLessThanOrEqual(1);
    }
  });

  it('peak torque power scales with redline', () => {
    const low = solveTorqueCurve(6500, 0.78, 0.55);
    const high = solveTorqueCurve(9000, 0.78, 0.55);
    // peak power ~ peakTorque * peakRpm
    expect(high.peakRpm).toBeGreaterThan(low.peakRpm);
    expect(evalCurve(high, high.peakRpm)).toBeCloseTo(1, 9);
  });

  it('rejects invalid parameters', () => {
    expect(() => solveTorqueCurve(0)).toThrow();
    expect(() => solveTorqueCurve(7000, 0)).toThrow();
    expect(() => solveTorqueCurve(7000, 1)).toThrow();
    expect(() => solveTorqueCurve(7000, 0.5, 0)).toThrow();
  });
});

describe('tyre model', () => {
  it('scales force linearly with normal load', () => {
    const f1 = longitudinalForce(DEFAULT_TIRE, 0.05, 3000);
    const f2 = longitudinalForce(DEFAULT_TIRE, 0.05, 6000);
    expect(f2 / f1).toBeCloseTo(2, 6);
  });

  it('peaks exactly at the configured slip ratio', () => {
    let best = -Infinity;
    let bestSlip = 0;
    for (let s = 0.001; s < 0.8; s += 0.0005) {
      const f = longitudinalForce(DEFAULT_TIRE, s, 4000);
      if (f > best) {
        best = f;
        bestSlip = s;
      }
    }
    expect(bestSlip).toBeCloseTo(DEFAULT_TIRE.peakSlipRatio, 2);
  });

  it('peaks exactly at the configured slip angle', () => {
    let best = -Infinity;
    let bestSlip = 0;
    for (let s = 0.001; s < 0.8; s += 0.0005) {
      const f = lateralForce(DEFAULT_TIRE, s, 4000);
      if (f > best) {
        best = f;
        bestSlip = s;
      }
    }
    expect(bestSlip).toBeCloseTo(DEFAULT_TIRE.peakSlipAngle, 2);
  });

  it('peak force equals mu * load', () => {
    const N = 4000;
    const f = longitudinalForce(DEFAULT_TIRE, DEFAULT_TIRE.peakSlipRatio, N);
    expect(f).toBeCloseTo(DEFAULT_TIRE.mu * N, 2);
  });

  it('returns zero force with zero load', () => {
    expect(longitudinalForce(DEFAULT_TIRE, 0.05, 0)).toBe(0);
    expect(combinedForce(DEFAULT_TIRE, 0.1, 0.1, 0)).toEqual([0, 0]);
  });

  it('friction ellipse caps the combined vector at mu*N', () => {
    const N = 4000;
    const D = DEFAULT_TIRE.mu * N;
    for (const [sx, sy] of [
      [0.5, 0.5],
      [0.05, 0.5],
      [0.3, 0.02],
      [0.02, 0.02],
    ]) {
      const [fx, fy] = combinedForce(DEFAULT_TIRE, sx, sy, N);
      expect(Math.hypot(fx, fy)).toBeLessThanOrEqual(D + 1e-6);
    }
  });

  it('falls off past the peak', () => {
    const peak = lateralForce(DEFAULT_TIRE, DEFAULT_TIRE.peakSlipAngle, 4000);
    const far = lateralForce(DEFAULT_TIRE, 0.9, 4000);
    expect(far).toBeLessThan(peak);
  });

  it('stiffness solve places the curve peak at exactly mu*N', () => {
    // The real invariant: at s = peakSlip the magic formula equals D exactly,
    // because the solve forces y(peakSlip) = tan(pi/2C) where sin(C*atan y)=1.
    for (const [C, E, peak] of [
      [1.65, 0.97, 0.12],
      [1.4, 0.9, 0.05],
      [1.8, 1.0, 0.3],
    ] as const) {
      const B = stiffnessForPeak(C, E, peak);
      const y = B * peak - E * (B * peak - Math.atan(B * peak));
      expect(y).toBeCloseTo(peakNormalizedSlip(C), 7);
      const tire: TireParams = { mu: 1.15, C, E, peakSlipRatio: peak, peakSlipAngle: peak };
      expect(longitudinalForce(tire, peak, 4000)).toBeCloseTo(1.15 * 4000, 3);
    }
  });
});
