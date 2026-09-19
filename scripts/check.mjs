/**
 * dsh-stats host-half checks: drive the `dshStats` projection unit over
 * synthetic session logs and assert the billed maths, the replacement/retry
 * accounting, the state/view schemas, and the change-reference contract the
 * projection framework relies on.
 *
 * The unit is captured from a fake Cordis context, so this exercises the real
 * shipped code path (`apply` → `sessionProjections.register`) rather than a
 * copy of it.
 *
 * @module dsh-stats/scripts/check
 */

import assert from "node:assert/strict";

//#region harness

const registrations = [];
const injects = [];
const routes = [];
const noop = () => {};

/** One fake Connection service exposing only the Fetch-route registry. */
const services = {
	connection: {
		fetch: {
			register(route) {
				routes.push(route);
				return noop;
			}
		}
	},
	webServer: {},
	credentials: {
		async resolve() {
			return { value: process.env.DSH_STATS_TEST_KEY ?? "sk-test", source: "test" };
		}
	}
};

/** Build the context an `inject(deps, callback)` call hands its callback. */
function injectedContext(deps) {
	const injected = {
		get: (name) => services[name],
		effect: (callback) => {
			const disposer = callback();
			return typeof disposer === "function" ? disposer : noop;
		},
		logger: { info() {}, warn() {} }
	};
	for (const dep of deps) injected[dep] = services[dep];
	return injected;
}

const ctx = {
	sessionProjections: {
		register(definition) {
			registrations.push(definition);
			return noop;
		}
	},
	inject(deps, callback) {
		injects.push([...deps]);
		if (typeof callback === "function") callback(injectedContext(deps));
		return noop;
	},
	get(name) {
		return services[name];
	},
	effect() {
		return noop;
	},
	logger: { info() {}, warn() {} }
};

const mod = await import("../index.js");
assert.equal(mod.name, "dsh-stats", "plugin name");
assert.deepEqual(mod.inject, ["sessionProjections"], "declared injection");
mod.apply(ctx, {});

assert.equal(registrations.length, 1, "exactly one projection unit registered");
const unit = registrations[0];
assert.equal(unit.key, "dshStats", "projection key");
assert.equal(typeof unit.wire?.view, "function", "unit publishes a client view");

// Connection registers a channel as a webserver route through the READING
// context, so that context must inject `webServer` too — otherwise the
// registration dies with "cannot get property webServer without inject". The
// shipped transport avoids that path entirely by using Connection's exact
// Fetch registry, which has no such dependency.
const channelInject = injects.find((deps) => deps.includes("connection"));
assert.ok(channelInject !== undefined, "the balance endpoint is armed through an injection");
assert.equal(routes.length, 1, "exactly one balance route registered");
const balanceRoute = routes[0];
assert.equal(balanceRoute.path, "/api/dsh-stats.balance", "the route sits on Connection's /api prefix");
assert.deepEqual(balanceRoute.methods, ["POST"], "the route answers POST");
assert.equal(typeof balanceRoute.fetch, "function", "the route is servable");

//#region live account read

{
	const realFetch = globalThis.fetch;
	const calls = [];
	globalThis.fetch = async (url, init) => {
		calls.push({ url: String(url), init });
		return {
			ok: true,
			json: async () => ({
				is_available: true,
				balance_infos: [{ currency: "CNY", total_balance: "24.16", granted_balance: "0.00", topped_up_balance: "24.16" }]
			})
		};
	};
	try {
		const response = await balanceRoute.fetch(new Request("http://dsh.internal/api/dsh-stats.balance", { method: "POST" }));
		const value = await response.json();
		assert.equal(value.ok, true, "the route reports success");
		assert.deepEqual(value.balance, { currency: "CNY", total: 24.16, granted: 0, toppedUp: 24.16 }, "the balance is parsed");
		assert.equal(calls.length, 1, "exactly one upstream read");
		assert.equal(calls[0].url, "https://api.deepseek.com/user/balance", "the upstream endpoint");
		assert.equal(calls[0].init.headers.authorization, "Bearer sk-test", "the resolved credential is used");
		// The reader caches, so a second read must not hit the network again.
		await balanceRoute.fetch(new Request("http://dsh.internal/api/dsh-stats.balance", { method: "POST" }));
		assert.equal(calls.length, 1, "the second read is served from the cache");
	} finally {
		globalThis.fetch = realFetch;
	}
}

{
	// A missing credential is reported as such, never as a generic failure.
	const realResolve = services.credentials.resolve;
	const realFetch = globalThis.fetch;
	let fetched = false;
	services.credentials.resolve = async () => undefined;
	globalThis.fetch = async () => {
		fetched = true;
		return { ok: true, json: async () => ({}) };
	};
	try {
		// A fresh route so the previous cache cannot answer.
		const before = routes.length;
		const fresh = await import(`../index.js?probe=${Date.now()}`);
		fresh.apply(ctx, { balanceCacheMs: 0 });
		assert.equal(routes.length, before + 1, "the re-imported plugin registers its own route");
		const value = await (await routes.at(-1).fetch(new Request("http://dsh.internal/api/dsh-stats.balance"))).json();
		assert.equal(value.ok, false, "no credential is a reported failure");
		assert.equal(value.reason, "no-api-key", "the failure names the missing credential");
		assert.equal(fetched, false, "no upstream call is attempted without a key");
	} finally {
		services.credentials.resolve = realResolve;
		globalThis.fetch = realFetch;
	}
}

//#endregion

/**
 * Fold one event list through the unit, validating every intermediate state
 * against the unit's own schema and asserting the reference contract (an
 * uninterested event must return the same state reference).
 * @param events - synthetic session events.
 * @returns the final state and view.
 */
function fold(events) {
	let state = unit.init({}, 0);
	unit.stateSchema.parse(state);
	for (const event of events) {
		const next = unit.apply(state, event);
		assert.ok(next !== undefined && next !== null, `apply returned nothing for ${event.type}`);
		if (event.__uninteresting === true) assert.equal(next, state, `${event.type} should not change the state`);
		unit.stateSchema.parse(next);
		state = next;
	}
	const view = unit.wire.view(state);
	unit.wire.viewSchema.parse(view);
	return { state, view };
}

/** Beijing-time instant as epoch milliseconds. */
function bjt(year, month, day, hour) {
	return Date.UTC(year, month - 1, day, hour - 8, 0, 0);
}

/** A route event. */
function route(model, provider = "deepseek-official") {
	return { type: "request/context", seq: 1, time: 0, data: { provider, model } };
}

/** An Assistant settlement. */
function settle(turn, step, usage, time, type = "assistant/message") {
	return { type, seq: 2, time, data: { turn, step, usage } };
}

/** CNY price of one bucket, for expectation arithmetic. */
function cny(nano) {
	return nano / 1e9;
}

//#endregion

//#region calendar

const PEAK = bjt(2026, 9, 21, 10); // Monday 10:00 Beijing — peak window
const OFF = bjt(2026, 9, 21, 13); // Monday 13:00 Beijing — between the two peak windows
const WEEKEND = bjt(2026, 9, 19, 10); // Saturday 10:00 Beijing — off-peak all day
assert.equal(new Date(PEAK).getUTCDay(), 1, "PEAK must be a Monday");
assert.equal(new Date(WEEKEND).getUTCDay(), 6, "WEEKEND must be a Saturday");

//#endregion

//#region on-demand session fold

{
	// A session whose persisted projection checkpoint predates this plugin is
	// served by the on-demand fold instead of the live projection pipeline.
	const events = [
		{ type: "request/context", seq: 0, time: PEAK, data: { provider: "deepseek-official", model: "deepseek-flash" } },
		{ type: "assistant/message", seq: 1, time: PEAK, data: { turn: 1, step: 1, usage: { inputTokens: 1000, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 0 } } },
		{ type: "assistant/message", seq: 2, time: PEAK, data: { turn: 2, step: 1, usage: { inputTokens: 0, cacheReadTokens: 1000000, cacheWriteTokens: 0, outputTokens: 1000 } } }
	];
	let disposed = 0;
	services.sessionQuery = {
		async observeSession(sessionId) {
			if (sessionId !== "session-known") throw new Error("not found");
			return {
				header: { id: sessionId },
				inheritedEventCount: 0,
				events,
				[Symbol.dispose]() {
					disposed += 1;
				}
			};
		}
	};
	const call = (body) =>
		balanceRoute.fetch(new Request("http://dsh.internal/api/dsh-stats.balance", { method: "POST", body: JSON.stringify(body) }));
	const ok = await (await call({ sessionId: "session-known" })).json();
	assert.equal(ok.ok, true, "the on-demand fold reports success");
	assert.equal(ok.stats.total.costNano, 1000 * 2 * 1000 + 1000000 * 0.04 * 1000 + 1000 * 8 * 1000, "the fold prices the whole log");
	assert.equal(Object.keys(ok.stats.turns).length, 2, "the fold carries every turn");
	assert.equal(disposed, 1, "the observation lease is released");
	const missing = await (await call({ sessionId: "nope" })).json();
	assert.deepEqual(missing, { ok: false, reason: "not-found" }, "an unknown session is a reported failure");
	delete services.sessionQuery;
}

//#endregion

//#region billing maths

const USAGE = { inputTokens: 1000, cacheReadTokens: 9000, cacheWriteTokens: 0, outputTokens: 500 };
// flash peak: 0.04 / 2 / 8 CNY per 1M; nano = tokens × rate × 1000.
const FLASH_PEAK = 9000 * 0.04 * 1000 + (1000 + 0) * 2 * 1000 + 500 * 8 * 1000;

{
	const { view } = fold([route("deepseek-flash"), settle(1, 1, USAGE, PEAK)]);
	assert.equal(view.total.uncachedInputTokens, 1000, "uncached input");
	assert.equal(view.total.cacheReadTokens, 9000, "cache read");
	assert.equal(view.total.outputTokens, 500, "output");
	assert.equal(view.total.costNano, FLASH_PEAK, "flash peak cost");
	assert.equal(cny(view.total.costNano).toFixed(5), "0.00636", "flash peak cost in CNY");
	assert.equal(view.total.pricedTokens, 10500, "priced tokens");
	assert.equal(view.total.unpricedTokens, 0, "no unpriced tokens");
	assert.equal(view.turns["1"].costNano, FLASH_PEAK, "turn bucket carries the same cost");
	assert.equal(view.turns["1"].model, "deepseek-flash", "turn route recorded");
}

{
	// Off-peak is exactly half the peak rate on every bucket.
	const { view } = fold([route("deepseek-flash"), settle(1, 1, USAGE, OFF)]);
	assert.equal(view.total.costNano, FLASH_PEAK / 2, "off-peak halves the flash cost");
}

{
	const { view } = fold([route("deepseek-flash"), settle(1, 1, USAGE, WEEKEND)]);
	assert.equal(view.total.costNano, FLASH_PEAK / 2, "weekends bill off-peak");
}

{
	// v4-pro has its own listed rates (0.30 / 9 / 27 peak).
	const proPeak = 9000 * 0.3 * 1000 + 1000 * 9 * 1000 + 500 * 27 * 1000;
	const { view } = fold([route("deepseek-v4-pro"), settle(1, 1, USAGE, PEAK)]);
	assert.equal(view.total.costNano, proPeak, "pro peak cost");
}

{
	// Cache writes bill at the miss rate, like uncached input.
	const usage = { inputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 2000, outputTokens: 0 };
	const { view } = fold([route("deepseek-flash"), settle(1, 1, usage, PEAK)]);
	assert.equal(view.total.costNano, 2000 * 2 * 1000, "cache write bills at the miss rate");
}

{
	// A non-DeepSeek model is counted but never billed.
	const { view } = fold([route("gemini-2.0-flash"), settle(1, 1, USAGE, PEAK)]);
	assert.equal(view.total.costNano, 0, "foreign model is not priced");
	assert.equal(view.total.pricedTokens, 0, "no priced tokens");
	assert.equal(view.total.unpricedTokens, 10500, "every token is reported unpriced");
	assert.equal(view.total.cacheReadTokens, 9000, "tokens are still counted");
}

{
	// Absent optional buckets read as zero rather than failing the fold.
	const { view } = fold([route("deepseek-flash"), settle(1, 1, { inputTokens: 10, outputTokens: 1 }, PEAK)]);
	assert.equal(view.total.cacheReadTokens, 0, "absent cache read");
	assert.equal(view.total.cacheWriteTokens, 0, "absent cache write");
}

{
	// A usage report with no readable counts changes nothing.
	const before = fold([route("deepseek-flash"), settle(1, 1, USAGE, PEAK)]);
	const after = fold([route("deepseek-flash"), settle(1, 1, USAGE, PEAK), { ...settle(2, 1, {}, PEAK), __uninteresting: true }]);
	assert.equal(after.view.total.costNano, before.view.total.costNano, "empty usage adds nothing");
}

//#endregion

//#region replacement and retry accounting

{
	// A second settlement for the same (turn, step) REPLACES the first.
	const second = { inputTokens: 100, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 10 };
	const { view } = fold([route("deepseek-flash"), settle(1, 1, USAGE, PEAK), settle(1, 1, second, PEAK)]);
	assert.equal(view.total.uncachedInputTokens, 100, "replacement drops the superseded input");
	assert.equal(view.total.cacheReadTokens, 0, "replacement drops the superseded cache read");
	assert.equal(view.total.costNano, 100 * 2 * 1000 + 10 * 8 * 1000, "replacement reprices the slot");
}

{
	// llm/retry-started closes the slot, so the retried attempt ADDS.
	const retry = { type: "llm/retry-started", seq: 3, time: PEAK, data: { turn: 1, step: 1 } };
	const second = { inputTokens: 100, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 10 };
	const { view } = fold([route("deepseek-flash"), settle(1, 1, USAGE, PEAK), retry, settle(1, 1, second, PEAK)]);
	assert.equal(view.total.cacheReadTokens, 9000, "the retried attempt keeps the first try's tokens");
	assert.equal(view.total.uncachedInputTokens, 1100, "the retried attempt adds its own input");
	assert.equal(view.total.costNano, FLASH_PEAK + 100 * 2 * 1000 + 10 * 8 * 1000, "both attempts are billed");
	assert.equal(view.turns["1"].costNano, view.total.costNano, "the turn aggregates both attempts");
}

{
	// A retry marker for an unrelated step must not open a new slot.
	const stale = { type: "llm/retry-started", seq: 3, time: PEAK, data: { turn: 9, step: 9 } };
	const second = { inputTokens: 100, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 10 };
	const { view } = fold([route("deepseek-flash"), settle(1, 1, USAGE, PEAK), stale, settle(1, 1, second, PEAK)]);
	assert.equal(view.total.cacheReadTokens, 0, "an unrelated retry marker leaves the slot replaceable");
}

{
	// An attempt settlement replaces the message settlement when it carries a
	// usable usage chunk; without one it changes nothing.
	const attemptUsage = { inputTokens: 1, cacheReadTokens: 2, cacheWriteTokens: 0, outputTokens: 3 };
	const withStream = {
		type: "assistant/attempt",
		seq: 3,
		time: PEAK,
		data: { turn: 1, step: 1, stream: [{ type: "chunk", time: PEAK, chunk: { type: "usage", usage: attemptUsage } }] }
	};
	const { view } = fold([route("deepseek-flash"), settle(1, 1, USAGE, PEAK), withStream]);
	assert.equal(view.total.uncachedInputTokens, 1, "attempt settlement replaces");
	assert.equal(view.total.outputTokens, 3, "attempt output replaces");
}

{
	// An attempt with no embedded usage chunk is silence, not a zero report.
	const empty = { type: "assistant/attempt", seq: 3, time: PEAK, data: { turn: 1, step: 1, stream: [] } };
	const { view } = fold([route("deepseek-flash"), settle(1, 1, USAGE, PEAK), { ...empty, __uninteresting: true }]);
	assert.equal(view.total.cacheReadTokens, 9000, "an attempt without usage leaves the slot alone");
}

//#endregion

//#region aggregation and contract

{
	const { view } = fold([
		route("deepseek-flash"),
		settle(1, 1, { inputTokens: 100, outputTokens: 10 }, PEAK),
		settle(1, 2, { inputTokens: 200, outputTokens: 20 }, PEAK),
		settle(2, 1, { inputTokens: 400, outputTokens: 40 }, PEAK)
	]);
	assert.equal(view.turns["1"].uncachedInputTokens, 300, "turn 1 sums its steps");
	assert.equal(view.turns["2"].uncachedInputTokens, 400, "turn 2 is isolated");
	assert.equal(view.total.uncachedInputTokens, 700, "session total");
	assert.equal(Object.keys(view.turns).length, 2, "two turns tracked");
}

{
	// Uninteresting events must not move the state reference.
	const state = unit.init({}, 0);
	const inert = [
		{ type: "system/message", data: {} },
		{ type: "user/message", data: {} },
		{ type: "step/end", data: { turn: 1, step: 1 } },
		{ type: "turn/end", data: { turn: 1, reason: { kind: "completed" } } },
		{ type: "tool/result", data: { turn: 1, step: 1, message: { source: { callId: "unknown" } } } },
		{ type: "llm/retry-started", data: { turn: 9, step: 9 } }
	];
	for (const { type, data } of inert) {
		assert.equal(unit.apply(state, { type, seq: 1, time: PEAK, data }), state, `${type} must be ignored`);
	}
	const routed = unit.apply(state, route("deepseek-flash"));
	assert.equal(unit.apply(routed, route("deepseek-flash")), routed, "an unchanged route report is ignored");
}

//#region timing

{
	// One turn: 1s to dispatch, first token 0.5s later, a 3.5s generation, a
	// 3s tool call, and a 10s turn.
	const T0 = PEAK;
	const stream = (time) => [{ type: "chunk", time, chunk: { type: "text-delta", text: "x" } }];
	const { view } = fold([
		route("deepseek-flash"),
		{ type: "turn/start", seq: 1, time: T0, data: { turn: 1 } },
		{ type: "step/start", seq: 2, time: T0 + 1000, data: { turn: 1, step: 1 } },
		{ type: "assistant/attempt", seq: 3, time: T0 + 4000, data: { turn: 1, step: 1, stream: stream(T0 + 1500) } },
		{ type: "assistant/message", seq: 4, time: T0 + 5000, data: { turn: 1, step: 1, usage: { inputTokens: 10, outputTokens: 100 }, stream: stream(T0 + 1500) } },
		{ type: "tool/call", seq: 5, time: T0 + 6000, data: { turn: 1, step: 1, callId: "c1", name: "bash", arguments: "{}" } },
		{ type: "tool/result", seq: 6, time: T0 + 9000, data: { turn: 1, step: 1, message: { source: { callId: "c1" } } } },
		{ type: "step/end", seq: 7, time: T0 + 9000, data: { turn: 1, step: 1 } },
		{ type: "turn/end", seq: 8, time: T0 + 10000, data: { turn: 1, reason: { kind: "completed" } } }
	]);
	const timing = view.timing.total;
	assert.equal(timing.wallMs, 10000, "turn wall time");
	assert.equal(timing.modelMs, 4000, "model wall time");
	assert.equal(timing.modelCalls, 1, "model call count");
	assert.equal(timing.ttftMs, 500, "first-token wait");
	assert.equal(timing.decodeMs, 3500, "decode span");
	assert.equal(timing.decodeTokens, 100, "decode tokens");
	assert.equal(timing.toolMs, 3000, "tool wall time");
	assert.equal(timing.toolCalls, 1, "tool call count");
	assert.deepEqual(timing.tools, { bash: { calls: 1, ms: 3000 } }, "tool ranking");
	assert.deepEqual(view.timing.turns["1"], timing, "the turn carries the same timings");
}

{
	// A tool call with no result yet leaves the total alone, and a turn that
	// never opened a step still records its wall time.
	const T0 = PEAK;
	const { view } = fold([
		{ type: "turn/start", seq: 1, time: T0, data: { turn: 3 } },
		{ type: "tool/call", seq: 2, time: T0 + 100, data: { turn: 3, step: 1, callId: "c9", name: "read", arguments: "{}" } },
		{ type: "turn/end", seq: 3, time: T0 + 2000, data: { turn: 3, reason: { kind: "cancelled" } } }
	]);
	assert.equal(view.timing.total.toolMs, 0, "an unanswered tool call bills no time");
	assert.equal(view.timing.total.wallMs, 2000, "the turn's wall time is recorded");
}

{
	// Two tool calls under one name accumulate into one ranking entry.
	const T0 = PEAK;
	const call = (seq, id, at) => [
		{ type: "tool/call", seq, time: T0 + at, data: { turn: 1, step: 1, callId: id, name: "grep", arguments: "{}" } },
		{ type: "tool/result", seq: seq + 1, time: T0 + at + 500, data: { turn: 1, step: 1, message: { source: { callId: id } } } }
	];
	const { view } = fold([
		{ type: "turn/start", seq: 1, time: T0, data: { turn: 1 } },
		...call(2, "a", 1000),
		...call(4, "b", 3000)
	]);
	assert.deepEqual(view.timing.total.tools, { grep: { calls: 2, ms: 1000 } }, "same-name tool calls accumulate");
	assert.equal(view.timing.total.toolCalls, 2, "both calls counted");
}

//#endregion

{
	// The view memo must hand back one reference until the state changes.
	const events = [route("deepseek-flash"), settle(1, 1, USAGE, PEAK)];
	let state = unit.init({}, 0);
	for (const event of events) state = unit.apply(state, event);
	assert.equal(unit.wire.view(state), unit.wire.view(state), "unchanged state reuses the view reference");
	const next = unit.apply(state, settle(2, 1, USAGE, PEAK));
	assert.notEqual(unit.wire.view(next), unit.wire.view(state), "changed state publishes a new view");
}

{
	// Route tracking: request/header also names the model, and a change of
	// model reprices the next settlement.
	const header = {
		type: "request/header",
		seq: 1,
		time: PEAK,
		data: { header: { config: { provider: "deepseek-official", model: "deepseek-v4-pro" } }, reason: "change" }
	};
	const { view } = fold([header, settle(1, 1, { inputTokens: 1000, outputTokens: 0 }, PEAK)]);
	assert.equal(view.model, "deepseek-v4-pro", "header names the model");
	assert.equal(view.total.costNano, 1000 * 9 * 1000, "header model prices the request");
}

{
	// A settlement with no route at all is counted and left unpriced.
	const { view } = fold([settle(1, 1, USAGE, PEAK)]);
	assert.equal(view.total.costNano, 0, "no route, no price");
	assert.equal(view.total.unpricedTokens, 10500, "tokens reported unpriced");
}

//#endregion

process.stdout.write(`check: dsh-stats host half OK (${registrations.length} projection units, ${routes.length} balance routes)\n`);
