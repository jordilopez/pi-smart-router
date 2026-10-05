import { describe, it, expect } from 'vitest';
import { modelDescription } from '../src/tools.js';
import { augmentModelDescription, getTierWeighting, computeTaskCost } from '../src/aa-enrichment.js';

describe('aa-enrichment', () => {
  const mockModel = {
    provider: 'hyper',
    model: 'deepseek-v4-pro',
    context: 1_000_000,
    maxOut: 384_000,
    thinking: true,
    images: false,
    costIn: 2.0,
    costOut: 6.0,
  };

  const mockMetrics = {
    modelId: 'deepseek-v4-pro',
    intelligenceIndex: 0.95,
    speedTokensPerSec: 120.5,
    ttftSeconds: 0.2,
  };

  describe('augmentModelDescription', () => {
    const baseDesc = 'hyper/deepseek-v4-pro | context 1.0M, maxOut 384K, thinking yes, images no, $2/$6 per M tokens';

    it('appends AA metrics to the original description', () => {
      const result = augmentModelDescription(mockMetrics, baseDesc);
      expect(result).toContain('intelligence 0.95');
      expect(result).toContain('speed 120.5 tok/s');
      expect(result).toContain('TTFT 0.2s');
      expect(result).toContain(baseDesc);
    });

    it('returns original description when metrics is null', () => {
      const result = augmentModelDescription(null, baseDesc);
      expect(result).toBe(baseDesc);
    });
  });

  describe('modelDescription with metrics', () => {
    it('includes AA columns when metrics are passed via opts', () => {
      const desc = modelDescription(mockModel, { metrics: mockMetrics });
      expect(desc).toContain('intelligence 0.95');
      expect(desc).toContain('speed 120.5 tok/s');
    });

    it('returns normal description when no metrics', () => {
      const desc = modelDescription(mockModel);
      expect(desc).not.toContain('intelligence');
      expect(desc).not.toContain('speed');
    });

    it('works with positioning and metrics together', () => {
      const desc = modelDescription(mockModel, { positioning: 'DeepSeek model; flagship/reasoning tier', metrics: mockMetrics });
      expect(desc).toContain('DeepSeek model');
      expect(desc).toContain('intelligence 0.95');
    });
  });

  describe('getTierWeighting', () => {
    it('prioritizes speed for fast/cheap', () => {
      expect(getTierWeighting('fast')).toEqual({ intelligenceWeight: 0.2, speedWeight: 0.8 });
      expect(getTierWeighting('cheap')).toEqual({ intelligenceWeight: 0.2, speedWeight: 0.8 });
    });

    it('prioritizes intelligence for powerful', () => {
      expect(getTierWeighting('powerful')).toEqual({ intelligenceWeight: 0.8, speedWeight: 0.2 });
    });

    it('balances for balanced', () => {
      expect(getTierWeighting('balanced')).toEqual({ intelligenceWeight: 0.5, speedWeight: 0.5 });
    });
  });

  describe('computeTaskCost', () => {
    const metrics = {
      modelId: 'test',
      intelligenceIndex: 40,
      speedTokensPerSec: 100,
      ttftSeconds: 0.5,
    };

    const metricsWithCoding = { ...metrics, codingIndex: 80 };

    it('returns null when metrics is null', () => {
      expect(computeTaskCost(1, null)).toBeNull();
    });

    it('returns null when price is zero or negative', () => {
      expect(computeTaskCost(0, metrics)).toBeNull();
      expect(computeTaskCost(-1, metrics)).toBeNull();
    });

    it('returns null when both coding and intelligence are zero', () => {
      expect(computeTaskCost(1, { ...metrics, intelligenceIndex: 0 })).toBeNull();
    });

    it('uses codingIndex when available', () => {
      // price=2, coding=80 -> p=0.8 -> 2/0.8 = 2.5
      expect(computeTaskCost(2, metricsWithCoding)).toBeCloseTo(2.5);
    });

    it('falls back to intelligenceIndex when codingIndex is absent', () => {
      // price=2, intel=40 -> p=0.4 -> 2/0.4 = 5
      expect(computeTaskCost(2, metrics)).toBeCloseTo(5);
    });

    it('floors P(solve) at 0.05 for low scores', () => {
      // price=1, intel=2 -> p=0.05 (floor) -> 1/0.05 = 20
      expect(computeTaskCost(1, { ...metrics, intelligenceIndex: 2 })).toBeCloseTo(20);
    });
  });
});