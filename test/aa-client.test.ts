import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  getAaBenchmarks,
  buildAaMetricsMap,
  normalizeModelId,
  AA_CACHE_FILE,
} from '../src/aa-client.js';
import fs from 'node:fs/promises';
import path from 'node:path';

// Mock global fetch
global.fetch = vi.fn();

describe('aa-client', () => {
  const mockCacheDir = '/tmp/aa-cache-test';
  const mockFixture = 'test/fixtures/aa-models.sample.json';
  const cachePath = path.join(mockCacheDir, AA_CACHE_FILE);

  /** Read the fixture and return a fetch-like resolved response. */
  async function okResponse() {
    const sampleData = await fs.readFile(mockFixture, 'utf-8');
    return { ok: true, json: async () => JSON.parse(sampleData) };
  }

  beforeEach(async () => {
    vi.resetAllMocks();
    delete process.env.AA_API_KEY;
    await fs.rm(mockCacheDir, { recursive: true, force: true });
  });

  it('returns null when no key and no cache exists', async () => {
    const result = await getAaBenchmarks({ cacheDir: mockCacheDir });
    expect(result).toBeNull();
    expect(fetch).not.toHaveBeenCalled();
  });

  it('serves an existing cache even when AA_API_KEY is unset', async () => {
    await fs.mkdir(mockCacheDir, { recursive: true });
    await fs.writeFile(
      cachePath,
      JSON.stringify({
        timestamp: Date.now(),
        data: [{ modelId: 'cachedmodel', intelligenceIndex: 5, speedTokensPerSec: 5, ttftSeconds: 5 }],
      }),
    );

    const result = await getAaBenchmarks({ cacheDir: mockCacheDir });
    expect(result!.data[0].modelId).toBe('cachedmodel');
    expect(fetch).not.toHaveBeenCalled();
  });

  it('returns null on 401 error', async () => {
    process.env.AA_API_KEY = 'test-key';
    (fetch as any).mockResolvedValue({ ok: false, status: 401 });

    const result = await getAaBenchmarks({ cacheDir: mockCacheDir });
    expect(result).toBeNull();
  });

  it('returns null on timeout', async () => {
    process.env.AA_API_KEY = 'test-key';
    (fetch as any).mockRejectedValue(new Error('Timeout'));

    const result = await getAaBenchmarks({ cacheDir: mockCacheDir });
    expect(result).toBeNull();
  });

  it('successfully fetches and normalizes data', async () => {
    process.env.AA_API_KEY = 'test-key';
    (fetch as any).mockResolvedValue(await okResponse());

    const result = await getAaBenchmarks({ cacheDir: mockCacheDir });
    expect(result).not.toBeNull();
    // modelId is canonicalized by normalizeModelId; metrics come from the
    // synthetic-but-structure-accurate fixture (slug + evaluations + median_*).
    expect(normalizeModelId('synthetic')).toBe('synthetic');
    expect(result!.data[0]).toMatchObject({
      modelId: 'syntheticpro',
      intelligenceIndex: 36,
      speedTokensPerSec: 116.078,
      ttftSeconds: 1.039,
      codingIndex: 68.8,
    });
  });

  it('drops malformed rows and coerces numeric strings instead of throwing', async () => {
    process.env.AA_API_KEY = 'test-key';
    (fetch as any).mockResolvedValue({
      ok: true,
      json: async () => [
        { modelId: 'good-model', intelligenceIndex: '72.5', speedTokensPerSec: 10 },
        { modelId: 'no-metrics-model' },
        { notAModel: true },
        null,
        'garbage',
      ],
    });

    const result = await getAaBenchmarks({ cacheDir: mockCacheDir });
    expect(result!.data).toHaveLength(1);
    expect(result!.data[0].modelId).toBe('goodmodel');
    expect(result!.data[0].intelligenceIndex).toBe(72.5);
  });

  it('returns [] (and does not cache) when the payload is not an array', async () => {
    process.env.AA_API_KEY = 'test-key';
    (fetch as any).mockResolvedValue({ ok: true, json: async () => ({ error: 'nope' }) });

    const result = await getAaBenchmarks({ cacheDir: mockCacheDir });
    expect(result).toBeNull();
    await expect(fs.access(cachePath)).rejects.toThrow();
  });

  it('unwraps the real {data:[...]} payload wrapper', async () => {
    process.env.AA_API_KEY = 'test-key';
    (fetch as any).mockResolvedValue({
      ok: true,
      json: async () => ({
        status: 200,
        prompt_options: {},
        data: [{
          slug: 'some-model',
          evaluations: { artificial_analysis_intelligence_index: 42.5 },
          median_output_tokens_per_second: 90,
          median_time_to_first_token_seconds: 0.5,
        }],
      }),
    });

    const result = await getAaBenchmarks({ cacheDir: mockCacheDir });
    expect(result!.data).toEqual([
      { modelId: 'somemodel', intelligenceIndex: 42.5, speedTokensPerSec: 90, ttftSeconds: 0.5 },
    ]);
  });

  it('propagates codingIndex when present', async () => {
    process.env.AA_API_KEY = 'test-key';
    (fetch as any).mockResolvedValue({
      ok: true,
      json: async () => ({
        status: 200,
        prompt_options: {},
        data: [{
          slug: 'coder-model',
          evaluations: {
            artificial_analysis_intelligence_index: 50,
            artificial_analysis_coding_index: 72.5,
          },
          median_output_tokens_per_second: 100,
          median_time_to_first_token_seconds: 1,
        }],
      }),
    });
    const result = await getAaBenchmarks({ cacheDir: mockCacheDir });
    expect(result!.data[0].codingIndex).toBe(72.5);
  });

  it('omits codingIndex when absent from payload', async () => {
    process.env.AA_API_KEY = 'test-key';
    (fetch as any).mockResolvedValue({
      ok: true,
      json: async () => ({
        status: 200,
        prompt_options: {},
        data: [{ slug: 'no-coding', evaluations: { artificial_analysis_intelligence_index: 40 } }],
      }),
    });
    const result = await getAaBenchmarks({ cacheDir: mockCacheDir });
    expect(result!.data[0]).not.toHaveProperty('codingIndex');
  });

  it('uses cache if available and not expired', async () => {
    process.env.AA_API_KEY = 'test-key';
    (fetch as any).mockResolvedValue(await okResponse());

    await getAaBenchmarks({ cacheDir: mockCacheDir });
    expect(fetch).toHaveBeenCalledTimes(1);

    const result = await getAaBenchmarks({ cacheDir: mockCacheDir });
    expect(result).not.toBeNull();
    expect(fetch).toHaveBeenCalledTimes(1); // still 1 — served from cache
  });

  it('refetches when the cache is stale', async () => {
    process.env.AA_API_KEY = 'test-key';
    (fetch as any).mockResolvedValue(await okResponse());

    // Write a stale entry at the real cache path.
    await fs.mkdir(mockCacheDir, { recursive: true });
    await fs.writeFile(
      cachePath,
      JSON.stringify({
        timestamp: Date.now() - 10 * 24 * 60 * 60 * 1000, // 10 days ago
        data: [{ modelId: 'oldmodel', intelligenceIndex: 1, speedTokensPerSec: 1, ttftSeconds: 1 }],
      }),
    );

    const result = await getAaBenchmarks({ cacheDir: mockCacheDir });
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(result!.data[0].modelId).toBe('syntheticpro');
  });

  it('falls back to stale cache when a refresh fails', async () => {
    process.env.AA_API_KEY = 'test-key';
    (fetch as any).mockRejectedValue(new Error('network down'));

    await fs.mkdir(mockCacheDir, { recursive: true });
    await fs.writeFile(
      cachePath,
      JSON.stringify({
        timestamp: Date.now() - 10 * 24 * 60 * 60 * 1000, // stale
        data: [{ modelId: 'staleentry', intelligenceIndex: 3, speedTokensPerSec: 3, ttftSeconds: 3 }],
      }),
    );

    const result = await getAaBenchmarks({ cacheDir: mockCacheDir });
    expect(result!.data[0].modelId).toBe('staleentry');
  });

  it('refresh: true bypasses a fresh cache', async () => {
    process.env.AA_API_KEY = 'test-key';
    (fetch as any).mockResolvedValue(await okResponse());

    await getAaBenchmarks({ cacheDir: mockCacheDir });
    await getAaBenchmarks({ cacheDir: mockCacheDir, refresh: true });
    expect(fetch).toHaveBeenCalledTimes(2);
  });
});

describe('normalizeModelId', () => {
  it('reconciles provider ids with AA display names', () => {
    expect(normalizeModelId('gemma-4-26b-a4b-it')).toBe('gemma426ba4b');
    expect(normalizeModelId('Gemma 4 26B A4B')).toBe('gemma426ba4b');
    expect(normalizeModelId('deepseek-v4.1-flash')).toBe('deepseekv41flash');
    expect(normalizeModelId('DeepSeek V4.1 Flash Preview')).toBe('deepseekv41flash');
    expect(normalizeModelId('glm-5.3-flash')).toBe('glm53flash');
  });
});

describe('buildAaMetricsMap', () => {
  it('keys metrics by normalized id and is empty for null', () => {
    const map = buildAaMetricsMap({
      timestamp: 0,
      data: [{ modelId: 'deepseekv4pro', intelligenceIndex: 1, speedTokensPerSec: 2, ttftSeconds: 3 }],
    });
    expect(map.get('deepseekv4pro')?.intelligenceIndex).toBe(1);
    expect(buildAaMetricsMap(null).size).toBe(0);
  });

  it('skips malformed cache entries without throwing', () => {
    const map = buildAaMetricsMap({
      timestamp: 0,
      data: [null as any, 'junk' as any, {} as any, { modelId: 'ok' } as any],
    });
    expect(map.size).toBe(1);
    expect(map.has('ok')).toBe(true);
  });
});
