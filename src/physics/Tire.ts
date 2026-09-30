/**
 * Tyre model — Pacejka-style magic formula on both axes.
 *
 *   F(s) = D * sin(C * atan(B*s - E*(B*s - atan(B*s))))
 *
 * D = mu * Fz — peak force scales with normal load. This is what makes weight
 * transfer matter, and therefore what makes the Launch Window pay off.
 *
 * STIFFNESS SOLVE. The naive choice B = tan(pi/(2C)) / peakSlip is wrong: that
 * identity assumes E = 0. With curvature E in the mix, the peak of the curve
 * lands well away from the intended slip (measured: 2.8x too high for
 * C=1.65, E=0.97, peak=0.12). Instead we solve the exact condition.
 *
 * Writing y(s) = B*s - E*(B*s - atan(B*s)), we have F = D*sin(C*atan(y)).
 * The maximum of sin(C*atan(y)) over y is 1, attained at y = tan(pi/(2C)).
 * So the peak of F lands on s = peakSlip exactly when:
 *
 *     y(peakSlip) = tan(pi / (2C))
 *
 * y is strictly increasing in B, so this has a unique root, found by bisection
 * (robust, no iteration-count or convergence-tolerance guesswork). With that
 * root the curve's maximum is exactly D*sin(C*atan(t)) = D, i.e. exactly
 * mu*normalLoad at exactly the configured peak slip.
 *
 * Combined slip uses a friction ellipse: both axes share one budget of D, so
 * braking hard mid-corner genuinely costs cornering grip.
 */

export interface TireParams {
  /** Peak friction coefficient. */
  mu: number;
  /** Shape factor, typically 1.3..1.8. */
  C: number;
  /** Curvature, typically 0.8..1.0. */
  E: number;
  /** Peak slip ratio. Sets Bx. */
  peakSlipRatio: number;
  /** Peak slip angle in radians. Sets By. */
  peakSlipAngle: number;
}

export const DEFAULT_TIRE: TireParams = {
  mu: 1.15,
  C: 1.65,
  E: 0.97,
  peakSlipRatio: 0.12,
  peakSlipAngle: 0.14,
};

/** The y value at which sin(C*atan(y)) is maximal. */
export function peakNormalizedSlip(C: number): number {
  return Math.tan(Math.PI / (2 * C));
}

/**
 * Stiffness B that puts the curve's peak exactly at `peakSlip`.
 * Solves y(peakSlip; B) = tan(pi/(2C)) by bisection on a bracketed interval.
 */
export function stiffnessForPeak(C: number, E: number, peakSlip: number): number {
  if (!(peakSlip > 0)) throw new Error(`peakSlip must be > 0, got ${peakSlip}`);
  const target = peakNormalizedSlip(C);
  const f = (B: number) => B * peakSlip - E * (B * peakSlip - Math.atan(B * peakSlip)) - target;
  let lo = 1e-9;
  let hi = 1;
  // Grow hi until the residual turns positive.
  for (let i = 0; i < 200 && f(hi) < 0; i++) hi *= 2;
  for (let i = 0; i < 100; i++) {
    const mid = 0.5 * (lo + hi);
    if (f(mid) < 0) lo = mid;
    else hi = mid;
  }
  return 0.5 * (lo + hi);
}

function magic(s: number, D: number, B: number, C: number, E: number): number {
  const y = B * s - E * (B * s - Math.atan(B * s));
  return D * Math.sin(C * Math.atan(y));
}

/** Longitudinal force (N) for a slip ratio at a given normal load (N). */
export function longitudinalForce(tire: TireParams, slipRatio: number, normalLoad: number): number {
  const D = tire.mu * Math.max(0, normalLoad);
  if (D <= 0) return 0;
  return magic(slipRatio, D, stiffnessForPeak(tire.C, tire.E, tire.peakSlipRatio), tire.C, tire.E);
}

/** Lateral force (N) for a slip angle (rad) at a given normal load (N). */
export function lateralForce(tire: TireParams, slipAngle: number, normalLoad: number): number {
  const D = tire.mu * Math.max(0, normalLoad);
  if (D <= 0) return 0;
  return magic(slipAngle, D, stiffnessForPeak(tire.C, tire.E, tire.peakSlipAngle), tire.C, tire.E);
}

/**
 * Friction-ellipse combined slip. Returns [Fx, Fy] sharing a single budget D.
 * Returns [0,0] with no load, so a lifted wheel transmits nothing.
 */
export function combinedForce(
  tire: TireParams,
  slipRatio: number,
  slipAngle: number,
  normalLoad: number,
): [number, number] {
  const D = tire.mu * Math.max(0, normalLoad);
  if (D <= 0) return [0, 0];
  const Bx = stiffnessForPeak(tire.C, tire.E, tire.peakSlipRatio);
  const By = stiffnessForPeak(tire.C, tire.E, tire.peakSlipAngle);
  const fx = magic(slipRatio, D, Bx, tire.C, tire.E);
  const fy = magic(slipAngle, D, By, tire.C, tire.E);
  const mag = Math.hypot(fx, fy);
  if (mag > D && mag > 1e-9) {
    const k = D / mag;
    return [fx * k, fy * k];
  }
  return [fx, fy];
}

/**
 * Local slope dF/dslip of the magic formula at a given slip, in newtons per
 * unit slip. Used to make the wheel integration unconditionally stable
 * (see Vehicle.tyreStiffness).
 *
 * Computed analytically rather than by finite difference, because at the exact
 * peak the derivative is zero by definition and a symmetric difference there
 * measures roundoff instead of the slope.
 */
export function tyreSlope(
  tire: TireParams,
  slip: number,
  normalLoad: number,
  surfaceTemp = 20,
  tractionMult = 1,
): number {
  const D = tire.mu * Math.max(0, normalLoad);
  if (D <= 0) return 0;
  let mu = tire.mu * tractionMult;
  mu *= 1 - Math.min(0.18, Math.max(0, (surfaceTemp - 95) / 380));
  const Dm = mu * Math.max(0, normalLoad);
  const B = stiffnessForPeak(tire.C, tire.E, tire.peakSlipRatio);
  const { C, E } = tire;
  const Bs = B * slip;
  // y = B s - E(B s - atan(B s));  y' = B (1 - E) + E*B/(1 + (Bs)^2)
  const y = Bs - E * (Bs - Math.atan(Bs));
  const yp = B * (1 - E) + (E * B) / (1 + Bs * Bs);
  // F = D sin(C atan y);  dF/ds = D C cos(C atan y)/(1+y^2) * y'
  const t = Math.atan(y);
  const dFds = (Dm * C * Math.cos(C * t) * yp) / (1 + y * y);
  return Math.max(0, dFds);
}
