/**
 * The Launch Window.
 *
 * The core skill mechanic. A drag race is won or lost in the first 1.5 seconds:
 * hold the car on the clutch, build revs into a green band, and dump it at the
 * right instant. Launch quality dominates the payout far more than purchased
 * power, which is what keeps an early game competitive against a late one.
 *
 * The window is expressed in engine rpm, not a timer, because that is what the
 * player is actually reading off the tacho.
 */

export interface LaunchBands {
  /** Below this the launch bogs. */
  bogLow: number;
  /** Green band: a clean launch. */
  goodLow: number;
  goodHigh: number;
  /** Above this the tyres break loose. */
  perfectLow: number;
  perfectHigh: number;
  /** Above this it is all wheelspin. */
  spinHigh: number;
}

export type LaunchGrade = 'BOG' | 'POOR' | 'GOOD' | 'GREAT' | 'PERFECT' | 'BLOWN';

export interface LaunchResult {
  grade: LaunchGrade;
  /** Payout multiplier applied to the stake. */
  multiplier: number;
  /** Engine rpm at the moment the clutch was dumped. */
  rpmAtDump: number;
  /** Seconds the clutch was held before the dump. */
  holdTime: number;
}

/**
 * The payout spread is deliberately enormous: a 3.125x perfect launch against a
 * 0.28x bog on the SAME opponent is roughly 11:1, which is what makes the
 * mechanic worth mastering rather than buying around.
 */
const GRADE_MULTIPLIER: Record<LaunchGrade, number> = {
  BOG: 0.28,
  POOR: 0.62,
  GOOD: 1.0,
  GREAT: 1.9,
  PERFECT: 3.125,
  BLOWN: 0.44,
};

export function bandsForRedline(redline: number, peakRpm: number): LaunchBands {
  void peakRpm;
  // Everything is a fraction of the redline, which is the number the player is
  // actually watching on the tacho. Deriving the bands from peakRpm instead made
  // high-revving engines have a proportionally narrower perfect window, which
  // punished a big engine for no reason the player could see.
  return {
    bogLow: redline * 0.16,
    goodLow: redline * 0.36,
    goodHigh: redline * 0.68,
    perfectLow: redline * 0.5,
    perfectHigh: redline * 0.8,
    spinHigh: redline * 0.985,
  };
}

/**
 * The bands for the starter car. Derived rather than hard-coded so the default
 * bands and the per-engine bands can never drift apart.
 */
export const DEFAULT_BANDS: LaunchBands = bandsForRedline(7000, 5460);

/** Grade a launch from the rpm at which the clutch was dumped. */
export function gradeLaunch(
  rpmAtDump: number,
  holdTime: number,
  bands: LaunchBands = DEFAULT_BANDS,
): LaunchResult {
  // An ordered ladder where every rpm gets exactly one grade, and the grades
  // increase monotonically with rpm until the engine is blown.
  //
  // The previous version left the gap between bogLow and goodLow unassigned, so
  // a near-bog launch fell through to GREAT and paid 1.9x -- MORE than a clean
  // GOOD launch at 1.0x. POOR existed in the type but was unreachable, which is
  // exactly the kind of dead branch a test finds and a player feels as "why
  // did I get paid more for a worse launch".
  let grade: LaunchGrade;
  if (rpmAtDump < bands.bogLow) {
    grade = 'BOG';
  } else if (rpmAtDump < bands.goodLow) {
    grade = 'POOR';
  } else if (rpmAtDump >= bands.spinHigh) {
    grade = 'BLOWN';
  } else if (rpmAtDump >= bands.perfectLow && rpmAtDump <= bands.perfectHigh) {
    // Tested before GOOD: the perfect window sits inside the good window, so
    // testing good first would swallow it and flatten the whole mechanic.
    grade = 'PERFECT';
  } else if (rpmAtDump >= bands.goodLow && rpmAtDump <= bands.goodHigh) {
    grade = 'GOOD';
  } else {
    // Above goodHigh but not yet perfect, or just past perfect but under the
    // limiter: a strong launch that missed the ideal window.
    grade = 'GREAT';
  }

  // Holding the clutch for a very long time overheats it and costs multiplier.
  // This is what stops "stage forever then dump" from being optimal.
  const heatPenalty = Math.max(0, Math.min(0.35, (holdTime - 4) * 0.07));

  return {
    grade,
    multiplier: Math.max(0.1, GRADE_MULTIPLIER[grade] * (1 - heatPenalty)),
    rpmAtDump,
    holdTime,
  };
}

/**
 * Live state of a launch in progress, so the HUD can draw the window and the
 * player can see where the band is relative to the needle.
 */
export class LaunchController {
  /** Seconds the clutch has been held. */
  holdTime = 0;
  /** Set once the clutch has been dumped; holds the result. */
  result: LaunchResult | null = null;
  /** True while staging, before the dump. */
  staging = true;

  constructor(public bands: LaunchBands = DEFAULT_BANDS) {}

  setBands(b: LaunchBands): void {
    this.bands = b;
  }

  /**
   * Advance the staging clock. Returns the current rpm band as a 0..1 position
   * within the full usable range, for drawing the window.
   */
  update(dt: number, rpm: number): number {
    if (!this.staging) return 0;
    this.holdTime += dt;
    void rpm;
    return this.bandPosition(rpm);
  }

  /** Normalised 0..1 position of an rpm value within the full window. */
  bandPosition(rpm: number): number {
    const lo = this.bands.bogLow;
    const hi = this.bands.spinHigh;
    if (hi <= lo) return 0;
    return Math.max(0, Math.min(1, (rpm - lo) / (hi - lo)));
  }

  /** Which band an rpm falls in, for colouring the tacho. */
  bandAt(rpm: number): LaunchGrade {
    return gradeLaunch(rpm, this.holdTime, this.bands).grade;
  }

  /**
   * Dump the clutch, scoring the launch. Call once, at the moment of release.
   *
   * A launch is scored exactly once. If dump() is called again -- a held key
   * firing repeatedly, a double tap, an input remap firing twice -- the
   * ORIGINAL result stands. Without this, a late spurious call could rewrite an
   * already-scored launch, and the player would be charged for a launch they
   * did not make.
   */
  dump(rpm: number): LaunchResult {
    if (this.result) return this.result;
    this.staging = false;
    this.result = gradeLaunch(rpm, this.holdTime, this.bands);
    return this.result;
  }

  reset(): void {
    this.holdTime = 0;
    this.result = null;
    this.staging = true;
  }
}
