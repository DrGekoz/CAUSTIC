/**
 * Night lighting grade.
 *
 * A drag strip at night is not dark -- it is pools of warm sodium light on wet
 * concrete with a very black sky. The difference between "too dark to see" and
 * "moody" is entirely in these numbers, so they live in one place and are
 * tuned against a screenshot rather than guessed.
 */

import type { FrameSettings } from '../render/Renderer';

export const NIGHT_GRADE: Partial<FrameSettings> = {
  exposure: 1.05,
  // Wet rubber reflects every tower light, so the bloom threshold sits low and
  // the strength is generous. This is the single biggest contributor to the
  // "ray traced" read.
  bloomStrength: 0.3,
  bloomThreshold: 1.05,
  vignette: 0.3,
  grain: 0.018,
  aberration: 0.002,
  volumetricDensity: 0.45,
  volumetricScatter: 0.9,
  fogColor: [0.075, 0.085, 0.11],
  ambientSky: [0.10, 0.125, 0.175],
  ambientGround: [0.062, 0.052, 0.04],
  envIntensity: 1.15,
  flash: 0,
  flashColor: [1, 0.92, 0.75],
  taaFeedback: 0.88,
};
