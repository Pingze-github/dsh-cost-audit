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
/** Account-wide daily totals, merged across every session on this machine. */
const REPORT_PATH = "/api/dsh-cost-audit.report";

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
  /**
   * The thinking subset of `outputTokens`. Billed at the output rate, so it is
   * real money — 57% of all output on this machine — and until this field
   * existed the panel folded it silently into "output".
   */
  reasoningTokens: z.number().int().nonnegative(),
  costNano: z.number().int().nonnegative(),
  /** The cache-read share of `costNano`, kept so the advisor can name it. */
  cacheReadCostNano: z.number().int().nonnegative(),
  /** What the output line cost, so thinking can be priced without a rate lookup. */
  outputCostNano: z.number().int().nonnegative(),
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
  /** When the last compaction ran, or null when none has. */
  lastAt: z.number().nonnegative().nullable(),
  /** What that last compaction's own summarize call billed. */
  lastCostNano: z.number().int().nonnegative(),
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
  lastAt: null,
  lastCostNano: 0,
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
  /**
   * Prompt tokens of the most recently measured request — the live context
   * size. The one-click compaction has to be judged on this, not on the
   * lifetime re-read share that raised the tip: a summarize call is not free,
   * and compacting an already-compacted context buys nothing.
   */
  lastPromptTokens: z.number().int().nonnegative(),
  /** The largest prompt this session ever sent, to tell "small yet" from "small again". */
  peakPromptTokens: z.number().int().nonnegative(),
  /** Whether a compaction ran after that measurement, which makes it a stale reading. */
  compactedSinceRequest: z.boolean(),
  /**
   * The reasoning effort the harness is actually requesting, read off
   * `request/header`. The one lever in this plugin whose money can be counted
   * exactly — thinking is billed at the output rate — so it is worth knowing
   * rather than guessing. Empty when the log never says.
   */
  reasoningEffort: z.string(),
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
  lastPromptTokens: 0,
  peakPromptTokens: 0,
  compactedSinceRequest: false,
  reasoningEffort: "",
});

/** Tools whose name alone means the session actually produced or shipped something. */
const PRODUCTIVE_TOOLS = Object.freeze(new Set(["write", "edit", "str_replace_editor", "present"]));

/** Tools whose arguments carry a command line that has to be read. */
const SHELL_TOOLS = Object.freeze(new Set(["bash", "shell", "sh", "exec", "run", "run_command", "command", "terminal"]));

/**
 * Command shapes that write to the workspace.
 *
 * A tool name is not enough. An agent that patches files through a heredoc or a
 * redirect has produced exactly as much as one that calls `write`, and the
 * session this was found in was 867 shell calls against 107 named writes — enough
 * for the "investigation without output" tip to nag for 36 straight steps while a
 * whole feature was being built. There is no file-change event to read instead:
 * the session log carries `deliverables/presented` but no `fs/*-intent`, so the
 * command text is the only honest signal available.
 *
 * Tuned to *write* shapes rather than to "ran something", because the failure
 * modes are not symmetric: a read-only loop that reads as productive silences a
 * real finding, while a write that reads as idle just repeats a tip that is
 * wrong. Both are wrong, but this list is the one that stays quiet when it should.
 */
const WRITE_SHAPES = Object.freeze([
  /(?<![0-9&])>>?(?!&|>)(?!\s*\/dev\/null)/,
  /<</,
  /\btee\b/,
  /\bsed\b[^\n]*\s-\w*i/,
  /\bgit\s+(add|commit|push|apply|am|merge|rebase|stash|tag|init|checkout|mv|rm|restore)\b/,
  /(?:^|[\s;|&(])(cp|mv|ln|install|touch|truncate|patch|chmod|chown|mkdir|rmdir|tar|unzip|dd)\b/,
  /\b(npm|pnpm|yarn|pip|pip3|apt|apt-get|brew|cargo)\b[^\n]*\b(install|add|remove|uninstall|build|run)\b/,
  /\bgh\s+(repo|pr|release|issue|gist|api)\b/,
  /\bfind\b[^\n]*\s-delete\b/,
]);

/** The command line a shell tool was asked to run, or "" when there is none. */
function commandOf(name, args) {
  if (!SHELL_TOOLS.has(name)) return "";
  let parsed = args;
  if (typeof args === "string") {
    try {
      parsed = JSON.parse(args);
    } catch {
      return "";
    }
  }
  if (parsed === null || typeof parsed !== "object") return "";
  for (const field of ["command", "cmd", "script", "code"]) {
    if (typeof parsed[field] === "string") return parsed[field];
  }
  return "";
}

/**
 * Whether one dispatched call produced something that outlives the turn.
 * @param name - the tool name.
 * @param args - its raw arguments.
 * @returns whether the call counts as output.
 */
function isProductive(name, args) {
  if (PRODUCTIVE_TOOLS.has(name)) return true;
  const command = commandOf(name, args);
  return command !== "" && WRITE_SHAPES.some((shape) => shape.test(command));
}

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
const DAYS_KEPT = 90;

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

/**
 * What one calendar day of billing looked like.
 *
 * Three independent splits, and the report never mixes them up:
 *
 *   - the token axis (`cacheRead` + `uncached` + `output`) sums to `costNano`;
 *   - the tariff axis (`peak` + `offPeak`) also sums to `costNano`;
 *   - `compactionCostNano` is a *subset* of the token axis, not a fourth
 *     sibling — a summarize call's tokens are still cache-read or uncached
 *     tokens, so counting it alongside them would bill the same yuan twice.
 *
 * Splitting is what makes a fall in the total legible: "the re-read halved and
 * the output did not move" is a conclusion, "this week was cheaper" is not.
 *
 * `turns` and `edits` are the denominators the account-wide report divides by.
 * Turns are the human's — no advice of ours can move how often someone types —
 * and edits are the work that came out the other end.
 */
const dayShape = {
  costNano: z.number().int().nonnegative(),
  cacheReadCostNano: z.number().int().nonnegative(),
  uncachedCostNano: z.number().int().nonnegative(),
  outputCostNano: z.number().int().nonnegative(),
  compactionCostNano: z.number().int().nonnegative(),
  peakCostNano: z.number().int().nonnegative(),
  offPeakCostNano: z.number().int().nonnegative(),
  uncachedInputTokens: z.number().int().nonnegative(),
  cacheReadTokens: z.number().int().nonnegative(),
  cacheWriteTokens: z.number().int().nonnegative(),
  outputTokens: z.number().int().nonnegative(),
  reasoningTokens: z.number().int().nonnegative(),
  turns: z.number().int().nonnegative(),
  /**
   * The same denominators again, counted only for requests billed at peak.
   *
   * Splitting the price by tariff is not enough to answer "is this cheaper":
   * a week with more afternoon work rises even after the rates are equalised,
   * because the *sample* moved. These twins are what lets the bill be recomputed
   * over one tariff window at a time. Filled by `addDay`, never by hand.
   */
  peakTurns: z.number().int().nonnegative(),
  peakSteps: z.number().int().nonnegative(),
  peakEdits: z.number().int().nonnegative(),
  peakRequests: z.number().int().nonnegative(),
  peakOutputTokens: z.number().int().nonnegative(),
  peakReasoningTokens: z.number().int().nonnegative(),
  peakCacheReadTokens: z.number().int().nonnegative(),
  peakUncachedInputTokens: z.number().int().nonnegative(),
  peakCacheWriteTokens: z.number().int().nonnegative(),
  peakCacheReadCostNano: z.number().int().nonnegative(),
  peakUncachedCostNano: z.number().int().nonnegative(),
  peakOutputCostNano: z.number().int().nonnegative(),
  peakCompactions: z.number().int().nonnegative(),
  peakCompactionCostNano: z.number().int().nonnegative(),
  steps: z.number().int().nonnegative(),
  toolCalls: z.number().int().nonnegative(),
  edits: z.number().int().nonnegative(),
  requests: z.number().int().nonnegative(),
  compactions: z.number().int().nonnegative(),
};
const daySchema = z.object(dayShape).strict();
const DAY_FIELDS = Object.keys(dayShape);
const ZERO_DAY = Object.freeze(Object.fromEntries(DAY_FIELDS.map((field) => [field, 0])));

/**
 * Fold a partial delta into one calendar day, clamping every field at zero.
 *
 * A retried settlement replaces an earlier one and can therefore carry a
 * negative delta, and a replacement can land after midnight. Clamping keeps
 * that from leaving a negative day behind — the same guard the flat map had.
 *
 * @param days - the calendar map.
 * @param time - the event's instant.
 * @param delta - the fields to add.
 * @returns the next calendar map.
 */
/**
 * The day fields that carry a peak-only twin. Everything the bill divides by, and
 * everything it breaks the cost into, so any basis it offers is recomputable.
 */
const PEAK_TWINS = Object.freeze([
  "turns",
  "steps",
  "edits",
  "requests",
  "outputTokens",
  "reasoningTokens",
  "cacheReadTokens",
  "uncachedInputTokens",
  "cacheWriteTokens",
  "cacheReadCostNano",
  "uncachedCostNano",
  "outputCostNano",
  "compactions",
  "compactionCostNano",
]);

/** The same delta with every twinned field also added to its peak-side twin. */
function withPeakMirror(delta) {
  let mirrored = delta;
  for (const field of PEAK_TWINS) {
    const value = delta[field];
    if (typeof value === "number" && value !== 0) {
      const twin = `peak${field.charAt(0).toUpperCase()}${field.slice(1)}`;
      mirrored = { ...mirrored, [twin]: (mirrored[twin] ?? 0) + value };
    }
  }
  return mirrored;
}

function addDay(days, time, delta) {
  const key = dayOf(time);
  const previous = days[key] ?? ZERO_DAY;
  // The mirror happens here, once, rather than at the eight call sites: every
  // field the bill can restrict to a tariff window is twinned in the same place
  // it is totalled, so no caller can forget.
  const full = isPeak(time) ? withPeakMirror(delta) : delta;
  const next = {};
  for (const field of DAY_FIELDS) next[field] = Math.max(0, previous[field] + (full[field] ?? 0));
  return { ...days, [key]: next };
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
  reasoningTokens: 0,
  costNano: 0,
  outputCostNano: 0,
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
    days: z.record(z.string(), daySchema),
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
function subjectCosts(tokens, family, peak, pricing) {
  if (family === null) return { cacheReadCostNano: 0, uncachedCostNano: 0, outputCostNano: 0 };
  const rate = pricing[family][peak ? "peak" : "off"];
  return {
    cacheReadCostNano: Math.round(tokens.cacheRead * rate.cacheHit * THOUSAND),
    uncachedCostNano: Math.round((tokens.uncached + tokens.cacheWrite) * rate.cacheMiss * THOUSAND),
    outputCostNano: Math.round(tokens.output * rate.output * THOUSAND),
  };
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
    return {
      ...ZERO_BUCKET,
      uncachedInputTokens: u,
      cacheReadTokens: c,
      cacheWriteTokens: w,
      outputTokens: o,
      reasoningTokens: Math.min(o, countOf(usage.reasoningTokens) ?? 0),
      unpricedTokens: billed,
    };
  }
  const parts = subjectCosts({ uncached: u, cacheRead: c, cacheWrite: w, output: o }, family, peak, pricing);
  const costNano = parts.cacheReadCostNano + parts.uncachedCostNano + parts.outputCostNano;
  return {
    uncachedInputTokens: u,
    cacheReadTokens: c,
    cacheWriteTokens: w,
    outputTokens: o,
    reasoningTokens: Math.min(o, countOf(usage.reasoningTokens) ?? 0),
    costNano,
    cacheReadCostNano: parts.cacheReadCostNano,
    outputCostNano: parts.outputCostNano,
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
    reasoningTokens: left.reasoningTokens + right.reasoningTokens,
    outputCostNano: left.outputCostNano + right.outputCostNano,
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
    reasoningTokens: next.reasoningTokens - previous.reasoningTokens,
    outputCostNano: next.outputCostNano - previous.outputCostNano,
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
  const peak = isPeak(event.time);
  const parts = subjectCosts(
    { uncached: delta.uncachedInputTokens, cacheRead: delta.cacheReadTokens, cacheWrite: delta.cacheWriteTokens, output: delta.outputTokens },
    familyOf(state.model),
    peak,
    pricing
  );
  // The day's total is derived from its own split rather than copied from the
  // bucket, so the two can never disagree about the same yuan.
  const dayCost = parts.cacheReadCostNano + parts.uncachedCostNano + parts.outputCostNano;
  return {
    ...state,
    total: addBuckets(state.total, delta),
    turns,
    turnModels,
    slots: { ...state.slots, [key]: bucket },
    lastSlot: key,
    signals: {
      ...state.signals,
      lastPromptTokens: bucket.uncachedInputTokens + bucket.cacheReadTokens + bucket.cacheWriteTokens,
      peakPromptTokens: Math.max(
        state.signals.peakPromptTokens,
        bucket.uncachedInputTokens + bucket.cacheReadTokens + bucket.cacheWriteTokens
      ),
      compactedSinceRequest: false,
    },
    days: addDay(state.days, event.time, {
      costNano: dayCost,
      ...parts,
      peakCostNano: peak ? dayCost : 0,
      offPeakCostNano: peak ? 0 : dayCost,
      uncachedInputTokens: delta.uncachedInputTokens,
      cacheReadTokens: delta.cacheReadTokens,
      cacheWriteTokens: delta.cacheWriteTokens,
      outputTokens: delta.outputTokens,
      reasoningTokens: delta.reasoningTokens,
      requests: 1,
    }),
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
    lastAt: event.time,
    lastCostNano: 0,
  };
  // Either way the marker is spent: an unclaimed one must not leak into the
  // next automatic compaction.
  // The context is about to shrink, so the last measured prompt size no longer
  // describes this session; the tip stays, its one-click action does not.
  const base = { ...state, compaction, pendingCompactAt: null, signals: { ...state.signals, compactedSinceRequest: true } };
  if (usage !== null && typeof usage === "object") {
    const model = typeof data.model === "string" && data.model !== "" ? data.model : state.model;
    const bucket = priceUsage(usage, familyOf(model), isPeak(event.time), pricing);
    if (bucket !== null) {
      compaction.summaryCostNano += bucket.costNano;
      compaction.summaryTokens += bucket.pricedTokens + bucket.unpricedTokens;
      if (manual) compaction.manualCostNano += bucket.costNano;
      compaction.lastCostNano = bucket.costNano;
      const peak = isPeak(event.time);
      const parts = subjectCosts(
        { uncached: bucket.uncachedInputTokens, cacheRead: bucket.cacheReadTokens, cacheWrite: bucket.cacheWriteTokens, output: bucket.outputTokens },
        familyOf(model),
        peak,
        pricing
      );
      const dayCost = parts.cacheReadCostNano + parts.uncachedCostNano + parts.outputCostNano;
      return {
        ...base,
        total: {
          ...state.total,
          costNano: state.total.costNano + bucket.costNano,
          cacheReadCostNano: state.total.cacheReadCostNano + bucket.cacheReadCostNano,
        },
        days: addDay(base.days, event.time, {
          costNano: dayCost,
          ...parts,
          // A subset of the token axis, not a fourth part of it.
          compactionCostNano: dayCost,
          peakCostNano: peak ? dayCost : 0,
          offPeakCostNano: peak ? 0 : dayCost,
          uncachedInputTokens: bucket.uncachedInputTokens,
          cacheReadTokens: bucket.cacheReadTokens,
          cacheWriteTokens: bucket.cacheWriteTokens,
          outputTokens: bucket.outputTokens,
          reasoningTokens: bucket.reasoningTokens,
          compactions: 1,
        }),
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
    reasoningTokens: state.total.reasoningTokens,
    answerTokens: Math.max(0, state.total.outputTokens - state.total.reasoningTokens),
    lastPromptTokens: state.signals.lastPromptTokens,
    peakPromptTokens: state.signals.peakPromptTokens,
    compactedSinceRequest: state.signals.compactedSinceRequest,
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
    reasoningTokens: z.number().int().nonnegative(),
    answerTokens: z.number().int().nonnegative(),
    lastPromptTokens: z.number().int().nonnegative(),
    peakPromptTokens: z.number().int().nonnegative(),
    compactedSinceRequest: z.boolean(),
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
/** Requests needed before an effort downgrade is worth suggesting. */
const EFFORT_SAMPLE = 20;
/** Thinking share of output above which the setting is worth questioning. */
const EFFORT_THINKING_SHARE = 0.4;
/** Average answer tokens per turn below which the thinking is not paying off. */
const EFFORT_ANSWER_FLOOR = 400;

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
        values: {
          percent: Math.round(share * 100),
          costNano: total.cacheReadCostNano,
          totalCostNano: total.costNano,
          calls: modelCalls,
          // What the one-click action has to be judged on. `compactedSinceRequest`
          // travels as 0/1 because the wire only accepts numbers and strings.
          contextTokens: signals.lastPromptTokens,
          peakContextTokens: signals.peakPromptTokens,
          compactedSinceRequest: signals.compactedSinceRequest ? 1 : 0,
          lastCompactionCostNano: state.compaction.lastCostNano,
        },
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

  // Every tip now declares what it is about in money, because the useful
  // question is not "is this a problem" but "is this worth my attention": a
  // pattern that accounts for ¥0.10 of a ¥200 session is noise, and acting on it
  // can cost more than it saves. Tips whose leak is not a bill line say so
  // (`priced: 0`) rather than inventing a figure — only the re-read bill and the
  // summarize calls can be read straight off the log.
  for (const item of advice) {
    if (item.values.costNano === undefined) item.values.costNano = 0;
    if (item.values.share === undefined) {
      item.values.share = total.costNano === 0 ? 0 : Math.round((item.values.costNano / total.costNano) * 100);
    }
    if (item.values.priced === undefined) item.values.priced = item.values.costNano > 0 ? 1 : 0;
  }
  // Two bands. "Act now" is not a money question — a tool failing in a loop and a
  // balance about to run out are about being stuck, not about spend, so those
  // lead whatever they cost. Everything else is ranked by the money involved,
  // because a ¥0.10 pattern must not outrank a ¥50 one for sounding worse.
  // The one lever whose money can be counted exactly: thinking is billed at the
  // output rate, so `reasoningTokens × output rate` is what the setting costs.
  //
  // Deliberately hard to trigger. Deep work deserves the high setting, and a tip
  // that fires mid-reasoning is noise — a noisy advisor stops being read. This
  // needs the setting high AND thinking dominating the output AND the answers
  // short anyway AND little delivered: the shape of "max was left on for a
  // session of small errands", not the shape of a hard problem. The body says as
  // much, so the reader can overrule it.
  const effort = signals.reasoningEffort;
  const turnCount = Object.keys(state.turns).length;
  const answerTokens = Math.max(0, total.outputTokens - total.reasoningTokens);
  const thinkingShare = total.outputTokens === 0 ? 0 : total.reasoningTokens / total.outputTokens;
  const answerPerTurn = turnCount === 0 ? 0 : answerTokens / turnCount;
  const editsPerTurn = turnCount === 0 ? 0 : signals.productiveCalls / turnCount;
  if (
    (effort === "high" || effort === "max") &&
    modelCalls >= EFFORT_SAMPLE &&
    total.reasoningTokens > 0 &&
    thinkingShare >= EFFORT_THINKING_SHARE &&
    answerPerTurn < EFFORT_ANSWER_FLOOR &&
    editsPerTurn < 1
  ) {
    advice.push({
      code: "reasoning-effort",
      severity: "info",
      values: {
        effort,
        percent: Math.round(thinkingShare * 100),
        costNano: total.outputTokens === 0 ? 0 : Math.round(total.reasoningTokens * (total.outputCostNano / total.outputTokens)),
        answer: Math.round(answerPerTurn),
        calls: modelCalls,
      },
    });
  }

  const rank = { high: 0, warn: 1, info: 2 };
  return advice.sort((left, right) => {
    const urgent = Number(right.severity === "high") - Number(left.severity === "high");
    return urgent || right.values.costNano - left.values.costNano || (rank[left.severity] ?? 3) - (rank[right.severity] ?? 3);
  });
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
    stateVersion: 8,
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
        // The effort rides the same header, and it is worth keeping: thinking is
        // billed at the output rate, so this is the one setting in the plugin whose
        // money can be counted exactly instead of estimated.
        const effort = typeof config?.reasoningEffort === "string" && config.reasoningEffort !== ""
          ? config.reasoningEffort
          : state.signals.reasoningEffort;
        const signals = effort === state.signals.reasoningEffort ? state.signals : { ...state.signals, reasoningEffort: effort };
        if (provider !== state.provider || model !== state.model || signals !== state.signals) {
          next = { ...next, provider, model, signals };
        }
      } else if (type === "llm/retry-started") {
        const key = `${event.data.turn}:${event.data.step}`;
        next = {
          ...next,
          ...(state.lastSlot === key ? { lastSlot: null } : {}),
          // A retried attempt opens a fresh tool-failure run.
          signals: { ...state.signals, retries: state.signals.retries + 1, consecutiveFailures: 0, lastFailedTool: "" },
        };
      } else if (type === "turn/start") {
        if (state.turnStart !== event.time || state.openStep !== null) {
          next = { ...next, turnStart: event.time, openStep: null, days: addDay(next.days, event.time, { turns: 1 }) };
        }
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
          const productive = isProductive(data.name, data.arguments);
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
            days: addDay(next.days, event.time, { toolCalls: 1, edits: productive ? 1 : 0 }),
          };
        }
      } else if (type === "tool/result") {
        next = closeToolCall(next, event);
      } else if (type === "step/end") {
        const signals = state.signals.productiveThisStep
          ? { ...state.signals, productiveThisStep: false, stepsSinceProductive: 0, steps: state.signals.steps + 1 }
          : { ...state.signals, stepsSinceProductive: state.signals.stepsSinceProductive + 1, steps: state.signals.steps + 1 };
        next = { ...next, openStep: null, signals, days: addDay(next.days, event.time, { steps: 1 }) };
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
          days: z.record(z.string(), daySchema),
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

/** How long one merged account-wide report is reused before folding again. */
const REPORT_CACHE_MS = 60000;
/** Fold at most this many sessions into one report read, so the sweep is bounded. */
const REPORT_SESSION_CAP = 400;

/**
 * Fold every session on this machine into one calendar map.
 *
 * Per-session figures answer "what did this conversation cost"; they cannot
 * answer "am I spending less than I used to", because each session is different
 * work. Only the calendar is shared, which is why the report is built here from
 * the same day buckets the panel already shows, summed across sessions.
 *
 * Deliberately sequential: this runs on the host that is also serving the
 * conversation, and a burst of parallel log reads would be felt there.
 *
 * @param ctx - the owning Cordis context.
 * @param unit - the registered projection unit.
 * @returns the merged calendar, or a reason it could not be read.
 */
async function foldAccount(ctx, unit) {
  const query = ctx.get("sessionQuery");
  if (query === undefined) return { ok: false, reason: "no-session-query" };
  let records;
  try {
    records = await query.listSessions();
  } catch {
    return { ok: false, reason: "list-failed" };
  }
  if (!Array.isArray(records)) return { ok: false, reason: "list-failed" };
  const merged = {};
  let folded = 0;
  for (const record of records.slice(0, REPORT_SESSION_CAP)) {
    const id = record?.header?.id;
    if (typeof id !== "string") continue;
    let observation;
    try {
      observation = await query.observeSession(id, { projectionMode: "none" });
    } catch {
      continue;
    }
    try {
      let state = unit.init(observation.header, observation.inheritedEventCount);
      for (const event of observation.events) state = unit.apply(state, event);
      for (const [key, day] of Object.entries(state.days)) {
        const previous = merged[key];
        if (previous === undefined) {
          merged[key] = { ...day };
          continue;
        }
        for (const field of DAY_FIELDS) previous[field] += day[field];
      }
      folded += 1;
    } catch {
      continue;
    }
  }
  return { ok: true, days: recentDays(merged), sessions: folded, scanned: records.length };
}

/**
 * The account-wide report, cached briefly.
 *
 * Folding every session costs a full log read each, so a panel that re-renders
 * must not trigger one per render. Nothing here is per-user data the panel
 * cannot get stale for a minute.
 *
 * @param ctx - the owning Cordis context.
 * @param unit - the registered projection unit.
 * @returns an idempotent reader.
 */
function createReportReader(ctx, unit) {
  let cached;
  let cachedAt = 0;
  return async function read() {
    const now = Date.now();
    if (cached !== undefined && now - cachedAt < REPORT_CACHE_MS) return cached;
    const value = await foldAccount(ctx, unit);
    cached = value;
    cachedAt = now;
    return value;
  };
}

//#region fine series

/** A minute/hour-resolution series of per-call means, plus the moments the strategy changed. */
const FINE_PATH = "/api/dsh-cost-audit.fine";
/** Bucket sizes the route serves, clamped to this range. */
const FINE_BUCKET_MIN_MS = 60000;
const FINE_BUCKET_MAX_MS = 3600000;
/** At most this many buckets come back, so one query cannot return a week of minutes. */
const FINE_BUCKET_CAP = 720;
/** Look-back when the caller names no window. */
const FINE_DEFAULT_SPAN_MS = 86400000;
/** Longest window the route will fold. */
const FINE_SPAN_MAX_MS = 2592000000;
/** Newest markers kept. */
const FINE_MARKER_CAP = 200;
/** Windows kept warm, so flipping a switch in the panel does not re-fold every session. */
const FINE_CACHE_ENTRIES = 8;
/**
 * The upper bound of each prompt-size band, in tokens; the last band is open-ended.
 *
 * A daily total cannot say why it moved, and neither can a fine one on its own:
 * the same curve rises when the context gets heavier and when more sessions run
 * at once. Those are also the only two cost drivers a user can actually hold
 * down — the task type is not one of them — so every bucket carries the same
 * figures filed by prompt band, and the bucket names how many sessions it saw.
 * A comparison across strategies is only worth reading inside one band.
 */
const CONTEXT_BANDS = Object.freeze([100000, 200000, 350000]);

/**
 * The band one call's prompt size files under.
 * @param promptTokens - the whole input side of the call.
 * @returns the band index.
 */
function fineBand(promptTokens) {
  for (let index = 0; index < CONTEXT_BANDS.length; index += 1) {
    if (promptTokens < CONTEXT_BANDS[index]) return index;
  }
  return CONTEXT_BANDS.length;
}

/**
 * One empty bucket. `sessions` is a working set; it leaves as its size.
 * @param t - the bucket's start, in epoch milliseconds.
 * @returns the accumulator.
 */
function zeroFineBucket(t) {
  return {
    t,
    calls: 0,
    sessions: new Set(),
    promptTokens: 0,
    cacheReadTokens: 0,
    uncachedInputTokens: 0,
    cacheWriteTokens: 0,
    outputTokens: 0,
    reasoningTokens: 0,
    costNano: 0,
    peakCostNano: 0,
    spawns: 0,
    // One band per edge, plus the open-ended one above the last edge.
    bands: Array.from({ length: CONTEXT_BANDS.length + 1 }, () => ({ calls: 0, promptTokens: 0, cacheReadTokens: 0, uncachedInputTokens: 0, outputTokens: 0, costNano: 0 })),
  };
}

/**
 * The bucket one instant falls in.
 * @param time - epoch milliseconds.
 * @param bucketMs - the requested resolution.
 * @returns the bucket's start.
 */
function fineKey(time, bucketMs) {
  return Math.floor(time / bucketMs) * bucketMs;
}

/**
 * Normalize a fine-series request into a window the fold can trust.
 *
 * The window's end is snapped down to a bucket edge on purpose: the newest
 * bucket is still filling, and a key that moves every second would miss the
 * cache below on every render without ever showing anything new.
 *
 * @param body - the parsed request body.
 * @param now - the host's clock.
 * @returns the window, or null when the body is not an object.
 */
function fineWindow(body, now) {
  if (body === null || typeof body !== "object") return null;
  const asked = typeof body.bucketMs === "number" && Number.isFinite(body.bucketMs) ? Math.floor(body.bucketMs) : FINE_BUCKET_MIN_MS * 5;
  const bucketMs = Math.min(FINE_BUCKET_MAX_MS, Math.max(FINE_BUCKET_MIN_MS, asked));
  const capped = Math.min(now, typeof body.until === "number" && Number.isFinite(body.until) ? body.until : now);
  const end = fineKey(capped, bucketMs);
  const oldest = Math.max(end - FINE_SPAN_MAX_MS, end - bucketMs * FINE_BUCKET_CAP);
  const askedSince = typeof body.since === "number" && Number.isFinite(body.since) ? body.since : end - FINE_DEFAULT_SPAN_MS;
  const since = Math.min(Math.max(fineKey(askedSince, bucketMs), oldest), end - bucketMs);
  const sessionId = typeof body.sessionId === "string" && body.sessionId !== "" ? body.sessionId : undefined;
  return { bucketMs, since, until: end, sessionId };
}

/**
 * Fold the log into per-call buckets, and collect what changed along the way.
 *
 * This reads the same events the daily fold reads and prices them with the same
 * table, so a bucket and the day it belongs to can never disagree about money.
 * Nothing here is persisted: minute resolution for ninety days would bloat every
 * checkpoint on the machine, and the events already carry the time.
 *
 * @param ctx - the owning Cordis context.
 * @param pricing - the resolved price table.
 * @param options - a window from `fineWindow`.
 * @returns the series, or a structured reason it could not be read.
 */
async function foldFine(ctx, pricing, options) {
  const query = ctx.get("sessionQuery");
  if (query === undefined) return { ok: false, reason: "no-session-query" };
  let records;
  if (options.sessionId !== undefined) {
    records = [{ header: { id: options.sessionId } }];
  } else {
    try {
      records = await query.listSessions();
    } catch {
      return { ok: false, reason: "list-failed" };
    }
    if (!Array.isArray(records)) return { ok: false, reason: "list-failed" };
  }
  const buckets = new Map();
  const markers = [];
  let folded = 0;
  let failed = 0;
  for (const record of records.slice(0, REPORT_SESSION_CAP)) {
    const id = record?.header?.id;
    if (typeof id !== "string") continue;
    let observation;
    try {
      observation = await query.observeSession(id, { projectionMode: "none" });
    } catch {
      continue;
    }
    try {
      let model = null;
      let effort = null;
      let announced = false;
      for (const event of observation.events) {
        const time = event.time;
        if (typeof time !== "number" || time > options.until) continue;
        // A header before the window still names the settings in force, so the
        // first call inside it is priced and labelled correctly.
        if (event.type === "request/header") {
          const header = event.data?.header?.config;
          const nextModel = typeof header?.model === "string" ? header.model : model;
          const nextEffort = typeof header?.reasoningEffort === "string" && header.reasoningEffort !== "" ? header.reasoningEffort : effort;
          if (time >= options.since) {
            if (model !== null && nextModel !== null && nextModel !== model) markers.push({ t: time, kind: "model", from: model, to: nextModel, sessionId: id });
            if (effort !== null && nextEffort !== null && nextEffort !== effort) markers.push({ t: time, kind: "effort", from: effort, to: nextEffort, sessionId: id });
          }
          model = nextModel;
          effort = nextEffort;
          continue;
        }
        if (time < options.since) continue;
        if (event.type === "assistant/message") {
          const usage = usageOf(event);
          if (usage === undefined) continue;
          const priced = priceUsage(usage, familyOf(model), isPeak(time), pricing);
          if (priced === null) continue;
          const prompt = priced.uncachedInputTokens + priced.cacheReadTokens + priced.cacheWriteTokens;
          const key = fineKey(time, options.bucketMs);
          let bucket = buckets.get(key);
          if (bucket === undefined) {
            bucket = zeroFineBucket(key);
            buckets.set(key, bucket);
          }
          bucket.calls += 1;
          bucket.sessions.add(id);
          bucket.promptTokens += prompt;
          bucket.cacheReadTokens += priced.cacheReadTokens;
          bucket.uncachedInputTokens += priced.uncachedInputTokens;
          bucket.cacheWriteTokens += priced.cacheWriteTokens;
          bucket.outputTokens += priced.outputTokens;
          bucket.reasoningTokens += priced.reasoningTokens;
          bucket.costNano += priced.costNano;
          if (isPeak(time)) bucket.peakCostNano += priced.costNano;
          const band = bucket.bands[fineBand(prompt)];
          band.calls += 1;
          band.promptTokens += prompt;
          band.cacheReadTokens += priced.cacheReadTokens;
          band.uncachedInputTokens += priced.uncachedInputTokens;
          band.outputTokens += priced.outputTokens;
          band.costNano += priced.costNano;
          if (!announced) {
            announced = true;
            markers.push({ t: time, kind: "session", model, effort, sessionId: id });
          }
        } else if (event.type === "tool/call") {
          const name = event.data?.name;
          if (name === "subagent" || name === "subagent_fork") {
            const key = fineKey(time, options.bucketMs);
            let bucket = buckets.get(key);
            if (bucket === undefined) {
              bucket = zeroFineBucket(key);
              buckets.set(key, bucket);
            }
            bucket.spawns += 1;
            markers.push({ t: time, kind: "spawn", name, sessionId: id });
          }
        } else if (event.type === "command/run") {
          markers.push({ t: time, kind: "command", name: String(event.data?.name ?? ""), sessionId: id });
        } else if (event.type === "compaction/summary") {
          markers.push({ t: time, kind: "compaction", sessionId: id });
        } else if (event.type === "permission/preset" || event.type === "sandbox/mode" || event.type === "approval/policy") {
          markers.push({ t: time, kind: "setting", setting: event.type, value: JSON.stringify(event.data ?? null).slice(0, 80), sessionId: id });
        }
      }
      folded += 1;
    } catch {
      // A session this fold cannot read leaves a partially filled bucket behind,
      // so it is reported rather than dropped: a silent skip would make the
      // series look complete when it is not.
      failed += 1;
      continue;
    } finally {
      observation[Symbol.dispose]?.();
    }
  }
  const series = [...buckets.values()].sort((left, right) => left.t - right.t);
  // Empty days at either end are the window, not the work: a trailing bucket
  // that never filled only stretches the axis.
  while (series.length > 0 && series[0].calls === 0 && series[0].spawns === 0) series.shift();
  while (series.length > 0 && series.at(-1).calls === 0 && series.at(-1).spawns === 0) series.pop();
  markers.sort((left, right) => left.t - right.t);
  return {
    ok: true,
    bucketMs: options.bucketMs,
    since: options.since,
    until: options.until,
    bands: [...CONTEXT_BANDS],
    buckets: series.map((bucket) => ({ ...bucket, sessions: bucket.sessions.size })),
    markers: markers.slice(-FINE_MARKER_CAP),
    sessions: folded,
    failed,
    scanned: records.length,
  };
}

/**
 * The fine series, cached per window.
 *
 * Folding every session costs a full log read each, and the panel asks again on
 * every switch. `fineWindow` snaps the end to a bucket edge, so the same request
 * lands on the same key instead of missing forever on a moving timestamp.
 *
 * @param ctx - the owning Cordis context.
 * @param pricing - the resolved price table.
 * @returns the cached reader.
 */
function createFineReader(ctx, pricing) {
  const cached = new Map();
  return async function read(options) {
    const key = `${String(options.bucketMs)}|${String(options.since)}|${String(options.until)}|${options.sessionId ?? ""}`;
    const now = Date.now();
    const hit = cached.get(key);
    if (hit !== undefined && now - hit.at < REPORT_CACHE_MS) return hit.value;
    const value = await foldFine(ctx, pricing, options);
    cached.set(key, { at: now, value });
    if (cached.size > FINE_CACHE_ENTRIES) cached.delete(cached.keys().next().value);
    return value;
  };
}

//#endregion

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
 * @param unit - the registered projection unit, for the on-demand session fold and the report.
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
    const report = createReportReader(ctx, unit);
    const fine = createFineReader(ctx, config.pricing);
    // One registration per effect, each announced separately: a route the
    // registry rejects must not take the other one down with it, and the log has
    // to name which one died. Learned the hard way — `requestBody` is a required
    // field on a Fetch route ('buffered' | 'streaming'), and omitting it made the
    // report route throw and vanish behind a message about the balance route.
    const mount = (label, definition) => {
      try {
        injected.effect(() => register(definition), `dsh-cost-audit: ${label}`);
        return true;
      } catch (error) {
        ctx.logger?.warn?.(`dsh-cost-audit: ${label} registration failed: %s`, error instanceof Error ? error.message : String(error));
        return false;
      }
    };
    const balanceLive = mount("balance route", {
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
    });
    const reportLive = mount("account report route", {
      path: REPORT_PATH,
      methods: ["POST"],
      requestBody: "buffered",
      fetch: async () => Response.json(await report()),
    });
    const fineLive = mount("fine route", {
      path: FINE_PATH,
      methods: ["POST"],
      requestBody: "buffered",
      fetch: async (request) => {
        const body = await request.json().catch(() => null);
        const options = fineWindow(body, Date.now());
        if (options === null) return Response.json({ ok: false, reason: "bad-request" });
        return Response.json(await fine(options));
      },
    });
    gate.live = balanceLive && reportLive && fineLive;
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
