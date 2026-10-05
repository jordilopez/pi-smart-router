import type { RouteTier } from './types.js';
import type { AaModelMetrics } from './aa-client.js';

/** Relative emphasis on measured capability vs. throughput, per tier. */
export interface TierWeighting {
  intelligenceWeight: number;
  speedWeight: number;
}

/**
 * Append AA benchmark metrics to a model description.
 *
 * Only finite metrics are rendered; a null/empty/invalid metric set returns the
 * original description unchanged.
 */
export function augmentModelDescription(
  metrics: AaModelMetrics | null,
  originalDesc: string,
): string {
  if (!metrics) return originalDesc;

  const parts: string[] = [];
  if (Number.isFinite(metrics.intelligenceIndex)) {
    parts.push(`intelligence ${metrics.intelligenceIndex.toFixed(2)}`);
  }
  if (Number.isFinite(metrics.speedTokensPerSec)) {
    parts.push(`speed ${metrics.speedTokensPerSec.toFixed(1)} tok/s`);
  }
  if (Number.isFinite(metrics.ttftSeconds)) {
    parts.push(`TTFT ${metrics.ttftSeconds.toFixed(1)}s`);
  }
  if (parts.length === 0) return originalDesc;

  return `${originalDesc} (${parts.join(', ')})`;
}

/**
 * Compute the solve-adjusted task-cost index.
 *
 * task-cost = blended registry price / P(solve)
 * P(solve)  = clamp(codingIndex / 100, 0.05, 1)  — fallback intelligenceIndex / 100
 *
 * Lower is better. Returns null when the inputs are insufficient, so callers
 * always fall back to the raw-price description.
 *
 * This is a **solve-adjusted index**, not literal dollars per task. Absolute
 * values depend on tokens per task, which is unknown; only relative ordering
 * (cheaper-per-solved-unit) is meaningful.
 */
export function computeTaskCost(
  blendPrice: number,
  metrics: AaModelMetrics | null,
): number | null {
  if (!metrics) return null;
  if (!Number.isFinite(blendPrice) || blendPrice <= 0) return null;

  const score =
    typeof metrics.codingIndex === 'number' && Number.isFinite(metrics.codingIndex)
      ? metrics.codingIndex
      : metrics.intelligenceIndex;
  if (typeof score !== 'number' || !Number.isFinite(score) || score <= 0) return null;

  const p = Math.max(score / 100, 0.05);
  return blendPrice / p;
}

/**
 * Weighting priorities for a tier: speed-driven for cheap/fast, intelligence-led
 * for powerful, balanced in between. The switch is exhaustive over `RouteTier`.
 */
export function getTierWeighting(tier: RouteTier): TierWeighting {
  switch (tier) {
    case 'cheap':
    case 'fast':
      return { intelligenceWeight: 0.2, speedWeight: 0.8 };
    case 'balanced':
      return { intelligenceWeight: 0.5, speedWeight: 0.5 };
    case 'powerful':
      return { intelligenceWeight: 0.8, speedWeight: 0.2 };
  }
}