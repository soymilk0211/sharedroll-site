/**
 * 五款濾鏡的參數。**數字不在這裡**:`web/shared/recipes.json` 是建置前從主 repo
 * `shared-roll/src/film-filter/recipes.json` 原樣複製過來的(冷啟動 spec 決定紀錄 2026-10-17),
 * 主 repo 的 mirrors.lock.json 盯著兩邊有沒有對上。這支只留型別與讀取,型別照抄 App 的 `recipes.ts`。
 */

import recipesFile from '../../shared/recipes.json';
import type { CurvePoint } from './curves';

export const FILM_FILTER_KEYS = [
  'warm_portrait',
  'clear_daylight',
  'nostalgic_gold',
  'neon_night',
  'high_iso_mono',
] as const;

export type FilmFilterKey = (typeof FILM_FILTER_KEYS)[number];

interface ChannelOffsets {
  r: number;
  g: number;
  b: number;
}

export interface Halation {
  lumaThreshold: number;
  thresholdKnee: number;
  localityRadiusPx: number;
  maskFrom: 'source' | 'graded';
  blurRadiusPx: number;
  gain: number;
  ringOnly: boolean;
}

export interface FilmFilterRecipe {
  key: FilmFilterKey;
  name: string;
  exposureEv: number;
  temperaturePercent: number;
  contrastPercent: number;
  saturationPercent: number;
  clarityPercent: number;
  shadowFade: number;
  colorBalance: {
    highlights: ChannelOffsets;
    midtones: ChannelOffsets;
    shadows: ChannelOffsets;
  } | null;
  curves: {
    red: readonly CurvePoint[];
    green: readonly CurvePoint[];
    blue: readonly CurvePoint[];
  };
  grain: { densityPercent: number; roughnessPercent: number };
  flash: { centerBoostPercent: number; edgeVignettePercent: number } | null;
  halation: Halation | null;
}

const RECIPES = (recipesFile as { version: number; recipes: FilmFilterRecipe[] }).recipes;

export function isFilmFilterKey(value: unknown): value is FilmFilterKey {
  return typeof value === 'string' && (FILM_FILTER_KEYS as readonly string[]).includes(value);
}

export function recipeFor(key: FilmFilterKey): FilmFilterRecipe {
  const recipe = RECIPES.find((candidate) => candidate.key === key);
  if (!recipe) throw new Error(`沒有這款濾鏡的配方:${key}`);
  return recipe;
}

export function allRecipes(): readonly FilmFilterRecipe[] {
  return RECIPES;
}
