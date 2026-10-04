/**
 * Client for fetching and caching Artificial Analysis benchmark data.
 * Never throws: returns null on error or when API key is missing.
 */

import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

/**
 * Normalized benchmark data for a single model.
 */
export interface AaModelMetrics {
  /** Canonical id produced by {@link normalizeModelId}. */
  modelId: string;
  intelligenceIndex: number;
  speedTokensPerSec: number;
  ttftSeconds: number;
  /** 0–100 AA coding benchmark; null when unavailable (task-cost falls back to intelligenceIndex). */
  codingIndex?: number;
}

/**
 * The complete payload for the benchmark cache.
 */
export interface AaBenchmarks {
  timestamp: number;
  data: AaModelMetrics[];
}

export interface GetAaBenchmarksOptions {
  /** Directory to store/read the cache. Defaults to `~/.pi/agent/`. */
  cacheDir?: string;
  /** Force a fresh network fetch even when the cache is valid. */
  refresh?: boolean;
}

const AA_MODELS_URL = 'https://artificialanalysis.ai/api/v2/data/llms/models';
const AA_CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
const AA_TIMEOUT_MS = 10_000;
const AA_MAX_RESPONSE_BYTES = 5 * 1024 * 1024; // best-effort guard on an untrusted payload

/** Cache filename inside the cache directory (exported so tests stay in sync). */
export const AA_CACHE_FILE = 'aa-benchmarks-cache.json';

/**
 * Tokens dropped when canonicalizing a model id, so provider ids
 * (`gemma-4-26b-a4b-it`) match AA display names (`Gemma 4 26B A4B`).
 *
 * Note: variant tokens (thinking/reasoning) are stripped deliberately, so
 * `x-flash` and `x-flash-thinking` share one key. If AA reports both, the
 * last entry wins in the metrics map.
 */
const QUALIFIER_TOKENS = new Set([
  'it',
  'instruct',
  'chat',
  'preview',
  'exp',
  'experimental',
  'reasoning',
  'thinking',
  'fp8',
  'fp16',
  'int4',
  'int8',
  'awq',
  'gguf',
  'quantized',
]);

/**
 * Explicit overrides for ids that normalization alone cannot reconcile.
 * Keys and values are both outputs of the token-normalization below; add
 * entries only when a real mismatch is observed against a live payload.
 */
const MODEL_ALIASES: Record<string, string> = {
  // 'providervendorxyz': 'aavendorxyz',
};

/**
 * Canonicalize a model id so provider names and AA display names collide:
 * lowercase, split on non-alphanumerics, drop qualifier tokens, join.
 *
 * Exported so callers can key a metrics lookup with the same function used
 * to normalize the AA payload.
 */
export function normalizeModelId(model: string): string {
  const base = model
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((token) => token && !QUALIFIER_TOKENS.has(token))
    .join('');
  return MODEL_ALIASES[base] ?? base;
}

/**
 * Fetches AA benchmarks, manages a disk-based TTL cache, and normalizes results.
 *
 * @param opts - optional cache directory and refresh override
 * @returns benchmark data, or null when the key is missing, the payload is
 *   unusable, and no cache exists. A stale cache is returned when a refresh fails.
 * @throws Never throws.
 */
export async function getAaBenchmarks(opts?: GetAaBenchmarksOptions): Promise<AaBenchmarks | null> {
  const cacheDir = opts?.cacheDir ?? path.join(os.homedir(), '.pi', 'agent');
  const cacheFile = path.join(cacheDir, AA_CACHE_FILE);
  const now = Date.now();

  // 1. Serve a fresh cache without touching the network.
  const cached = await readCache(cacheFile); // never throws
  if (cached && !opts?.refresh && now - cached.timestamp < AA_CACHE_TTL_MS) {
    return cached;
  }

  // 2. No key: fall back to whatever cache exists (possibly stale) or null.
  const apiKey = process.env.AA_API_KEY;
  if (!apiKey) return cached;

  try {
    const res = await fetch(AA_MODELS_URL, {
      headers: { 'x-api-key': apiKey },
      signal: AbortSignal.timeout(AA_TIMEOUT_MS),
    });
    if (!res.ok) return cached; // 401/500/etc — prefer stale data over nothing

    // Best-effort guard: reject an oversized payload when the server declares it.
    const declaredBytes = Number(res.headers?.get?.('content-length'));
    if (Number.isFinite(declaredBytes) && declaredBytes > AA_MAX_RESPONSE_BYTES) return cached;

    const normalized = normalize(await res.json());
    if (normalized.length === 0) return cached; // never cache an empty payload

    const fresh: AaBenchmarks = { timestamp: now, data: normalized };
    await writeCache(cacheFile, fresh); // never throws
    return fresh;
  } catch {
    return cached; // network error / timeout / bad JSON
  }
}

/**
 * Build a metrics lookup keyed by {@link normalizeModelId}. Returns an empty
 * map when benchmarks are unavailable, so callers need no null checks. Rows
 * without a usable id are skipped: the cache is treated as untrusted input, so
 * a malformed entry must not throw (this module never throws).
 */
export function buildAaMetricsMap(benchmarks: AaBenchmarks | null): Map<string, AaModelMetrics> {
  const map = new Map<string, AaModelMetrics>();
  if (!benchmarks) return map;
  for (const metrics of benchmarks.data) {
    if (metrics && typeof metrics === 'object' && typeof metrics.modelId === 'string') {
      map.set(metrics.modelId, metrics);
    }
  }
  return map;
}

/** True when `value` has the shape of a persisted AaBenchmarks payload. */
function isAaBenchmarks(value: unknown): value is AaBenchmarks {
  if (value === null || typeof value !== 'object') return false;
  const candidate = value as AaBenchmarks;
  return typeof candidate.timestamp === 'number' && Array.isArray(candidate.data);
}

/** Read the cache, returning null for missing/corrupt/unexpected shapes. Never throws. */
async function readCache(filePath: string): Promise<AaBenchmarks | null> {
  try {
    const parsed = JSON.parse(await fs.readFile(filePath, 'utf-8')) as unknown;
    return isAaBenchmarks(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/** Atomically write the cache (temp file + rename). Never throws. */
async function writeCache(filePath: string, data: AaBenchmarks): Promise<void> {
  try {
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    const tmp = `${filePath}.${process.pid}.tmp`;
    await fs.writeFile(tmp, JSON.stringify(data, null, 2));
    await fs.rename(tmp, filePath);
  } catch {
    // Silent failure: caching is best-effort.
  }
}

/** Coerce a value to a finite number, or null when it is not numeric. */
function toFiniteNumber(value: unknown): number | null {
  const n = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : NaN;
  return Number.isFinite(n) ? n : null;
}

/** First string-valued property present among `keys`, else null. */
function firstString(source: Record<string, unknown>, keys: string[]): string | null {
  for (const key of keys) {
    const value = source[key];
    if (typeof value === 'string' && value.trim()) return value;
  }
  return null;
}

/** First finite-number property present among `keys`, else null. */
function firstNumber(source: Record<string, unknown>, keys: string[]): number | null {
  for (const key of keys) {
    const value = toFiniteNumber(source[key]);
    if (value !== null) return value;
  }
  return null;
}

/**
 * Extract the model rows from a payload. Real AA v2 responses wrap the rows in
 * `{ status, prompt_options, data: [...] }`; a bare array is also tolerated so
 * simple callers and tests can pass rows directly.
 */
function extractRows(raw: unknown): unknown[] {
  if (Array.isArray(raw)) return raw;
  if (raw !== null && typeof raw === 'object') {
    const data = (raw as Record<string, unknown>).data;
    if (Array.isArray(data)) return data;
  }
  return [];
}

/**
 * Transform the raw API payload into the normalized schema, treating the
 * response as untrusted: non-array/non-wrapper payloads yield [], malformed
 * rows are dropped, and non-numeric metrics never propagate (which would throw
 * later during description formatting).
 *
 * Real AA v2 shape: rows under `data[]`, `slug` for the model id, intelligence
 * under `evaluations.artificial_analysis_intelligence_index`, and throughput /
 * TTFT as top-level `median_*` fields. Older/aliased names are kept so a bare
 * array payload still parses.
 */
function normalize(raw: unknown): AaModelMetrics[] {
  const out: AaModelMetrics[] = [];
  for (const entry of extractRows(raw)) {
    if (entry === null || typeof entry !== 'object') continue;
    const row = entry as Record<string, unknown>;

    // Prefer the AA slug (stable, clean); tolerate display-name fallbacks.
    const modelId = firstString(row, ['slug', 'modelId', 'model', 'name']);
    if (!modelId) continue;

    const evaluations =
      row.evaluations !== null && typeof row.evaluations === 'object'
        ? (row.evaluations as Record<string, unknown>)
        : {};
    const intelligence =
      firstNumber(evaluations, [
        'artificial_analysis_intelligence_index',
        'intelligenceIndex',
        'intelligence',
      ]) ?? firstNumber(row, ['intelligenceIndex', 'intelligence']);
    const speed = firstNumber(row, [
      'median_output_tokens_per_second',
      'speedTokensPerSec',
      'tokensPerSecond',
    ]);
    const ttft = firstNumber(row, [
      'median_time_to_first_token_seconds',
      'ttftSeconds',
      'timeToFirstToken',
    ]);
    const codingIndex = firstNumber(evaluations, [
      'artificial_analysis_coding_index',
      'codingIndex',
      'coding_index',
    ]);
    if (intelligence === null && speed === null && ttft === null && codingIndex === null) continue;

    out.push({
      modelId: normalizeModelId(modelId),
      intelligenceIndex: intelligence ?? 0,
      speedTokensPerSec: speed ?? 0,
      ttftSeconds: ttft ?? 0,
      ...(codingIndex !== null && { codingIndex }),
    });
  }
  return out;
}
