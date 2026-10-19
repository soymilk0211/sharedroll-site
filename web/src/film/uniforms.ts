/**
 * 餵給著色器的數字。**換算公式逐條移植自主 repo 的 `shared-roll/src/film-filter/shader.ts`**
 * (`gradeUniforms`、`highlightMaskUniforms`、`ringUniforms`、`finishUniforms`、`workingSizeFor`、
 * `scaledRadius`)。網頁拿不到 ISO 與閃光燈,所以收尾一律 `iso: null`、`flash: false`。
 */

import {
  GRAIN_AMPLITUDE,
  GRAIN_DENSITY_WITHOUT_ISO,
  REFERENCE_WIDTH,
  effectiveDensity,
  grainCellSize,
  type GrainOffset,
} from './grain';
import type { FilmFilterRecipe, Halation } from './recipes';

export const FILTER_WORKING_WIDTH = REFERENCE_WIDTH;
export const BLUR_SIGMA_PER_RADIUS = 1 / 3;
export const HALATION_CORE_BLUR_RATIO = 0.25;
export const TEMPERATURE_FULL_SCALE = 0.5;
export const CLARITY_RADIUS = 24;

export interface RenderSize {
  width: number;
  height: number;
}

export function workingSizeFor({ width, height }: RenderSize): RenderSize {
  if (width <= FILTER_WORKING_WIDTH) {
    return { width, height };
  }
  return {
    width: FILTER_WORKING_WIDTH,
    height: Math.max(1, Math.round((height * FILTER_WORKING_WIDTH) / width)),
  };
}

export function scaledRadius(referencePx: number, width: number): number {
  return Math.max(1, Math.round((referencePx * width) / REFERENCE_WIDTH));
}

export type Uniforms = Record<string, readonly number[]>;

const NO_SHIFT = [0, 0, 0, 0];

function shift(offsets: { r: number; g: number; b: number } | undefined): number[] {
  if (!offsets) return NO_SHIFT;
  return [offsets.r / 255, offsets.g / 255, offsets.b / 255, 0];
}

export function halationOf(recipe: FilmFilterRecipe): Halation {
  if (!recipe.halation) {
    throw new Error(`這一款沒有紅暈:${recipe.key}`);
  }
  return recipe.halation;
}

export function gradeUniforms(recipe: FilmFilterRecipe): Uniforms {
  return {
    exposureGain: [2 ** recipe.exposureEv],
    temperature: [(recipe.temperaturePercent / 100) * TEMPERATURE_FULL_SCALE],
    contrast: [1 + recipe.contrastPercent / 100],
    saturation: [1 + recipe.saturationPercent / 100],
    shadowFade: [recipe.shadowFade / 255],
    shadowsShift: shift(recipe.colorBalance?.shadows),
    midtonesShift: shift(recipe.colorBalance?.midtones),
    highlightsShift: shift(recipe.colorBalance?.highlights),
  };
}

export function highlightMaskUniforms(recipe: FilmFilterRecipe): Uniforms {
  const halation = halationOf(recipe);
  return {
    threshold: [halation.lumaThreshold / 255],
    knee: [halation.thresholdKnee / 255],
  };
}

export function ringUniforms(recipe: FilmFilterRecipe): Uniforms {
  const halation = halationOf(recipe);
  return {
    coreAmount: [halation.ringOnly ? 1 : 0],
    gain: [halation.gain],
  };
}

export interface FinishConditions {
  iso: number | null;
  flash: boolean;
  grainOffset: GrainOffset;
}

export function finishUniforms(
  recipe: FilmFilterRecipe,
  size: RenderSize,
  working: RenderSize,
  conditions: FinishConditions,
): Uniforms {
  const grade = gradeUniforms(recipe);
  const flashMask = conditions.flash ? recipe.flash : null;
  const baseDensity = recipe.grain.densityPercent / 100;
  const density =
    conditions.iso === null
      ? baseDensity * GRAIN_DENSITY_WITHOUT_ISO
      : effectiveDensity(baseDensity, conditions.iso);
  return {
    ...grade,
    helperScale: [working.width / size.width, working.height / size.height],
    clarityAmount: [recipe.clarityPercent / 100],
    halationAmount: [recipe.halation ? 1 : 0],
    center: [size.width / 2, size.height / 2],
    maxDistance: [Math.max(1e-6, Math.hypot((size.width - 1) / 2, (size.height - 1) / 2))],
    centerBoost: [(flashMask?.centerBoostPercent ?? 0) / 100],
    edgeVignette: [(flashMask?.edgeVignettePercent ?? 0) / 100],
    grainAmplitude: [density * GRAIN_AMPLITUDE],
    grainCell: [
      Math.max(
        1e-6,
        (grainCellSize(recipe.grain.roughnessPercent / 100) * size.width) / REFERENCE_WIDTH,
      ),
    ],
    grainOffset: [conditions.grainOffset.x, conditions.grainOffset.y],
  };
}
