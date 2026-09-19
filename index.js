/**
 * dsh-cost-audit — host half.
 *
 * Two host-side products, both consumed by the browser half (`./client.js`):
 *
 * 1. The `dshCostAudit` session projection: a whole-log, replay-aware fold of the
 *    billed token buckets into per-turn and whole-session CNY cost. It rides
 *    the same durable log the harness's own `tokenUsage` / `sessionStats`
 *    units ride, so the figures stay correct no matter how much history a
 *    client has paged in. The replacement/retry accounting mirrors
 *    `@deepseek-ai/dsh-token-meter`'s `tokenUsage` unit exactly: an Assistant
 *    settlement replaces its own `(turn, step)` slot, and `llm/retry-started`
 *    closes that slot so a retried attempt adds instead.
 *
 * 2. An exact Connection Fetch route serving (a) the account balance from the
 *    DeepSeek billing API, which is the one figure that is NOT session data and
 *    so is read on demand with a short cache rather than folded into any
 *    projection, and (b) an on-demand fold of one session's log through the
 *    same unit, which covers sessions whose persisted projection checkpoint
 *    predates this plugin.
 *
 * @module dsh-cost-audit
 */

import { z } from "zod";
import { assistantStreamFirstTokenTime, lastAssistantStreamChunk } from "@deepseek-ai/dsh-llm/assistant-stream";
import { credentialRef } from "@deepseek-ai/dsh-credentials";

export const name = "dsh-cost-audit";
export const inject = ["sessionProjections"];

/** The projection key the browser half reads through `useProjection`. */
const PROJECTION_KEY = "dshCostAudit";
/**
 * The account-read endpoint's exact path. It sits under Connection's `/api`
 * prefix so the deployment's Host/Origin fence and browser auth apply, and it
 * is an exact Fetch route, so it is matched before the Gateway's `/api`
 * interceptor ever sees it.
 */
const BALANCE_PATH = "/api/dsh-cost-audit.balance";

/**
 * Official DeepSeek list prices in CNY per 1,000,000 tokens, peak and
 * off-peak. Peak is Beijing time (UTC+8) Monday–Friday 09:00–12:00 and
 * 14:00–18:00; every other hour, plus all of Saturday and Sunday, bills at
 * half — the off-peak table. Source: https://api-docs.deepseek.com/zh-cn/quick_start/pricing
 */
const DEFAULT_PRICING = Object.freeze({
  flash: {
    peak: { cacheHit: 0.04, cacheMiss: 2, output: 8 },
    off: { cacheHit: 0.02, cacheMiss: 1, output: 4 },
  },
  pro: {
    peak: { cacheHit: 0.3, cacheMiss: 9, output: 27 },
    off: { cacheHit: 0.15, cacheMiss: 4.5, output: 13.5 },
  },
});

const THOUSAND = 1000;

/**
 * Advisory thresholds. They are deliberately conservative: an advisor that
 * cries wolf stops being read, so every one of these describes a pattern that
 * is already sustained rather than a single unlucky step.
 */
/** A tool call shorter than this reads as a fragment, not a real step. */
const FAST_CALL_MS = 2000;
/** Sustained fragmentation: at least this many fast calls... */
const FRAGMENT_CALLS = 30;
/** ...and at least this share of that tool's calls. */
const FRAGMENT_SHARE = 0.6;
/** Re-dispatching the same tool with the same target this often is a loop. */
const REPEAT_CALLS = 4;
/** Summary calls that cost at least this share of the session are worth naming. */
const COMPACTION_COST_SHARE = 0.1;
/**
 * …and this many compactions before "often" means anything. Two is not a
 * pattern: it is one automatic compaction plus the one the re-read tip asks for.
 * The count is worth keeping even when the summaries are cheap, because the
 * summaries' own bill is the *small* half of churn — every compaction throws
 * away the cached prefix, and the next requests pay the miss rate for it.
 */
const COMPACTION_CHURN_RUN = 3;
/**
 * How long after a user's `/compact` a `compaction/summary` still counts as the
 * one that command asked for. The summary lands seconds later in practice; the
 * window exists so a stale marker cannot swallow an automatic compaction.
 */
const MANUAL_COMPACT_WINDOW_MS = 300000;
/** Model calls before a cache-hit figure is statistically meaningful. */
const CACHE_SAMPLE = 50;
/** Below this cache-hit share, input bills at the miss rate far more often. */
const CACHE_HIT_FLOOR = 0.85;
/** Model settlements before the re-read share is worth reporting. */
const REREAD_SAMPLE = 30;
/**
 * Share of session spend that must be context re-read before advising. A third
 * is the line: below it, generation and cold input are the bigger stories.
 */
const REREAD_SHARE = 0.35;
/** Consecutive failures of one tool before advising a human stop. */
const FAILURE_RUN = 3;
/** Model retries in one session before advising. */
const RETRY_RUN = 5;
/** Steps without a write, an edit, or a presented deliverable. */
const IDLE_STEPS = 30;
/** Bounded memory for repeated-target and per-tool failure tallies. */
const TARGET_MEMORY = 32;
const TOOL_MEMORY = 24;

//#region config

/**
 * Normalize one peak/off-peak rate triple. Missing or non-positive entries
 * fall back to the shipped default, so a partial override never silently
 * prices a bucket at zero.
 * @param raw - candidate triple from plugin config.
 * @param fallback - the shipped default triple.
 * @returns a complete, finite rate triple.
 */
function rates(raw, fallback) {
  const pick = (value, or) => (typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : or);
  const table = raw !== null && typeof raw === "object" ? raw : {};
  return {
    cacheHit: pick(table.cacheHit, fallback.cacheHit),
    cacheMiss: pick(table.cacheMiss, fallback.cacheMiss),
    output: pick(table.output, fallback.output),
  };
}

/**
 * Resolve the effective plugin config. Every field is optional; unknown or
 * malformed values degrade to the shipped default rather than failing the
 * whole profile boot.
 * @param config - raw config handed to `apply`.
 * @returns the normalized config.
 */
function resolveConfig(config) {
  const raw = config !== null && typeof config === "object" ? config : {};
  const pricing = raw.pricing !== null && typeof raw.pricing === "object" ? raw.pricing : {};
  const family = (id) => {
    const table = pricing[id] !== null && typeof pricing[id] === "object" ? pricing[id] : {};
    return { peak: rates(table.peak, DEFAULT_PRICING[id].peak), off: rates(table.off, DEFAULT_PRICING[id].off) };
  };
  return {
    baseUrl: typeof raw.baseUrl === "string" && raw.baseUrl !== "" ? raw.baseUrl.replace(/\/+$/, "") : "https://api.deepseek.com",
    credentialRef: typeof raw.credentialRef === "string" && raw.credentialRef !== "" ? raw.credentialRef : "DEEPSEEK_API_KEY",
    balanceCacheMs: Number.isSafeInteger(raw.balanceCacheMs) && raw.balanceCacheMs > 0 ? raw.balanceCacheMs : 60000,
    requestTimeoutMs: Number.isSafeInteger(raw.requestTimeoutMs) && raw.requestTimeoutMs > 0 ? raw.requestTimeoutMs : 8000,
    pricing: { flash: family("flash"), pro: family("pro") },
  };
}

/**
 * The DeepSeek price family one model name bills as — matched on the name
 * alone, so proxy and gateway spellings (`deepseek/deepseek-flash`) still
 * price. The name must carry a DeepSeek marker (`v4` or `deepseek`) so a
 * foreign flash/pro-named model is never billed at DeepSeek's rates; anything
 * else is unpriced instead of guessed at.
 * @param model - the route's model id, or "" while unknown.
 * @returns the family id, or null when this plugin has no rate for it.
 */
function familyOf(model) {
  const m = model.toLowerCase();
  if (!m.includes("v4") && !m.includes("deepseek")) return null;
  if (m.includes("flash")) return "flash";
  if (m.includes("pro")) return "pro";
  return null;
}

/**
 * Whether an instant falls in DeepSeek's peak billing window (Beijing time,
 * UTC+8): Monday–Friday 09:00–12:00 and 14:00–18:00.
 * @param time - epoch milliseconds.
 * @returns true for the peak rate.
 */
function isPeak(time) {
  const bj = new Date(time + 28800000);
  const day = bj.getUTCDay();
  if (day === 0 || day === 6) return false;
  const hour = bj.getUTCHours();
  return (hour >= 9 && hour < 12) || (hour >= 14 && hour < 18);
}

//#endregion

//#region buckets

/**
 * One billed bucket shape shared by state and wire. Counts are exact safe
 * integers; `costNano` is CNY × 1e9 so every shipped rate prices exactly
 * (¥0.02/1M is 20 nano per token — no float drift, no rounding of the total).
 */
const bucketShape = {
  uncachedInputTokens: z.number().int().nonnegative(),
  cacheReadTokens: z.number().int().nonnegative(),
  cacheWriteTokens: z.number().int().nonnegative(),
  outputTokens: z.number().int().nonnegative(),
  costNano: z.number().int().nonnegative(),
  /** The cache-read share of `costNano`, kept so the advisor can name it. */
  cacheReadCostNano: z.number().int().nonnegative(),
  /** Tokens this plugin could price (a known DeepSeek family was routed). */
  pricedTokens: z.number().int().nonnegative(),
  /** Tokens left out of `costNano` because the routed model had no rate here. */
  unpricedTokens: z.number().int().nonnegative(),
};

const bucketSchema = z.object(bucketShape).strict();

/**
 * One operation-type timing bucket, kept per turn and for the whole session.
 * Durations are milliseconds; `tools` ranks tool wall time by tool name, which
 * is what answers "where did this turn actually go".
 */
const timingShape = {
  /** turn/start → turn/end. */
  wallMs: z.number().nonnegative(),
  /** step/start → assistant/message: model wait plus generation. */
  modelMs: z.number().nonnegative(),
  modelCalls: z.number().int().nonnegative(),
  /** step/start → first output token. */
  ttftMs: z.number().nonnegative(),
  ttftSteps: z.number().int().nonnegative(),
  /** first output token → assistant/message. */
  decodeMs: z.number().nonnegative(),
  decodeTokens: z.number().nonnegative(),
  /** tool/call → its tool/result, matched by callId. */
  toolMs: z.number().nonnegative(),
  toolCalls: z.number().int().nonnegative(),
  tools: z.record(
    z.string(),
    z.object({ calls: z.number().int().nonnegative(), ms: z.number().nonnegative(), fast: z.number().int().nonnegative() }).strict()
  ),
};

const timingSchema = z.object(timingShape).strict();

/** The timing half of the wire view: totals plus per-turn buckets. */
const timingViewSchema = z.object({ total: timingSchema, turns: z.record(z.string(), timingSchema) }).strict();

const ZERO_TIMING = Object.freeze({
  wallMs: 0,
  modelMs: 0,
  modelCalls: 0,
  ttftMs: 0,
  ttftSteps: 0,
  decodeMs: 0,
  decodeTokens: 0,
  toolMs: 0,
  toolCalls: 0,
  tools: Object.freeze({}),
});

/**
 * Add one timing delta. An absent delta field is zero, so a caller names only
 * what it measured and never restates the bucket's shape.
 * @param left - the accumulated bucket.
 * @param delta - the measurement to fold in.
 * @returns a new bucket.
 */
function addTiming(left, delta) {
  const entries = Object.entries(delta.tools ?? {});
  const tools = entries.length === 0 ? left.tools : { ...left.tools };
  for (const [name, add] of entries) {
    const current = tools[name] ?? { calls: 0, ms: 0, fast: 0 };
    tools[name] = { calls: current.calls + add.calls, ms: current.ms + add.ms, fast: current.fast + (add.fast ?? 0) };
  }
  return {
    wallMs: left.wallMs + (delta.wallMs ?? 0),
    modelMs: left.modelMs + (delta.modelMs ?? 0),
    modelCalls: left.modelCalls + (delta.modelCalls ?? 0),
    ttftMs: left.ttftMs + (delta.ttftMs ?? 0),
    ttftSteps: left.ttftSteps + (delta.ttftSteps ?? 0),
    decodeMs: left.decodeMs + (delta.decodeMs ?? 0),
    decodeTokens: left.decodeTokens + (delta.decodeTokens ?? 0),
    toolMs: left.toolMs + (delta.toolMs ?? 0),
    toolCalls: left.toolCalls + (delta.toolCalls ?? 0),
    tools,
  };
}

/**
 * Fold one timing delta into its turn's bucket and into the session total.
 * @param state - the fold state.
 * @param turn - the turn the delta belongs to.
 * @param delta - the measurement.
 * @returns the next state.
 */
function withTiming(state, turn, delta) {
  const key = String(turn);
  return {
    ...state,
    timing: {
      total: addTiming(state.timing.total, delta),
      turns: { ...state.timing.turns, [key]: addTiming(state.timing.turns[key] ?? ZERO_TIMING, delta) },
    },
  };
}

/** What the whole log says about compaction — the spend no other figure counts. */
const compactionShape = {
  /** Successful `compaction/summary` events. */
  count: z.number().int().nonnegative(),
  /**
   * How many of those followed a user's `/compact`. The advisor judges the
   * automatic ones: a compaction the human asked for — very often because this
   * plugin told them to — is a deliberate cost, not a leak.
   */
  manual: z.number().int().nonnegative(),
  /** `compaction/end` events carrying an error. */
  errors: z.number().int().nonnegative(),
  /** `compaction/prune` events (model-free shadow replacements). */
  prunes: z.number().int().nonnegative(),
  /** Summed `shadowedTokenCount` — context the compaction rewrote. */
  shadowedTokens: z.number().int().nonnegative(),
  /** What the summarization calls themselves billed, in CNY × 1e9. */
  summaryCostNano: z.number().int().nonnegative(),
  /** The user-triggered share of `summaryCostNano`. */
  manualCostNano: z.number().int().nonnegative(),
  /** Tokens those summarization calls billed. */
  summaryTokens: z.number().int().nonnegative(),
};

const compactionSchema = z.object(compactionShape).strict();

const ZERO_COMPACTION = Object.freeze({
  count: 0,
  manual: 0,
  errors: 0,
  prunes: 0,
  shadowedTokens: 0,
  summaryCostNano: 0,
  manualCostNano: 0,
  summaryTokens: 0,
});

/** The bounded raw tallies the advisor reads. State only — never on the wire. */
const signalShape = {
  /** `"<tool>\u0000<target>"` → how often that exact target was dispatched. */
  targets: z.record(z.string(), z.object({ name: z.string(), target: z.string(), count: z.number().int().nonnegative() }).strict()),
  /** Tool name → its failure count. */
  toolErrors: z.record(z.string(), z.number().int().nonnegative()),
  consecutiveFailures: z.number().int().nonnegative(),
  lastFailedTool: z.string(),
  retries: z.number().int().nonnegative(),
  productiveCalls: z.number().int().nonnegative(),
  stepsSinceProductive: z.number().int().nonnegative(),
  productiveThisStep: z.boolean(),
  /** Completed steps, the denominator for "cost per step". */
  steps: z.number().int().nonnegative(),
  /** Dispatches whose target had already been dispatched — the repeat rate. */
  repeatCalls: z.number().int().nonnegative(),
  /** Every tool failure, including names the bounded per-tool table evicted. */
  toolErrorTotal: z.number().int().nonnegative(),
};

const signalsSchema = z.object(signalShape).strict();

const ZERO_SIGNALS = Object.freeze({
  targets: Object.freeze({}),
  toolErrors: Object.freeze({}),
  consecutiveFailures: 0,
  lastFailedTool: "",
  retries: 0,
  productiveCalls: 0,
  stepsSinceProductive: 0,
  productiveThisStep: false,
  steps: 0,
  repeatCalls: 0,
  toolErrorTotal: 0,
});

/** Tools whose call means the session actually produced or shipped something. */
const PRODUCTIVE_TOOLS = Object.freeze(new Set(["write", "edit", "str_replace_editor", "present"]));

/**
 * The stable identity of one tool call's target, for repeat detection: the file
 * it touched, the command's first line, or the pattern it searched for.
 * @param name - tool name.
 * @param argsRaw - the call's raw argument JSON.
 * @returns the target label, or "" when the call has no identity worth tracking.
 */
function targetOf(name, argsRaw) {
  if (typeof argsRaw !== "string" || argsRaw === "") return "";
  try {
    const args = JSON.parse(argsRaw);
    const path = args?.file_path ?? args?.path ?? args?.notebook_path;
    if (typeof path === "string" && path !== "") return path.slice(0, 120);
    const command = args?.command;
    if (typeof command === "string" && command.trim() !== "") return command.trim().split("\n")[0].slice(0, 120);
    const pattern = args?.pattern;
    if (typeof pattern === "string" && pattern !== "") return pattern.slice(0, 120);
  } catch {
    return "";
  }
  return "";
}

/**
 * Bump one bounded tally, evicting the smallest entry once the cap is reached
 * so a hostile log of unique targets cannot grow the state without bound.
 * @param table - the tally table.
 * @param key - the entry key.
 * @param entry - the entry to insert or refresh.
 * @param cap - maximum entries.
 * @returns the next table (the same reference when nothing changed).
 */
function bumpTally(table, key, entry, cap) {
  const existing = table[key];
  if (existing !== undefined) return { ...table, [key]: entry };
  const keys = Object.keys(table);
  if (keys.length < cap) return { ...table, [key]: entry };
  let smallest = keys[0];
  for (const candidate of keys) {
    const left = table[candidate].count ?? table[candidate];
    const right = table[smallest].count ?? table[smallest];
    if (left < right) smallest = candidate;
  }
  const floor = table[smallest].count ?? table[smallest];
  const next = entry.count ?? entry;
  if (next <= floor) return table;
  const { [smallest]: _evicted, ...rest } = table;
  return { ...rest, [key]: entry };
}

/**
 * The provider's output-token count for one settlement, when it reported a
 * usable one (decode throughput divides by exactly this).
 */
function outputTokensOf(usage) {
  if (usage === null || typeof usage !== "object") return null;
  const value = usage.outputTokens;
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}

/** How many calendar days of spend the fold keeps. */
const DAYS_KEPT = 31;

/**
 * The local calendar day of one event, as `YYYY-MM-DD`.
 *
 * The fold keys daily spend to the host's clock — the same clock the browser
 * reads, so "today" means the same thing on both sides — and the keys sort
 * lexicographically, which is what makes trimming the oldest a one-liner.
 *
 * @param time - the event's epoch milliseconds.
 * @returns the day key.
 */
function dayOf(time) {
  const date = new Date(time);
  return `${String(date.getFullYear())}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

/** The newest `DAYS_KEPT` days of spend, for the wire. */
function recentDays(days) {
  const keys = Object.keys(days);
  if (keys.length <= DAYS_KEPT) return days;
  const kept = {};
  for (const key of keys.sort().slice(-DAYS_KEPT)) kept[key] = days[key];
  return kept;
}

/** Prompt-side total of one billed bucket. */
function inputTokensOf(bucket) {
  return bucket.uncachedInputTokens + bucket.cacheReadTokens + bucket.cacheWriteTokens;
}

/** The first output-token instant of one embedded stream, or null when unreadable. */
function firstTokenTimeOf(stream) {
  if (!Array.isArray(stream)) return null;
  const first = assistantStreamFirstTokenTime(stream);
  return typeof first === "number" && Number.isFinite(first) ? first : null;
}

/**
 * Build one wire view from a fold state. Pure, and deliberately uncached: the
 * live unit memoizes around it so a publication only happens on a changed
 * state reference, while an off-request fold (the cold-session read endpoint)
 * must never touch that memo.
 * @param state - a `dshCostAudit` fold state.
 * @returns the client-visible value.
 */
function statsView(state) {
  const turns = {};
  for (const [turn, bucket] of Object.entries(state.turns)) {
    turns[turn] = { ...bucket, model: state.turnModels[turn] ?? state.model };
  }
  return {
    currency: "CNY",
    provider: state.provider,
    model: state.model,
    total: state.total,
    turns,
    timing: state.timing,
    days: recentDays(state.days),
    compaction: state.compaction,
    metrics: statsMetrics(state),
    advice: buildAdvice(state),
  };
}

const ZERO_BUCKET = Object.freeze({
  uncachedInputTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  outputTokens: 0,
  costNano: 0,
  cacheReadCostNano: 0,
  pricedTokens: 0,
  unpricedTokens: 0,
});

const stateSchema = z
  .object({
    provider: z.string(),
    model: z.string(),
    total: bucketSchema,
    /** Turn number (decimal string) → that turn's billed bucket. */
    turns: z.record(z.string(), bucketSchema),
    /** `"<turn>:<step>"` → the settlement currently owning that slot. */
    slots: z.record(z.string(), bucketSchema),
    /** `"<turn>:<step>"` when a retry closed the slot, so the next settlement adds. */
    lastSlot: z.string().nullable(),
    /** Model last seen for each turn, for the per-turn route line. */
    turnModels: z.record(z.string(), z.string()),
    /** Per-turn and whole-session operation-type timings. */
    timing: timingViewSchema,
    /** turn/start instant of the turn in flight, or null between turns. */
    turnStart: z.number().nonnegative().nullable(),
    /** The step awaiting its settlement. */
    openStep: z
      .object({
        turn: z.number().int().nonnegative(),
        step: z.number().int().nonnegative(),
        startTime: z.number().nonnegative(),
        firstTokenTime: z.number().nonnegative().nullable(),
      })
      .strict()
      .nullable(),
    /** Local calendar day → that day's billed spend, in CNY × 1e9. */
    days: z.record(z.string(), z.number().int().nonnegative()),
    /** What the log says about compaction, and what it cost. */
    compaction: compactionSchema,
    /**
     * When the user last ran `/compact`, so the summary it produces can be told
     * apart from the ones the harness decides on its own.
     */
    pendingCompactAt: z.number().nonnegative().nullable(),
    /** Bounded raw tallies the advisor reads. */
    signals: signalsSchema,
    /** callId → dispatched tool call still awaiting its result. */
    pendingCalls: z.record(
      z.string(),
      z.object({ name: z.string(), time: z.number().nonnegative(), turn: z.number().int().nonnegative() }).strict()
    ),
  })
  .strict();

/**
 * Read a provider-reported count as a non-negative safe integer, or null when
 * the field carries nothing readable. Mirrors the harness's own tolerance for
 * gateways that report fractions or negatives.
 * @param value - raw usage field.
 * @returns the count, or null when absent/unreadable.
 */
function countOf(value) {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  const rounded = Math.round(value);
  return Number.isSafeInteger(rounded) && rounded >= 0 ? rounded : null;
}

/**
 * Price one provider usage report under a model family and billing period.
 * @param usage - the provider usage record.
 * @param family - DeepSeek price family, or null when the route is unpriced.
 * @param peak - whether the settlement's instant bills at the peak rate.
 * @param pricing - the effective price table.
 * @returns the billed bucket, or null when the report carries no counts at all.
 */
function priceUsage(usage, family, peak, pricing) {
  const uncached = countOf(usage.inputTokens);
  const cacheRead = countOf(usage.cacheReadTokens);
  const cacheWrite = countOf(usage.cacheWriteTokens);
  const output = countOf(usage.outputTokens);
  if (uncached === null && cacheRead === null && cacheWrite === null && output === null) return null;
  const u = uncached ?? 0;
  const c = cacheRead ?? 0;
  const w = cacheWrite ?? 0;
  const o = output ?? 0;
  const billed = u + c + w + o;
  if (family === null) {
    return { ...ZERO_BUCKET, uncachedInputTokens: u, cacheReadTokens: c, cacheWriteTokens: w, outputTokens: o, unpricedTokens: billed };
  }
  const rate = pricing[family][peak ? "peak" : "off"];
  const cacheReadCostNano = Math.round(c * rate.cacheHit * THOUSAND);
  const costNano =
    cacheReadCostNano + Math.round((u + w) * rate.cacheMiss * THOUSAND) + Math.round(o * rate.output * THOUSAND);
  return {
    uncachedInputTokens: u,
    cacheReadTokens: c,
    cacheWriteTokens: w,
    outputTokens: o,
    costNano,
    cacheReadCostNano,
    pricedTokens: billed,
    unpricedTokens: 0,
  };
}

/**
 * Sum two billed buckets.
 * @param left - accumulated bucket.
 * @param right - bucket to add.
 * @returns a new summed bucket.
 */
function addBuckets(left, right) {
  return {
    uncachedInputTokens: left.uncachedInputTokens + right.uncachedInputTokens,
    cacheReadTokens: left.cacheReadTokens + right.cacheReadTokens,
    cacheWriteTokens: left.cacheWriteTokens + right.cacheWriteTokens,
    outputTokens: left.outputTokens + right.outputTokens,
    costNano: left.costNano + right.costNano,
    cacheReadCostNano: left.cacheReadCostNano + right.cacheReadCostNano,
    pricedTokens: left.pricedTokens + right.pricedTokens,
    unpricedTokens: left.unpricedTokens + right.unpricedTokens,
  };
}

/**
 * `next - previous`, field by field, clamped at zero. A replaced slot always
 * had its previous value added to the running totals, so the result is exact.
 * @param next - the replacement bucket.
 * @param previous - the bucket it replaces, or undefined for a fresh slot.
 * @returns the delta to apply to the totals.
 */
function subtractBuckets(next, previous) {
  if (previous === undefined) return next;
  return {
    uncachedInputTokens: next.uncachedInputTokens - previous.uncachedInputTokens,
    cacheReadTokens: next.cacheReadTokens - previous.cacheReadTokens,
    cacheWriteTokens: next.cacheWriteTokens - previous.cacheWriteTokens,
    outputTokens: next.outputTokens - previous.outputTokens,
    costNano: next.costNano - previous.costNano,
    cacheReadCostNano: next.cacheReadCostNano - previous.cacheReadCostNano,
    pricedTokens: next.pricedTokens - previous.pricedTokens,
    unpricedTokens: next.unpricedTokens - previous.unpricedTokens,
  };
}

/** Whether every field of a delta is zero (the event changes nothing). */
function isZeroBucket(bucket) {
  return (
    bucket.uncachedInputTokens === 0 &&
    bucket.cacheReadTokens === 0 &&
    bucket.cacheWriteTokens === 0 &&
    bucket.outputTokens === 0 &&
    bucket.costNano === 0 &&
    bucket.cacheReadCostNano === 0 &&
    bucket.pricedTokens === 0 &&
    bucket.unpricedTokens === 0
  );
}

/**
 * The provider usage one settlement reports: the message's own `usage` when
 * present, otherwise the last `usage` chunk embedded in the attempt's raw
 * stream. Silence (no readable usage anywhere) stays silent.
 * @param event - an `assistant/message` or `assistant/attempt` event.
 * @returns the usage record, or undefined.
 */
function usageOf(event) {
  const data = event.data;
  if (data === null || typeof data !== "object") return undefined;
  if (event.type === "assistant/message" && data.usage !== null && typeof data.usage === "object") return data.usage;
  const stream = data.stream;
  if (stream === undefined) return undefined;
  const sample = lastAssistantStreamChunk(stream, "usage");
  return sample === null || sample === undefined ? undefined : sample.usage;
}

/**
 * Fold one Assistant settlement's billed usage into its own `(turn, step)`
 * slot. A settlement replaces that slot; `llm/retry-started` closes it first,
 * so a retried attempt adds instead — token-meter's retry rule.
 * @param state - the fold state.
 * @param event - an `assistant/message` or `assistant/attempt` event.
 * @param pricing - the effective price table.
 * @returns the next state.
 */
function foldSettlement(state, event, pricing) {
  const data = event.data;
  const turn = data?.turn;
  const step = data?.step;
  if (!Number.isInteger(turn) || !Number.isInteger(step)) return state;
  const usage = usageOf(event);
  if (usage === undefined) return state;
  const bucket = priceUsage(usage, familyOf(state.model), isPeak(event.time), pricing);
  if (bucket === null) return state;
  const key = `${turn}:${step}`;
  const previous = state.lastSlot === key ? state.slots[key] : undefined;
  const delta = subtractBuckets(bucket, previous);
  if (previous !== undefined && isZeroBucket(delta)) return state;
  const turnKey = String(turn);
  const turns = { ...state.turns, [turnKey]: addBuckets(state.turns[turnKey] ?? ZERO_BUCKET, delta) };
  const turnModels = state.turnModels[turnKey] === state.model ? state.turnModels : { ...state.turnModels, [turnKey]: state.model };
  const day = dayOf(event.time);
  return {
    ...state,
    total: addBuckets(state.total, delta),
    turns,
    turnModels,
    slots: { ...state.slots, [key]: bucket },
    lastSlot: key,
    // A replacement can settle across midnight, so clamp at zero rather than
    // carry a negative day.
    days: { ...state.days, [day]: Math.max(0, (state.days[day] ?? 0) + delta.costNano) },
  };
}

/**
 * Close the step an `assistant/message` settles: model wall time, first-token
 * wait, and decode span all end here.
 * @param state - the fold state.
 * @param event - the settling `assistant/message` event.
 * @returns the next state.
 */
function closeStep(state, event) {
  const open = state.openStep;
  const data = event.data;
  if (open === null || open.turn !== data?.turn || open.step !== data?.step) return state;
  const firstToken = open.firstTokenTime ?? firstTokenTimeOf(data.stream);
  const delta = { modelMs: Math.max(0, event.time - open.startTime), modelCalls: 1 };
  if (firstToken !== null) {
    delta.ttftMs = Math.max(0, firstToken - open.startTime);
    delta.ttftSteps = 1;
    const outputTokens = outputTokensOf(data.usage);
    if (outputTokens !== null) {
      delta.decodeMs = Math.max(0, event.time - firstToken);
      delta.decodeTokens = outputTokens;
    }
  }
  return withTiming({ ...state, openStep: null }, open.turn, delta);
}

/** Whether one tool result reports a failure — its block flag or its logged error identity. */
function isFailedToolResult(event) {
  const data = event.data;
  if (data?.error !== undefined && data.error !== null) return true;
  const content = data?.message?.content;
  return Array.isArray(content) && content.some((block) => block?.isError === true);
}

/**
 * Close the tool call a `tool/result` answers: its wall time goes to the turn
 * that dispatched it and to its own tool name, and its outcome drives the
 * failure run the advisor reads.
 * @param state - the fold state.
 * @param event - the `tool/result` event.
 * @returns the next state.
 */
function closeToolCall(state, event) {
  const callId = event.data?.message?.source?.callId;
  const pending = typeof callId === "string" ? state.pendingCalls[callId] : undefined;
  if (pending === undefined) return state;
  const { [callId]: _closed, ...rest } = state.pendingCalls;
  const ms = Math.max(0, event.time - pending.time);
  const failed = isFailedToolResult(event);
  const signals = {
    ...state.signals,
    consecutiveFailures: failed ? (state.signals.lastFailedTool === pending.name ? state.signals.consecutiveFailures + 1 : 1) : 0,
    lastFailedTool: failed ? pending.name : "",
    toolErrors: failed
      ? bumpTally(state.signals.toolErrors, pending.name, (state.signals.toolErrors[pending.name] ?? 0) + 1, TOOL_MEMORY)
      : state.signals.toolErrors,
    toolErrorTotal: state.signals.toolErrorTotal + (failed ? 1 : 0),
  };
  return withTiming({ ...state, pendingCalls: rest, signals }, pending.turn, {
    toolMs: ms,
    toolCalls: 1,
    tools: { [pending.name]: { calls: 1, ms, fast: ms < FAST_CALL_MS ? 1 : 0 } },
  });
}

/**
 * Fold one successful compaction: its summarize call is a real billed request
 * that no other figure in this deployment counts, so its cost joins the session
 * total and its own sub-account keeps it nameable.
 *
 * The summarize call's tokens deliberately stay out of the chat token buckets —
 * those describe what the conversation read and wrote, and merging a 640K-token
 * replay into them would silently wreck the cache-hit figure.
 *
 * @param state - the fold state.
 * @param event - the `compaction/summary` event.
 * @param pricing - the effective price table.
 * @returns the next state.
 */
function foldCompactionSummary(state, event, pricing) {
  const data = event.data;
  const usage = data?.usage;
  // A `/compact` the user just ran — quite possibly because the advisory panel
  // asked them to — owns the next summary inside the window, and nothing else.
  const manual = state.pendingCompactAt !== null && event.time - state.pendingCompactAt <= MANUAL_COMPACT_WINDOW_MS;
  const compaction = {
    count: state.compaction.count + 1,
    manual: state.compaction.manual + (manual ? 1 : 0),
    errors: state.compaction.errors,
    prunes: state.compaction.prunes,
    shadowedTokens: state.compaction.shadowedTokens + (Number.isSafeInteger(data?.shadowedTokenCount) ? data.shadowedTokenCount : 0),
    summaryCostNano: state.compaction.summaryCostNano,
    manualCostNano: state.compaction.manualCostNano,
    summaryTokens: state.compaction.summaryTokens,
  };
  // Either way the marker is spent: an unclaimed one must not leak into the
  // next automatic compaction.
  const base = { ...state, compaction, pendingCompactAt: null };
  if (usage !== null && typeof usage === "object") {
    const model = typeof data.model === "string" && data.model !== "" ? data.model : state.model;
    const bucket = priceUsage(usage, familyOf(model), isPeak(event.time), pricing);
    if (bucket !== null) {
      compaction.summaryCostNano += bucket.costNano;
      compaction.summaryTokens += bucket.pricedTokens + bucket.unpricedTokens;
      if (manual) compaction.manualCostNano += bucket.costNano;
      const day = dayOf(event.time);
      return {
        ...base,
        total: {
          ...state.total,
          costNano: state.total.costNano + bucket.costNano,
          cacheReadCostNano: state.total.cacheReadCostNano + bucket.cacheReadCostNano,
        },
        days: { ...state.days, [day]: (state.days[day] ?? 0) + bucket.costNano },
      };
    }
  }
  return base;
}

//#endregion

//#region advisor

/**
 * The cumulative counters an adopted tip is judged against. The browser
 * snapshots this object when a tip is applied and compares it with a later
 * reading, so every assessment is "since adoption" rather than a lifetime
 * average that history would drown out.
 *
 * @param state - the fold state.
 * @returns a flat object of numbers.
 */
function statsMetrics(state) {
  let fastCalls = 0;
  for (const tool of Object.values(state.timing.total.tools)) fastCalls += tool.fast;
  return {
    costNano: state.total.costNano,
    cacheReadCostNano: state.total.cacheReadCostNano,
    promptTokens: inputTokensOf(state.total),
    cacheReadTokens: state.total.cacheReadTokens,
    requests: state.timing.total.modelCalls,
    steps: state.signals.steps,
    toolCalls: state.timing.total.toolCalls,
    fastCalls,
    repeatCalls: state.signals.repeatCalls,
    toolErrors: state.signals.toolErrorTotal,
    retries: state.signals.retries,
    compactions: state.compaction.count,
    stepsSinceProductive: state.signals.stepsSinceProductive,
    productiveCalls: state.signals.productiveCalls,
  };
}

const metricsSchema = z
  .object({
    costNano: z.number().nonnegative(),
    cacheReadCostNano: z.number().nonnegative(),
    promptTokens: z.number().nonnegative(),
    cacheReadTokens: z.number().nonnegative(),
    requests: z.number().int().nonnegative(),
    steps: z.number().int().nonnegative(),
    toolCalls: z.number().int().nonnegative(),
    fastCalls: z.number().int().nonnegative(),
    repeatCalls: z.number().int().nonnegative(),
    toolErrors: z.number().int().nonnegative(),
    retries: z.number().int().nonnegative(),
    compactions: z.number().int().nonnegative(),
    stepsSinceProductive: z.number().int().nonnegative(),
    productiveCalls: z.number().int().nonnegative(),
  })
  .strict();

/**
 * The token-saving advice this fold can justify right now, most urgent first.
 *
 * Pure over the fold state, and deliberately conservative: every rule needs a
 * sustained pattern, because an advisor that cries wolf stops being read. The
 * codes are stable identifiers — the browser half owns the wording, so each
 * value here is a number or a name, never a sentence.
 *
 * @param state - the fold state.
 * @returns the advice list (possibly empty).
 */
function buildAdvice(state) {
  const advice = [];
  const total = state.total;
  const signals = state.signals;
  const modelCalls = state.timing.total.modelCalls;

  // Re-reading the same context every turn is usually the largest single line
  // of spend, and the one a smaller context actually fixes.
  if (modelCalls >= REREAD_SAMPLE && total.costNano > 0) {
    const share = total.cacheReadCostNano / total.costNano;
    if (share >= REREAD_SHARE) {
      advice.push({
        code: "context-reread",
        severity: "warn",
        values: { percent: Math.round(share * 100), costNano: total.cacheReadCostNano, totalCostNano: total.costNano, calls: modelCalls },
      });
    }
  }

  // Fragmented calls: many short commands, each dragging its output into the
  // context that every later request re-reads.
  let fragmented;
  for (const [name, tool] of Object.entries(state.timing.total.tools)) {
    if (tool.calls < FRAGMENT_CALLS || tool.fast / tool.calls < FRAGMENT_SHARE) continue;
    if (fragmented === undefined || tool.fast > fragmented.fast) fragmented = { tool: name, calls: tool.calls, fast: tool.fast };
  }
  if (fragmented !== undefined) advice.push({ code: "fragmented-tools", severity: "warn", values: fragmented });

  // The same target dispatched again and again — a re-read, or a loop.
  let repeated;
  for (const entry of Object.values(signals.targets)) {
    if (entry.count < REPEAT_CALLS) continue;
    if (repeated === undefined || entry.count > repeated.count) repeated = entry;
  }
  if (repeated !== undefined) {
    advice.push({ code: "repeated-target", severity: "info", values: { tool: repeated.name, target: repeated.target, count: repeated.count } });
  }

  // Compaction churn, and the summarize calls' own bill — spend no other figure
  // in this deployment counts.
  //
  // Only the *automatic* compactions count, in both gates. The re-read tip above
  // recommends `/compact`, so charging the user churn for a compaction they ran
  // on our own advice is the advisor arguing with itself; the one they asked for
  // is a deliberate cost, and the adopted tip already prints its price.
  //
  // The count gate used to be 2, which had the same defect with one automatic
  // compaction: one plus the one we asked for is not a pattern. Real churn is
  // common and is not our doing — 53, 35 and 17 automatic compactions in three
  // of this machine's own sessions, none of them user-triggered.
  const automatic = {
    count: state.compaction.count - state.compaction.manual,
    costNano: state.compaction.summaryCostNano - state.compaction.manualCostNano,
  };
  const compactionShare = total.costNano === 0 ? 0 : automatic.costNano / total.costNano;
  if (automatic.count >= COMPACTION_CHURN_RUN || compactionShare >= COMPACTION_COST_SHARE) {
    advice.push({
      code: "compaction-churn",
      severity: "warn",
      values: {
        count: state.compaction.count,
        automatic: automatic.count,
        manual: state.compaction.manual,
        costNano: automatic.costNano,
        shadowed: state.compaction.shadowedTokens,
        percent: Math.round(compactionShare * 100),
      },
    });
  }

  // One tool failing over and over: the next attempt is unlikely to be the one
  // that works.
  if (signals.consecutiveFailures >= FAILURE_RUN) {
    advice.push({ code: "tool-failures", severity: "high", values: { tool: signals.lastFailedTool, consecutive: signals.consecutiveFailures } });
  }

  if (signals.retries >= RETRY_RUN) advice.push({ code: "model-retries", severity: "warn", values: { retries: signals.retries } });

  // Many steps, nothing written: investigation without a conclusion.
  if (signals.stepsSinceProductive >= IDLE_STEPS) {
    advice.push({ code: "idle-grinding", severity: "warn", values: { steps: signals.stepsSinceProductive, calls: modelCalls, edits: signals.productiveCalls } });
  }

  // Cache misses bill at roughly fifty times the hit rate, so a fallen hit rate
  // is a silent multiplier on every later request.
  if (modelCalls >= CACHE_SAMPLE) {
    const input = inputTokensOf(total);
    if (input > 0) {
      const hit = total.cacheReadTokens / input;
      if (hit < CACHE_HIT_FLOOR) advice.push({ code: "cache-hit-drop", severity: "info", values: { percent: Math.round(hit * 100), calls: modelCalls } });
    }
  }

  const rank = { high: 0, warn: 1, info: 2 };
  return advice.sort((left, right) => (rank[left.severity] ?? 3) - (rank[right.severity] ?? 3));
}

//#endregion

//#region projection

/**
 * The `dshCostAudit` projection unit. One fold over the whole durable log, so the
 * per-turn and whole-session figures a client renders are complete regardless
 * of how much history that client has paged in.
 * @param pricing - the effective price table.
 * @returns the projection definition handed to `ctx.sessionProjections.register`.
 */
function createStatsProjection(pricing) {
  /** View memo: the framework publishes only when the raw result changes reference. */
  let viewState;
  let viewValue;
  return {
    key: PROJECTION_KEY,
    stateVersion: 6,
    stateSchema,
    init: () => ({
      provider: "",
      model: "",
      total: { ...ZERO_BUCKET },
      turns: {},
      slots: {},
      lastSlot: null,
      turnModels: {},
      timing: { total: ZERO_TIMING, turns: {} },
      turnStart: null,
      openStep: null,
      days: {},
      compaction: ZERO_COMPACTION,
      pendingCompactAt: null,
      signals: ZERO_SIGNALS,
      pendingCalls: {},
    }),
    apply: (state, event) => {
      const type = event.type;
      let next = state;

      if (type === "request/context") {
        const data = event.data;
        const provider = typeof data?.provider === "string" ? data.provider : state.provider;
        const model = typeof data?.model === "string" ? data.model : state.model;
        if (provider !== state.provider || model !== state.model) next = { ...next, provider, model };
      } else if (type === "request/header") {
        const config = event.data?.header?.config;
        const provider = typeof config?.provider === "string" ? config.provider : state.provider;
        const model = typeof config?.model === "string" ? config.model : state.model;
        if (provider !== state.provider || model !== state.model) next = { ...next, provider, model };
      } else if (type === "llm/retry-started") {
        const key = `${event.data.turn}:${event.data.step}`;
        next = {
          ...next,
          ...(state.lastSlot === key ? { lastSlot: null } : {}),
          // A retried attempt opens a fresh tool-failure run.
          signals: { ...state.signals, retries: state.signals.retries + 1, consecutiveFailures: 0, lastFailedTool: "" },
        };
      } else if (type === "turn/start") {
        if (state.turnStart !== event.time || state.openStep !== null) next = { ...next, turnStart: event.time, openStep: null };
      } else if (type === "step/start") {
        const { turn, step } = event.data;
        if (Number.isInteger(turn) && Number.isInteger(step)) {
          next = { ...next, openStep: { turn, step, startTime: event.time, firstTokenTime: null } };
        }
      } else if (type === "assistant/attempt") {
        // The first token can land here, one event before the settlement.
        const open = state.openStep;
        const data = event.data;
        if (open !== null && open.firstTokenTime === null && open.turn === data?.turn && open.step === data?.step) {
          const first = firstTokenTimeOf(data.stream);
          if (first !== null) next = { ...next, openStep: { ...open, firstTokenTime: first } };
        }
      } else if (type === "tool/call") {
        const data = event.data;
        let turn = data?.turn;
        if (!Number.isInteger(turn) && state.openStep !== null) turn = state.openStep.turn;
        if (typeof data?.callId === "string" && typeof data?.name === "string" && Number.isInteger(turn)) {
          const target = targetOf(data.name, data.arguments);
          const key = `${data.name}\u0000${target}`;
          const seen = state.signals.targets[key]?.count ?? 0;
          const targets = target === "" ? state.signals.targets : bumpTally(state.signals.targets, key, { name: data.name, target, count: seen + 1 }, TARGET_MEMORY);
          const productive = PRODUCTIVE_TOOLS.has(data.name);
          next = {
            ...next,
            pendingCalls: { ...state.pendingCalls, [data.callId]: { name: data.name, time: event.time, turn } },
            signals: {
              ...state.signals,
              targets,
              repeatCalls: state.signals.repeatCalls + (seen > 0 ? 1 : 0),
              productiveCalls: state.signals.productiveCalls + (productive ? 1 : 0),
              productiveThisStep: state.signals.productiveThisStep || productive,
            },
          };
        }
      } else if (type === "tool/result") {
        next = closeToolCall(next, event);
      } else if (type === "step/end") {
        const signals = state.signals.productiveThisStep
          ? { ...state.signals, productiveThisStep: false, stepsSinceProductive: 0, steps: state.signals.steps + 1 }
          : { ...state.signals, stepsSinceProductive: state.signals.stepsSinceProductive + 1, steps: state.signals.steps + 1 };
        next = { ...next, openStep: null, signals };
      } else if (type === "compaction/summary") {
        next = foldCompactionSummary(next, event, pricing);
      } else if (type === "command/run") {
        // A user-issued `/compact` — the only compaction this log can attribute
        // to a human. `source.kind` is "user" for the one our own panel submits.
        if (event.data?.name === "compact") next = { ...next, pendingCompactAt: event.time };
      } else if (type === "compaction/end") {
        const failed = typeof event.data?.error === "string" && event.data.error !== "";
        if (failed) next = { ...next, compaction: { ...state.compaction, errors: state.compaction.errors + 1 } };
      } else if (type === "compaction/prune") {
        const shadowed = Number.isSafeInteger(event.data?.shadowedTokenCount) ? event.data.shadowedTokenCount : 0;
        next = { ...next, compaction: { ...state.compaction, prunes: state.compaction.prunes + 1, shadowedTokens: state.compaction.shadowedTokens + shadowed } };
      } else if (type === "turn/end") {
        const turn = event.data?.turn;
        const wallMs = state.turnStart === null ? 0 : Math.max(0, event.time - state.turnStart);
        const open = state.turnStart !== null || Object.keys(state.pendingCalls).length > 0;
        if (open) {
          const cleared = { ...next, turnStart: null, pendingCalls: {} };
          next = Number.isInteger(turn) && wallMs > 0 ? withTiming(cleared, turn, { wallMs }) : cleared;
        }
      }

      if (type === "assistant/message") next = closeStep(next, event);
      if (type === "assistant/message" || type === "assistant/attempt") next = foldSettlement(next, event, pricing);
      return next;
    },
    wire: {
      viewSchema: z
        .object({
          currency: z.literal("CNY"),
          provider: z.string(),
          model: z.string(),
          total: z.object(bucketShape).strict(),
          turns: z.record(z.string(), z.object({ ...bucketShape, model: z.string() }).strict()),
          timing: timingViewSchema,
          days: z.record(z.string(), z.number().int().nonnegative()),
          compaction: compactionSchema,
          metrics: metricsSchema,
          advice: z.array(
            z
              .object({
                code: z.string(),
                severity: z.string(),
                values: z.record(z.string(), z.union([z.number(), z.string()])),
              })
              .strict()
          ),
        })
        .strict(),
      view: (state) => {
        if (state !== viewState) {
          viewState = state;
          viewValue = statsView(state);
        }
        return viewValue;
      },
    },
  };
}

//#endregion

//#region balance route

/**
 * Parse one DeepSeek `/user/balance` answer into CNY figures.
 * @param body - the decoded JSON body.
 * @returns the parsed balance, or null when the body carries no usable row.
 */
function parseBalance(body) {
  const rows = body !== null && typeof body === "object" ? body.balance_infos : undefined;
  if (!Array.isArray(rows)) return null;
  const row = rows.find((entry) => entry !== null && typeof entry === "object" && entry.currency === "CNY") ?? rows[0];
  if (row === null || row === undefined || typeof row !== "object") return null;
  const num = (value) => {
    const parsed = typeof value === "number" ? value : Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  };
  const total = num(row.total_balance);
  if (total === null) return null;
  return {
    currency: typeof row.currency === "string" ? row.currency : "CNY",
    total,
    granted: num(row.granted_balance) ?? 0,
    toppedUp: num(row.topped_up_balance) ?? 0,
  };
}

/**
 * The live account reader: resolves the API key per call (so a rotated
 * credential reaches the next read without a plugin restart), fetches the
 * balance endpoint, and caches the parsed answer briefly. `read` never
 * rejects — a transport or auth failure comes back as structured data the
 * panel can render honestly.
 * @param ctx - the owning Cordis context.
 * @param config - the effective plugin config.
 * @returns the reader.
 */
function createBalanceReader(ctx, config) {
  let cached;
  let cachedAt = 0;
  return async function read() {
    const now = Date.now();
    if (cached !== undefined && now - cachedAt < config.balanceCacheMs) return cached;
    const credentials = ctx.get("credentials");
    if (credentials === undefined) return { ok: false, reason: "no-credentials-service" };
    let key;
    try {
      const resolved = await credentials.resolve(credentialRef(config.credentialRef));
      key = resolved?.value;
    } catch {
      key = undefined;
    }
    if (typeof key !== "string" || key === "") return { ok: false, reason: "no-api-key" };
    try {
      const response = await fetch(`${config.baseUrl}/user/balance`, {
        headers: { authorization: `Bearer ${key}`, accept: "application/json" },
        signal: AbortSignal.timeout(config.requestTimeoutMs),
      });
      if (!response.ok) {
        cached = undefined;
        return { ok: false, reason: "http", status: response.status };
      }
      const balance = parseBalance(await response.json());
      if (balance === null) return { ok: false, reason: "malformed" };
      cached = { ok: true, balance, fetchedAt: now };
      cachedAt = now;
      return cached;
    } catch (error) {
      return { ok: false, reason: "network", message: error instanceof Error ? error.message : String(error) };
    }
  };
}

/**
 * Fold one session's complete log through the projection unit, on demand.
 *
 * The projection pipeline only serves a unit to a client once that session has
 * a materialized cell: a session whose persisted projection checkpoint predates
 * this plugin (every session that existed before install) is served from the
 * checkpoint by the session list, and the checkpoint has no `dshCostAudit` row — so
 * until that session takes one more event the pill would stay empty. This read
 * closes that gap for exactly the session a client is looking at, reusing the
 * same unit definition so the two paths can never disagree.
 *
 * @param ctx - the owning Cordis context.
 * @param unit - the registered projection unit.
 * @param sessionId - the session to fold.
 * @returns the wire view, or a structured failure.
 */
async function foldSession(ctx, unit, sessionId) {
  const query = ctx.get("sessionQuery");
  if (query === undefined) return { ok: false, reason: "no-session-query" };
  let observation;
  try {
    observation = await query.observeSession(sessionId, { projectionMode: "none" });
  } catch {
    return { ok: false, reason: "not-found" };
  }
  try {
    let state = unit.init(observation.header, observation.inheritedEventCount);
    for (const event of observation.events) state = unit.apply(state, event);
    return { ok: true, stats: unit.wire.viewSchema.parse(statsView(state)) };
  } catch (error) {
    return { ok: false, reason: "fold-failed", message: error instanceof Error ? error.message : String(error) };
  } finally {
    observation[Symbol.dispose]?.();
  }
}

/**
 * Mount the account read on Connection's exact Fetch-route registry.
 *
 * A private RPC *channel* (`connection.rpc.handle`) is deliberately NOT used:
 * that path re-reads `webServer` from the Context that registered the
 * Connection service, which cannot see it, so every channel registration
 * raises "cannot get property webServer without inject" and the channel
 * silently never mounts. The Fetch registry has no such dependency, is scoped
 * to this plugin's fiber, and is the documented extension point for a
 * plugin-owned endpoint (`connection.fetch`).
 *
 * The route lives under `/api`, so Connection's own Host/Origin fence and
 * browser authentication apply to it unchanged.
 *
 * @param ctx - the owning Cordis context.
 * @param config - the effective plugin config.
 * @param unit - the registered projection unit, for the on-demand session fold.
 * @returns the live gate, for diagnostics.
 */
function watchBalanceRoute(ctx, config, unit) {
  const gate = { live: false };
  ctx.inject(["connection"], (injected) => {
    // The TRACED property, not `get()`: `connection.fetch` is scoped to the
    // Context reading the service through Cordis's tracker.
    const connection = injected.connection ?? injected.get("connection");
    const register = typeof connection?.fetch?.register === "function" ? connection.fetch.register.bind(connection.fetch) : undefined;
    if (register === undefined) {
      ctx.logger?.warn?.("dsh-cost-audit: connection service exposes no fetch registry — the balance route stays closed");
      return;
    }
    const read = createBalanceReader(ctx, config);
    try {
      injected.effect(
        () =>
          register({
            path: BALANCE_PATH,
            methods: ["POST"],
            requestBody: "buffered",
            fetch: async (request) => {
              const body = await request.json().catch(() => ({}));
              if (body !== null && typeof body === "object" && typeof body.sessionId === "string") {
                return Response.json(await foldSession(ctx, unit, body.sessionId));
              }
              return Response.json(await read());
            },
          }),
        "dsh-cost-audit: balance route"
      );
    } catch (error) {
      ctx.logger?.warn?.("dsh-cost-audit: balance route registration failed: %s", error instanceof Error ? error.message : String(error));
      return;
    }
    gate.live = true;
    return () => {
      gate.live = false;
    };
  });
  return gate;
}

//#endregion

/**
 * Mount the host half: the `dshCostAudit` projection plus the balance channel.
 * @param ctx - the owning Cordis context.
 * @param config - optional plugin config.
 */
export function apply(ctx, config) {
  const resolved = resolveConfig(config);
  const unit = createStatsProjection(resolved.pricing);
  ctx.sessionProjections.register(unit);
  watchBalanceRoute(ctx, resolved, unit);
}
