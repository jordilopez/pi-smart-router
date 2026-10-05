# Test fixtures

## `aa-models.sample.json`

**Status: synthetic, structure-accurate. Not a captured live response.**

This fixture mirrors the confirmed shape of the live
`GET https://artificialanalysis.ai/api/v2/language/models/free` payload
(wrapper object, `slug`, nested `evaluations`, nested `performance.median_*` fields) but
uses **invented values and synthetic slugs** (`synthetic-*`). It is committed
instead of a live capture because Artificial Analysis data is licensed and not
clearly redistributable in a public repository.

To restore a real capture locally (do **not** commit it):

```sh
curl -s https://artificialanalysis.ai/api/v2/language/models/free \
  -H "x-api-key: $AA_API_KEY" > /tmp/aa-live.json
python3 - <<'PY'
import json
d = json.load(open('/tmp/aa-live.json'))
# Trim to a few slugs you care about, then overwrite the fixture locally.
want = {'deepseek-v4-pro', 'deepseek-v4-flash', 'gpt-6-luna'}
by = {e.get('slug'): e for e in d['data']}
open('test/fixtures/aa-models.sample.json', 'w').write(
    json.dumps({'status': d.get('status'), 'prompt_options': d.get('prompt_options'),
                'data': [by[s] for s in want if s in by]}, indent=2) + '\n')
PY
```

When you do capture locally, adjust the test expectations that assert specific
synthetic values (see `test/aa-client.test.ts`).

Confirmed payload facts (from the verified live capture):

- Wrapper: `{ status, prompt_options, data: [...] }`.
- Model id: `slug` (e.g. `deepseek-v4-1-flash`), display name `name`.
- Intelligence: `evaluations.artificial_analysis_intelligence_index` (0–100).
- Coding score: `evaluations.artificial_analysis_coding_index` (0–100, sparse).
- Throughput: top-level `median_output_tokens_per_second`.
- Latency: top-level `median_time_to_first_token_seconds`, genuinely **seconds**
  (non-zero min ≈ 0.21, median ≈ 1.22 across 690 rows), despite outliers up to
  ≈ 449. Zero means "not measured".
- Pricing: nested `pricing.price_1m_*` (the router uses the model **registry**
  for pricing instead, per spec).
