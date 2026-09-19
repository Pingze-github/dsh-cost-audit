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
their right: `¥2.72 · today ¥0.41 · Account balance ¥113.45` — the session total,
what of it was spent **today**, and the live account balance. A session picked up
again days later shows today's spend from zero, not the lifetime figure. It opens the same breakdown for
the whole durable log, plus the timing section and 账户余额 read live from the
DeepSeek billing API:

| Row | Meaning |
| --- | --- |
| Session cost | 会话总费用, CNY |
| today | 今日 — this session's spend on the browser's calendar day |
| of which cache re-read | 其中缓存重读 — the part of the bill that is the same context read again |
| of which compaction | 其中压缩摘要 — the summarize calls' own bill, which **no other display counts** |
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

### Token-saving tips (省 Token 建议)

A fourth pill appears **only while there is something worth saying** — a healthy
session pays no space for it. It opens a list of data-grounded suggestions, each
with a severity, a one-line fix, and a per-session Dismiss:

| Code | Fires when | One click does |
| --- | --- | --- |
| `context-reread` | cache re-read is ≥ 35% of the session's spend (over 30+ model calls) | **Compact this session** — submits `/compact` |
| `fragmented-tools` | one tool has 30+ calls, 60%+ of them under 2s | steers the agent to merge the batch into one script |
| `repeated-target` | the same tool hits the same file/command 4+ times | steers it to read once and locate with grep |
| `idle-grinding` | 30+ steps with no write, edit, or deliverable | asks for a status report instead of more probing |
| `tool-failures` | one tool fails 3 times in a row | tells it to stop and read the error |
| `cache-hit-drop` | hit rate below 85% over 50+ calls | asks it to find what rewrites the request head |
| `compaction-churn` | 2+ compactions, or the summaries cost ≥ 10% of the session | — (a config value, next session) |
| `model-retries` | 5+ model retries | — |
| `balance-low` | the balance covers fewer than five sessions at this burn rate | — (top up) |

### Applying a tip

Every actionable tip carries a button that submits into **this** session through
the composer's own action face (`setDraft` + `submit`) — the same path the send
button takes, so the message lands in the transcript and the agent picks it up on
its next step (queued as steering when the turn is already running). A tip with
no honest automated fix says "this one is yours to handle" rather than offering a
button that would do nothing.

Two guards, both deliberate: the button is **disabled while the composer holds a
draft**, because acting means writing the composer and a click must never throw
away what a human typed; and each tip disables itself once sent. Dismissing a tip
is remembered per session in this browser.

### After you apply one

An applied tip **leaves the pill's count and stays in the list**, marked with a
verdict that keeps updating as the session runs:

| Verdict | Meaning |
| --- | --- |
| Adopted · improved | the metric moved the good way by more than its floor |
| Adopted · about the same | it moved less than the floor — the change did not register |
| Adopted · got worse | it moved the wrong way by more than the floor |
| Adopted · too early to tell | not enough calls since adoption to judge; the panel says how many |

The reading is **since adoption**, not a lifetime average that history would
drown out: the browser snapshots the cumulative counters the moment you click and
subtracts them from a later reading. The metric per tip is the one that tip is
about — context tokens per request, short-call share, repeat-call share, tool
failure share, cache hit rate — and every floor is a share of the baseline, so a
token count and a ratio are judged on the same scale. Nothing here calls a model;
it is arithmetic on the same fold the pills already read.

A verdict is a *measurement*, not a promise: a metric can improve for reasons the
tip had nothing to do with. Treat "about the same" as the honest default and the
numbers as the evidence.

Every one is folded from the durable log — **the advisor never calls a model**,
because a token-saving feature that spends tokens is self-defeating. The
thresholds are deliberately conservative and every rule needs a sustained
pattern: an advisor that cries wolf stops being read.

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
- **Daily spend** is folded by local calendar day (the host's clock, which is the
  browser's too) and kept for the newest 31 days, so a session carried across
  months does not grow its checkpoint without bound.
- **Session-row placement** is measured, not hard-coded, and the pair stays
  centred. The composer dock stacks its slot entries and the official stats row
  is a centred flex row this plugin does not own, so three things are measured:
  the row is lifted by the official row's height, its content indented to start
  where the official content ends, and the official row is shifted left by half
  of what this pill adds (a `translateX` this plugin sets and clears, never a
  layout change) so the two read as one centred group. A longer official label,
  a changed font size, or a resized window all land in the right place; when the
  group would not fit in the band, the row falls back to a centred line of its
  own with the official row left exactly as the harness drew it.

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
