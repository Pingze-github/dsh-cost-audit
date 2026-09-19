/**
 * dsh-stats — host half.
 *
 * Two host-side products, both consumed by the browser half (`./client.js`):
 *
 * 1. The `dshStats` session projection: a whole-log, replay-aware fold of the
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
 * @module dsh-stats
 */

import { z } from "zod";
import { lastAssistantStreamChunk } from "@deepseek-ai/dsh-llm/assistant-stream";
import { credentialRef } from "@deepseek-ai/dsh-credentials";

export const name = "dsh-stats";
export const inject = ["sessionProjections"];

/** The projection key the browser half reads through `useProjection`. */
const PROJECTION_KEY = "dshStats";
/**
 * The account-read endpoint's exact path. It sits under Connection's `/api`
 * prefix so the deployment's Host/Origin fence and browser auth apply, and it
 * is an exact Fetch route, so it is matched before the Gateway's `/api`
 * interceptor ever sees it.
 */
const BALANCE_PATH = "/api/dsh-stats.balance";

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
  /** Tokens this plugin could price (a known DeepSeek family was routed). */
  pricedTokens: z.number().int().nonnegative(),
  /** Tokens left out of `costNano` because the routed model had no rate here. */
  unpricedTokens: z.number().int().nonnegative(),
};

const bucketSchema = z.object(bucketShape).strict();

/**
 * Build one wire view from a fold state. Pure, and deliberately uncached: the
 * live unit memoizes around it so a publication only happens on a changed
 * state reference, while an off-request fold (the cold-session read endpoint)
 * must never touch that memo.
 * @param state - a `dshStats` fold state.
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
  };
}

const ZERO_BUCKET = Object.freeze({
  uncachedInputTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  outputTokens: 0,
  costNano: 0,
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
  const costNano =
    Math.round(c * rate.cacheHit * THOUSAND) +
    Math.round((u + w) * rate.cacheMiss * THOUSAND) +
    Math.round(o * rate.output * THOUSAND);
  return {
    uncachedInputTokens: u,
    cacheReadTokens: c,
    cacheWriteTokens: w,
    outputTokens: o,
    costNano,
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

//#endregion

//#region projection

/**
 * The `dshStats` projection unit. One fold over the whole durable log, so the
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
    stateVersion: 1,
    stateSchema,
    init: () => ({
      provider: "",
      model: "",
      total: { ...ZERO_BUCKET },
      turns: {},
      slots: {},
      lastSlot: null,
      turnModels: {},
    }),
    apply: (state, event) => {
      if (event.type === "request/context") {
        const data = event.data;
        const provider = typeof data?.provider === "string" ? data.provider : state.provider;
        const model = typeof data?.model === "string" ? data.model : state.model;
        return provider === state.provider && model === state.model ? state : { ...state, provider, model };
      }
      if (event.type === "request/header") {
        const config = event.data?.header?.config;
        const provider = typeof config?.provider === "string" ? config.provider : state.provider;
        const model = typeof config?.model === "string" ? config.model : state.model;
        return provider === state.provider && model === state.model ? state : { ...state, provider, model };
      }
      // A retried attempt is a SECOND billed request: closing the slot here is
      // what makes the next settlement add instead of replace (token-meter's
      // own retry rule).
      if (event.type === "llm/retry-started") {
        const data = event.data;
        const key = `${data.turn}:${data.step}`;
        return state.lastSlot === key ? { ...state, lastSlot: null } : state;
      }
      if (event.type !== "assistant/message" && event.type !== "assistant/attempt") return state;
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
      return {
        ...state,
        total: addBuckets(state.total, delta),
        turns,
        turnModels,
        slots: { ...state.slots, [key]: bucket },
        lastSlot: key,
      };
    },
    wire: {
      viewSchema: z
        .object({
          currency: z.literal("CNY"),
          provider: z.string(),
          model: z.string(),
          total: z.object(bucketShape).strict(),
          turns: z.record(z.string(), z.object({ ...bucketShape, model: z.string() }).strict()),
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
 * checkpoint by the session list, and the checkpoint has no `dshStats` row — so
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
      ctx.logger?.warn?.("dsh-stats: connection service exposes no fetch registry — the balance route stays closed");
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
        "dsh-stats: balance route"
      );
    } catch (error) {
      ctx.logger?.warn?.("dsh-stats: balance route registration failed: %s", error instanceof Error ? error.message : String(error));
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
 * Mount the host half: the `dshStats` projection plus the balance channel.
 * @param ctx - the owning Cordis context.
 * @param config - optional plugin config.
 */
export function apply(ctx, config) {
  const resolved = resolveConfig(config);
  const unit = createStatsProjection(resolved.pricing);
  ctx.sessionProjections.register(unit);
  watchBalanceRoute(ctx, resolved, unit);
}
