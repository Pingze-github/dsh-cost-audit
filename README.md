# DSH Stats

A [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) plugin that
extends the two places the harness already shows conversation statistics — under
each turn, and under the whole session — with token detail and **money in RMB**.

Everything is rendered in the harness's own stats form: the same icon pill that
opens a trigger-anchored `dt`/`dd` panel, the same design tokens, the same
geometry. The official pills are untouched; this plugin adds its own beside them.

## What it adds

**Per turn** — a pill in the assistant actions row, between the copy button and
the branch button, next to the official "consumed" and "ran for" pills. It shows
`¥0.00621` and opens:

| Row | Meaning |
| --- | --- |
| Model | the route that served the turn |
| Cache hit | cache-read share of prompt input, never rounded up to a false 100% |
| Cache read | prompt tokens served from cache (缓存输入) |
| Uncached input | prompt tokens billed at the miss rate |
| Cache write | prompt tokens written to cache (only when non-zero) |
| Total input | 总输入 tokens over the three disjoint prompt buckets |
| Output | 输出 tokens, reasoning included |
| Turn cost | 本轮费用, CNY |
| **Timing** | 本轮耗时分布 — see below |

**Per session** — a pill on the **same line** as the official session stats
(`1 turns 297 steps · 237 tok/s · 73.2M tok · Cache hit 99.7%`), immediately to
their right: `¥2.72 · Account balance ¥113.45`. It opens the same breakdown for
the whole durable log, plus the timing section and 账户余额 read live from the
DeepSeek billing API:

| Row | Meaning |
| --- | --- |
| Session cost | 会话总费用, CNY |
| Cache hit / read / uncached / cache write / total input / output | whole-session token buckets |
| **Timing** | 会话耗时分布 — see below |
| Account balance | 总余额, live |
| Granted / Topped up | 赠送余额 and 充值余额 |

### Timing breakdown (耗时分布)

Both panels end their usage section with where the time actually went, and the
tool rows rank their own tool names:

| Row | Meaning |
| --- | --- |
| Total wall | 总耗时 — `turn/start` → `turn/end` |
| LLM time | 模型用时 — `step/start` → `assistant/message`, with the call count |
| Avg time to first token (TTFT) | 首 token 平均 — `step/start` → first output token |
| Generation | 模型生成 — first token → settlement, with tok/s |
| Tool time | 工具调用用时 — `tool/call` → `tool/result`, with the call count |
| Other overhead | 其他开销 — wall time the two above do not account for |
| By tool | 工具明细 — the busiest 6 tool names, then one row for the tail |

The interface follows the harness locale: Simplified Chinese under `zh`, English
under `en`.

## Pricing

Costs are the **official DeepSeek list prices in CNY per 1,000,000 tokens**
([api-docs.deepseek.com](https://api-docs.deepseek.com/zh-cn/quick_start/pricing)),
split by billing period. Peak is Beijing time (UTC+8) Monday–Friday
09:00–12:00 and 14:00–18:00; every other hour, plus all weekend, bills at half.

| Model family | Cache hit (空闲 / 高峰) | Cache miss (空闲 / 高峰) | Output (空闲 / 高峰) |
| --- | --- | --- | --- |
| `deepseek-flash`, `deepseek-v4.1-flash`, `deepseek-v4-flash` | 0.02 / 0.04 | 1 / 2 | 4 / 8 |
| `deepseek-v4-pro`, `deepseek-pro` | 0.15 / 0.30 | 4.5 / 9 | 13.5 / 27 |

A model name that carries neither a `v4` nor a `deepseek` marker is **counted but
never priced** — the panel shows `—` for its cost and says how many tokens were
left unpriced, rather than billing a foreign model at DeepSeek's rates.

Costs are an estimate: they are computed from provider-reported usage, not read
back from a billing statement. **The account balance is not an estimate** — it is
a live read, so it is the ground truth to check the estimate against.

## Config

Every field is optional; overrides go in a profile patch layer with the same id.

```yaml
- id: dsh-stats
  config:
    baseUrl: "https://api.deepseek.com"   # billing API origin
    credentialRef: "DEEPSEEK_API_KEY"     # reference resolved through ctx.credentials
    balanceCacheMs: 60000                 # how long one balance read is reused
    requestTimeoutMs: 8000                # upstream timeout
    pricing:                              # CNY per 1,000,000 tokens
      flash:
        peak: { cacheHit: 0.04, cacheMiss: 2, output: 8 }
        off:  { cacheHit: 0.02, cacheMiss: 1, output: 4 }
      pro:
        peak: { cacheHit: 0.30, cacheMiss: 9, output: 27 }
        off:  { cacheHit: 0.15, cacheMiss: 4.5, output: 13.5 }
```

## Install

```bash
dsh plugin --profile web add link:/path/to/dsh-stats
```

`link:` keeps the checkout live, so edits to `index.js` / `client.js` are served
without reinstalling. `dsh-hotswap` (if installed) hot-mounts the new bundle
entry from the written `dsh.profile.bundles` — no `dsh` restart. **Reload the
browser page** to pick up the new client bundle.

## How it works

- **Host half** (`index.js`) registers one session projection, `dshStats`, that
  folds the whole durable log into per-turn and whole-session billed buckets with
  their CNY cost. It rides the same pipeline as the harness's own `tokenUsage` /
  `sessionStats` units, so figures stay complete however much history a client
  has paged in. Retry accounting mirrors `token-meter`: an Assistant settlement
  replaces its own `(turn, step)` slot, and `llm/retry-started` closes that slot
  so a retried attempt adds instead.
- **Host half** also registers one exact Connection Fetch route,
  `/api/dsh-stats.balance`, which serves the account balance and an on-demand
  fold of any session. The fold exists because the projection pipeline only
  serves a unit to a client once that session has a materialized cell: a session
  whose persisted projection checkpoint predates this plugin has no `dshStats`
  row, and the route closes that gap from the same unit definition.
- **Client half** (`client.js`) registers into the harness's
  `conversation.chat.assistant-actions` and `conversation.composer.dock` slots.
  It carries no build step: it is a hand-written bundle in the
  `window.__ModuleLoader__.load({ id, factory })` form, so the package installs
  straight from a checkout.
- **Session-row placement** is measured, not hard-coded. The composer dock
  stacks its slot entries and the official stats row is a centred flex row this
  plugin does not own, so the row is lifted by the official row's measured
  height and its content indented to start where the official content ends.
  A longer official label, a changed font size, or a resized window all land in
  the right place; when the pill would not fit beside the official pills, the
  row falls back to a centred line of its own instead of overlapping them.

## Layout

```
index.js            host half: dshStats projection + /api/dsh-stats.balance route
index.d.ts          public types + the SessionProjectionMap augmentation
client.js           browser half: the two slot entries
cordis.patch.yml    bundle patch (mounts the host entry)
scripts/check.sh    the project's single success criterion
scripts/check.mjs   host-half behaviour: pricing, retry accounting, route, fold
scripts/link-deps.sh  links node_modules at the running harness for check.sh
scripts/gui-probe.mjs headless-Chromium probe of the live GUI
```
