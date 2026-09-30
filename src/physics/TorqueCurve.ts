/**
 * Engine efficiency / torque curve.
 *
 * DESIGN HISTORY — this file has been rewritten twice, both times because the
 * tests caught a genuine physics error, so both failures are recorded here.
 *
 * v1 was the order-4 polynomial from AntonC9018/race's
 * `concepts/engine_efficiency_equation/`. Solving g(1)=0, g(p)=1, g'(p)=0 with
 * the free parameter their own notes describe ("f(x) has to be of order 5")
 * drives the curve negative or non-concave for every peak position we actually
 * want (0.5..0.95). Confirmed numerically on the 4x4 and 5x5 systems.
 *
 * v2 used g(u) = (u/p)^a * ((1-u)/(1-p))^(a(1-p)/p), which satisfies all four
 * constraints exactly. But it has f(1) = 0, i.e. ZERO torque at the redline.
 * Combined with a rev limiter that clamps the engine to exactly the redline,
 * that made the engine unable to ever accelerate past the limiter: the car was
 * permanently pinned to whatever speed the gearing produced at redline, and
 * coasted at 48 kph for the rest of the run. The tests caught it.
 *
 * v3 (this file). A real engine makes strong torque right up to the redline and
 * then falls off; the limiter cuts fuel, it does not remove all torque. So the
 * curve is:
 *
 *   u <= p :  g(u) = (u/p)^a            fast rise, flat top (a < 1)
 *   u >  p :  g(u) = 1 - c*((u-p)/(1-p))^m   monotone fall
 *
 * Properties, all exact and all covered by tests:
 *   g(0) = 0
 *   g(p) = 1                    (unit peak, exactly at the configured rpm)
 *   g'(p) < 0 on the far side    (monotone decreasing after the peak)
 *   g(1) = 1 - c                (0.65 by default: real torque at the limiter)
 *   g'' < 0 for u < p           (concave rise, verified by second difference)
 *   continuous at p             (both branches are 1 there)
 *
 * Two knobs, both meaningful to a car person:
 *   p = peak location as a fraction of redline. Low p is a broad, flat,
 *       early plateau (big low-end torque). High p is a peaky screamer that
 *       must be kept on the boil.
 *   a = how fast the engine builds torque below the peak. Small a is a
 *       responsive, fat low-end; large a is a narrow-band engine.
 * Plus c, the fraction of peak torque still on tap at the redline.
 */

export interface TorqueCurve {
  /** Peak location as a fraction of redline, in (0,1). */
  p: number;
  /** Torque build rate below the peak. */
  a: number;
  /** Torque remaining at the redline, as a fraction of peak. */
  c: number;
  /** Falloff exponent past the peak. */
  m: number;
  /** Redline in rpm. */
  redline: number;
  /** rpm at peak torque (= p * redline). */
  peakRpm: number;
}

export const DEFAULT_FALLOFF = 0.35;
export const DEFAULT_FALLOFF_EXP = 1.4;
export const DEFAULT_BUILD = 0.55;

export function solveTorqueCurve(
  redline: number,
  p = 0.78,
  a = DEFAULT_BUILD,
  c = DEFAULT_FALLOFF,
  m = DEFAULT_FALLOFF_EXP,
): TorqueCurve {
  if (!(redline > 0)) throw new Error(`redline must be > 0, got ${redline}`);
  if (!(p > 0 && p < 1)) throw new Error(`p must be in (0,1), got ${p}`);
  if (!(a > 0)) throw new Error(`a must be > 0, got ${a}`);
  if (!(c >= 0 && c < 1)) throw new Error(`c must be in [0,1), got ${c}`);
  if (!(m > 0)) throw new Error(`m must be > 0, got ${m}`);
  return { p, a, c, m, redline, peakRpm: p * redline };
}

export function evalCurve(curve: TorqueCurve, rpm: number): number {
  const { p, a, c, m, redline } = curve;
  if (rpm <= 0) return 0;
  const u = rpm / redline;
  if (u >= 1) return Math.max(0, 1 - c);
  if (u <= p) return Math.pow(u / p, a);
  return 1 - c * Math.pow((u - p) / (1 - p), m);
}

/** Normalised efficiency 0..1 at a given rpm, clamped at both ends. */
export function efficiencyAt(curve: TorqueCurve, rpm: number): number {
  const v = evalCurve(curve, rpm);
  if (!Number.isFinite(v)) return 0;
  return Math.max(0, Math.min(1, v));
}

/** Where the launch "green band" sits: a window centred on peak torque. */
export function greenBand(
  curve: TorqueCurve,
  halfWidthFrac = 0.08,
): { lo: number; hi: number; centre: number } {
  const centre = curve.peakRpm;
  const half = curve.redline * halfWidthFrac;
  return { lo: Math.max(0, centre - half), hi: Math.min(curve.redline, centre + half), centre };
}

/**
 * The perfect-shift window, in ms. A broad, flat plateau (low p) is more
 * forgiving; a peaky engine demands precision.
 */
export function shiftWindow(
  curve: TorqueCurve,
  baseMs: number,
): { gold: number; goldWidth: number; outerWidth: number } {
  const forgiveness = 1 + (0.9 - curve.p) * 2.0;
  const total = baseMs * forgiveness;
  return {
    gold: total * 0.5,
    goldWidth: total * 0.12,
    outerWidth: total * 0.32,
  };
}
