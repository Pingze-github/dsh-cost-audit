/**
 * dsh-cost-audit host-half checks: drive the `dshCostAudit` projection unit over
 * synthetic session logs and assert the billed maths, the replacement/retry
 * accounting, the state/view schemas, and the change-reference contract the
 * projection framework relies on.
 *
 * The unit is captured from a fake Cordis context, so this exercises the real
 * shipped code path (`apply` → `sessionProjections.register`) rather than a
 * copy of it.
 *
 * @module dsh-cost-audit/scripts/check
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

const RETRIES = 5;
const mod = await import("../index.js");
assert.equal(mod.name, "dsh-cost-audit", "plugin name");
assert.deepEqual(mod.inject, ["sessionProjections"], "declared injection");
mod.apply(ctx, {});

assert.equal(registrations.length, 1, "exactly one projection unit registered");
const unit = registrations[0];
assert.equal(unit.key, "dshCostAudit", "projection key");
assert.equal(typeof unit.wire?.view, "function", "unit publishes a client view");

// Connection registers a channel as a webserver route through the READING
// context, so that context must inject `webServer` too — otherwise the
// registration dies with "cannot get property webServer without inject". The
// shipped transport avoids that path entirely by using Connection's exact
// Fetch registry, which has no such dependency.
const channelInject = injects.find((deps) => deps.includes("connection"));
assert.ok(channelInject !== undefined, "the balance endpoint is armed through an injection");
const balanceRoute = routes.find((route) => route.path.endsWith(".balance"));
const reportRoute = routes.find((route) => route.path.endsWith(".report"));
assert.equal(routes.length, 2, "exactly two routes registered");
assert.ok(balanceRoute !== undefined, "the balance route is registered");
assert.ok(reportRoute !== undefined, "the report route is registered");
assert.equal(balanceRoute.path, "/api/dsh-cost-audit.balance", "the balance route sits on Connection's /api prefix");
assert.equal(reportRoute.path, "/api/dsh-cost-audit.report", "the report route sits on Connection's /api prefix");
assert.deepEqual(balanceRoute.methods, ["POST"], "the balance route answers POST");
assert.deepEqual(reportRoute.methods, ["POST"], "the report route answers POST");
// The registry requires a body mode; omitting it made the route throw at mount
// and disappear behind the other route's error message.
assert.equal(balanceRoute.requestBody, "buffered", "the balance route declares a body mode");
assert.equal(reportRoute.requestBody, "buffered", "the report route declares a body mode");
assert.equal(typeof balanceRoute.fetch, "function", "the balance route is servable");
assert.equal(typeof reportRoute.fetch, "function", "the report route is servable");

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
		const response = await balanceRoute.fetch(new Request("http://dsh.internal/api/dsh-cost-audit.balance", { method: "POST" }));
		const value = await response.json();
		assert.equal(value.ok, true, "the route reports success");
		assert.deepEqual(value.balance, { currency: "CNY", total: 24.16, granted: 0, toppedUp: 24.16 }, "the balance is parsed");
		assert.equal(calls.length, 1, "exactly one upstream read");
		assert.equal(calls[0].url, "https://api.deepseek.com/user/balance", "the upstream endpoint");
		assert.equal(calls[0].init.headers.authorization, "Bearer sk-test", "the resolved credential is used");
		// The reader caches, so a second read must not hit the network again.
		await balanceRoute.fetch(new Request("http://dsh.internal/api/dsh-cost-audit.balance", { method: "POST" }));
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
		const freshRoutes = routes.slice(before);
		assert.equal(freshRoutes.length, 2, "the re-imported plugin registers its own routes");
		const freshBalance = freshRoutes.find((route) => route.path.endsWith(".balance"));
		assert.ok(freshBalance !== undefined, "the re-imported plugin registers its own balance route");
		const value = await (await freshBalance.fetch(new Request("http://dsh.internal/api/dsh-cost-audit.balance"))).json();
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
		balanceRoute.fetch(new Request("http://dsh.internal/api/dsh-cost-audit.balance", { method: "POST", body: JSON.stringify(body) }));
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

//#region account report

{
	// The report sums the same day buckets across sessions — the only figure that
	// can answer "am I spending less than I used to", since one session is one
	// piece of work and they are not comparable.
	const usage = { inputTokens: 1000, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 0 };
	const time = PEAK;
	const log = (seq) => [
		{ type: "request/context", seq, time, data: { provider: "deepseek-official", model: "deepseek-flash" } },
		{ type: "assistant/message", seq: seq + 1, time, data: { turn: 1, step: 1, usage } }
	];
	services.sessionQuery = {
		async listSessions() {
			return [{ header: { id: "session-a" } }, { header: { id: "session-b" } }, { header: { id: "session-gone" } }];
		},
		async observeSession(sessionId) {
			if (sessionId === "session-gone") throw new Error("not found");
			return { header: { id: sessionId }, inheritedEventCount: 0, events: log(sessionId === "session-a" ? 1 : 10) };
		}
	};
	const response = await reportRoute.fetch(new Request("http://dsh.internal/api/dsh-cost-audit.report", { method: "POST" }));
	const report = await response.json();
	delete services.sessionQuery;
	assert.equal(report.ok, true, "the report is served");
	assert.equal(report.sessions, 2, "both readable sessions are folded");
	assert.equal(report.scanned, 3, "the unreadable one is counted as scanned, not folded");
	const day = report.days[dayKey(time)];
	assert.equal(day.costNano, 4000000, "the day sums both sessions");
	assert.equal(day.requests, 2, "both settlements are counted");
	assert.equal(day.cacheReadCostNano + day.uncachedCostNano + day.outputCostNano, day.costNano, "the merged day still closes on its token axis");
	assert.equal(day.peakCostNano + day.offPeakCostNano, day.costNano, "the merged day still closes on its tariff axis");
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
		{ type: "turn/end", data: { turn: 1, reason: { kind: "completed" } } },
		{ type: "tool/result", data: { turn: 1, step: 1, message: { source: { callId: "unknown" } } } },
		{ type: "compaction/end", data: { compactionId: "none", turn: null } }
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
	assert.deepEqual(timing.tools, { bash: { calls: 1, ms: 3000, fast: 0 } }, "tool ranking");
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
	assert.deepEqual(view.timing.total.tools, { grep: { calls: 2, ms: 1000, fast: 2 } }, "same-name tool calls accumulate");
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

//#region compaction accounting

{
	// A summarize call is a real billed request that no other figure counts.
	const T0 = PEAK;
	const { view } = fold([
		route("deepseek-flash"),
		{ type: "compaction/start", seq: 1, time: T0, data: { compactionId: "c1", turn: null } },
		{
			type: "compaction/summary",
			seq: 2,
			time: T0 + 100,
			data: {
				compactionId: "c1",
				summary: [],
				shadowedRange: { start: 0, end: 1 },
				shadowedSeqs: [0, 1],
				shadowedTokenCount: 640000,
				provider: "deepseek-official",
				model: "deepseek-flash",
				rawOutput: [],
				llmStreamCall: true,
				usage: { inputTokens: 0, cacheReadTokens: 640000, cacheWriteTokens: 0, outputTokens: 2000 }
			}
		},
		{ type: "compaction/end", seq: 3, time: T0 + 200, data: { compactionId: "c1", turn: null } }
	]);
	assert.equal(view.compaction.count, 1, "compaction counted");
	assert.equal(view.compaction.errors, 0, "no error recorded");
	assert.equal(view.compaction.shadowedTokens, 640000, "shadowed tokens summed");
	assert.equal(view.compaction.summaryCostNano, 640000 * 0.04 * 1000 + 2000 * 8 * 1000, "summary priced at its own model");
	assert.equal(view.total.costNano, view.compaction.summaryCostNano, "summary cost joins the session total");
	assert.equal(view.total.cacheReadCostNano, 640000 * 0.04 * 1000, "its cache-read share is kept");
	assert.equal(view.total.cacheReadTokens, 0, "the summarize replay stays out of the chat buckets");
	assert.equal(view.timing.total.modelCalls, 0, "a summary is not a chat model call");
}

{
	// A failed compaction and a model-free prune.
	const T0 = PEAK;
	const { view } = fold([
		{ type: "compaction/start", seq: 1, time: T0, data: { compactionId: "c1", turn: null } },
		{ type: "compaction/end", seq: 2, time: T0 + 10, data: { compactionId: "c1", turn: null, error: "summarize failed" } },
		{ type: "compaction/prune", seq: 3, time: T0 + 20, data: { shadowedRange: { start: 0, end: 2 }, shadowedSeqs: [0, 1, 2], shadowedTokenCount: 1234 } }
	]);
	assert.equal(view.compaction.count, 0, "a failed compaction is not a summary");
	assert.equal(view.compaction.errors, 1, "the failure is recorded");
	assert.equal(view.compaction.prunes, 1, "the prune is counted");
	assert.equal(view.compaction.shadowedTokens, 1234, "the prune's shadow price is counted");
}

//#endregion

//#region daily spend

/**
 * The local calendar day of one instant. The fold keys days to the host's own
 * clock, so the test asks the same clock rather than assuming a timezone — the
 * assertions that matter are the grouping and the sums.
 */
function dayKey(time) {
	const date = new Date(time);
	return `${String(date.getFullYear())}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

{
	const usage = { inputTokens: 1000, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 0 };
	const t1 = bjt(2026, 9, 21, 10);
	const t2 = bjt(2026, 9, 22, 10);
	const { view } = fold([route("deepseek-flash"), settle(1, 1, usage, t1), settle(1, 2, usage, t2), settle(1, 3, usage, t2)]);
	assert.equal(Object.keys(view.days).length, 2, "spend is bucketed by local day");
	assert.equal(view.days[dayKey(t1)].costNano, 2000000, "the first day holds its own settlement");
	assert.equal(view.days[dayKey(t2)].costNano, 4000000, "the second day holds both of its own");
	assert.equal(view.total.costNano, 6000000, "the days add up to the session total");
}

{
	// Two settlements of one slot: the second replaces, so the day follows.
	const first = { inputTokens: 10000, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 0 };
	const second = { inputTokens: 100, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 0 };
	const time = bjt(2026, 9, 21, 10);
	const { view } = fold([route("deepseek-flash"), settle(1, 1, first, time), settle(1, 1, second, time + 1000)]);
	assert.equal(view.days[dayKey(time)].costNano, 200000, "a replacement corrects its own day");
}

{
	// A compaction bills to the day it ran.
	const time = bjt(2026, 9, 21, 10);
	const { view } = fold([
		route("deepseek-flash"),
		{
			type: "compaction/summary",
			seq: 1,
			time,
			data: {
				compactionId: "c1",
				summary: [],
				shadowedRange: { start: 0, end: 1 },
				shadowedSeqs: [0],
				shadowedTokenCount: 10,
				provider: "deepseek-official",
				model: "deepseek-flash",
				rawOutput: [],
				llmStreamCall: true,
				usage: { inputTokens: 1000, outputTokens: 0 }
			}
		}
	]);
	assert.equal(view.days[dayKey(time)].costNano, 2000000, "a summarize call counts toward its day");
}

{
	// The wire keeps the newest 90 days only — enough for a quarterly view.
	const usage = { inputTokens: 1000, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 0 };
	const events = [route("deepseek-flash")];
	for (let index = 0; index < 100; index += 1) events.push(settle(1, index + 1, usage, bjt(2026, 7, 1, 10) + index * 86400000));
	const { view } = fold(events);
	assert.equal(Object.keys(view.days).length, 90, "daily history is bounded");
	assert.ok(!Object.hasOwn(view.days, dayKey(bjt(2026, 7, 1, 10))), "the oldest day is dropped");
	assert.ok(Object.hasOwn(view.days, dayKey(bjt(2026, 7, 1, 10) + 99 * 86400000)), "the newest day is kept");
}

{
	// A day is a bucket now, and both of its splits have to add up to the same
	// total, or the report's "why did it move" is arithmetic that does not close.
	const usage = { inputTokens: 1000, cacheReadTokens: 100000, cacheWriteTokens: 0, outputTokens: 500 };
	const peakTime = bjt(2026, 9, 21, 10); // Monday 10:00 — inside the peak window
	const offTime = bjt(2026, 9, 22, 13); // Tuesday 13:00 — between the two windows, and its own day
	const { view } = fold([route("deepseek-flash"), settle(1, 1, usage, peakTime), settle(2, 1, usage, offTime)]);
	const peakDay = view.days[dayKey(peakTime)];
	const offDay = view.days[dayKey(offTime)];
	for (const [name, day] of [["peak", peakDay], ["off-peak", offDay]]) {
		assert.equal(day.cacheReadCostNano + day.uncachedCostNano + day.outputCostNano, day.costNano, `${name}: the token axis sums to the day`);
		assert.equal(day.peakCostNano + day.offPeakCostNano, day.costNano, `${name}: the tariff axis sums to the day`);
		assert.equal(day.requests, 1, `${name}: one settlement is counted`);
	}
	assert.equal(peakDay.peakCostNano, peakDay.costNano, "a peak settlement lands on the peak side");
	assert.equal(offDay.offPeakCostNano, offDay.costNano, "an off-peak settlement lands on the off side");
	assert.equal(peakDay.costNano, offDay.costNano * 2, "the same tokens bill at double inside the peak window");
	assert.equal(offDay.cacheReadTokens, 100000, "a day keeps its own token counts");
}

{
	// The counters the report divides by: turns are the human's, edits are output.
	const time = bjt(2026, 9, 21, 10);
	const events = [
		route("deepseek-flash"),
		{ type: "turn/start", seq: 1, time, data: { turn: 1 } },
		settle(1, 1, { inputTokens: 100, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 0 }, time),
		...toolCalls(1, "write", JSON.stringify({ file_path: "/tmp/a.js", content: "x" }), 100, time + 10),
		...toolCalls(1, "bash", JSON.stringify({ command: "echo hi" }), 100, time + 20)
	];
	const day = fold(events).view.days[dayKey(time)];
	assert.equal(day.turns, 1, "a turn is counted on its day");
	assert.equal(day.toolCalls, 2, "tool calls are counted on their day");
	assert.equal(day.edits, 1, "only a productive tool counts as an edit");
}

//#endregion

//#region metrics

{
	// The counters an adopted tip is judged against.
	const { view } = fold([
		route("deepseek-flash"),
		{ type: "step/start", seq: 1, time: PEAK, data: { turn: 1, step: 1 } },
		settle(1, 1, { inputTokens: 1000, cacheReadTokens: 1000, cacheWriteTokens: 0, outputTokens: 10 }, PEAK + 500),
		{ type: "step/end", seq: 2, time: PEAK + 600, data: { turn: 1, step: 1 } },
		...toolCalls(3, "read", JSON.stringify({ file_path: "/tmp/a.js" }), 50, PEAK + 700)
	]);
	assert.equal(view.metrics.steps, 1, "steps counted");
	assert.equal(view.metrics.requests, 1, "settlements counted");
	assert.equal(view.metrics.promptTokens, 2000, "prompt tokens summed");
	assert.equal(view.metrics.toolCalls, 3, "tool calls counted");
	assert.equal(view.metrics.fastCalls, 3, "short calls counted");
	assert.equal(view.metrics.repeatCalls, 2, "the second and third dispatch repeat one target");
	assert.equal(view.metrics.retries, 0, "retries counted");
	assert.equal(view.metrics.productiveCalls, 0, "reads are not productive");
}

{
	// Failures total independently of the bounded per-tool table.
	const events = [route("deepseek-flash")];
	for (let index = 0; index < 4; index += 1) {
		events.push({ type: "tool/call", seq: index * 2, time: PEAK, data: { turn: 1, step: 1, callId: `f${String(index)}`, name: "bash", arguments: JSON.stringify({ command: `false ${String(index)}` }) } });
		events.push({ type: "tool/result", seq: index * 2 + 1, time: PEAK + 5, data: { turn: 1, step: 1, message: { source: { callId: `f${String(index)}` } }, error: { name: "ToolError", code: "exit-1" } } });
	}
	const { view } = fold(events);
	assert.equal(view.metrics.toolErrors, 4, "every failure is totalled");
	assert.equal(view.metrics.toolCalls, 4, "every dispatch is counted");
}

//#endregion

//#region advisor

/** The advice codes one event list produces. */
function adviceCodes(events) {
	return fold(events).view.advice.map((item) => item.code);
}

/** `count` completed steps, each a cache-read-heavy settlement. */
function settlements(count, time) {
	const events = [];
	for (let index = 0; index < count; index += 1) {
		events.push({ type: "step/start", seq: index * 2, time, data: { turn: 1, step: index + 1 } });
		events.push(
			settle(1, index + 1, { inputTokens: 1000, cacheReadTokens: 100000, cacheWriteTokens: 0, outputTokens: 10 }, time + 1000)
		);
	}
	return events;
}

/**
 * `count` dispatched-and-finished tool calls of one name, each `ms` long.
 * `args` is a literal, or a generator when every call must target something new.
 */
function toolCalls(count, name, args, ms, time) {
	const events = [];
	for (let index = 0; index < count; index += 1) {
		const raw = typeof args === "function" ? args(index) : args;
		events.push({ type: "tool/call", seq: index, time, data: { turn: 1, step: 1, callId: `c${String(index)}`, name, arguments: raw } });
		events.push({ type: "tool/result", seq: index, time: time + ms, data: { turn: 1, step: 1, message: { source: { callId: `c${String(index)}` } } } });
	}
	return events;
}

{
	assert.deepEqual(adviceCodes([route("deepseek-flash")]), [], "a fresh session advises nothing");
}

{
	assert.ok(adviceCodes([route("deepseek-flash"), ...settlements(30, PEAK)]).includes("context-reread"), "context re-read share");
	assert.deepEqual(adviceCodes([route("deepseek-flash"), ...settlements(29, PEAK)]), [], "too few calls to judge");
}

{
	const events = [route("deepseek-flash"), ...toolCalls(30, "bash", (index) => JSON.stringify({ command: `echo ${String(index)}` }), 100, PEAK)];
	assert.ok(adviceCodes(events).includes("fragmented-tools"), "fragmented short calls");
	assert.ok(!adviceCodes(events).includes("repeated-target"), "distinct commands are not a repeat");
}

{
	const slow = [route("deepseek-flash"), ...toolCalls(30, "bash", (index) => JSON.stringify({ command: `sleep 5 # ${String(index)}` }), 9000, PEAK)];
	assert.deepEqual(adviceCodes(slow), [], "long calls are not fragments");
}

{
	const events = [route("deepseek-flash"), ...toolCalls(4, "read", JSON.stringify({ file_path: "/tmp/big.js" }), 10, PEAK)];
	const codes = adviceCodes(events);
	assert.ok(codes.includes("repeated-target"), "repeated target");
}

{
	// The count gate used to be 2, which meant the re-read tip's own recommended
	// `/compact` immediately produced a second compaction and this rule fired on
	// the user's own compliance. Three is a pattern; two is one automatic
	// compaction plus the one we asked for.
	const T0 = PEAK;
	const summary = (seq, id, usage = { inputTokens: 10, outputTokens: 10 }) => [
		{ type: "compaction/start", seq, time: T0, data: { compactionId: id, turn: null } },
		{
			type: "compaction/summary",
			seq: seq + 1,
			time: T0 + 10,
			data: {
				compactionId: id,
				summary: [],
				shadowedRange: { start: 0, end: 1 },
				shadowedSeqs: [0],
				shadowedTokenCount: 1000,
				provider: "deepseek-official",
				model: "deepseek-flash",
				rawOutput: [],
				llmStreamCall: true,
				usage
			}
		},
		{ type: "compaction/end", seq: seq + 2, time: T0 + 20, data: { compactionId: id, turn: null } }
	];
	const churns = (events) => adviceCodes(events).includes("compaction-churn");
	/** The `/compact` a user runs — the only compaction the log attributes. */
	const compact = (seq, time) => ({ type: "command/run", seq, time, data: { commandId: `cmd-${String(seq)}`, name: "compact", args: "", source: { kind: "user" } } });

	assert.ok(churns([route("deepseek-flash"), ...summary(1, "a"), ...summary(4, "b"), ...summary(7, "c")]), "three automatic compactions are churn even when each one is cheap");
	// The user's actual case: one automatic compaction, one from our own tip,
	// and real spend that dwarfs both summaries.
	assert.deepEqual(
		adviceCodes([route("deepseek-flash"), ...settlements(5, PEAK), ...summary(50, "a"), ...summary(54, "b")]).filter((code) => code === "compaction-churn"),
		[],
		"two automatic compactions are not churn"
	);
	// A `/compact` the panel itself submitted must not read as churn: the
	// summary that follows it belongs to that command, in both gates.
	assert.deepEqual(
		adviceCodes([route("deepseek-flash"), ...settlements(5, PEAK), compact(40, PEAK), ...summary(42, "a"), compact(60, PEAK), ...summary(62, "b"), compact(80, PEAK), ...summary(82, "c")]).filter(
			(code) => code === "compaction-churn"
		),
		[],
		"three user-triggered compactions are our own advice, not churn"
	);
	// …but the marker is spent by the first summary, even though the next three
	// land inside the same five-minute window: leak it and only one of the four
	// compactions counts as automatic, which is the difference asserted here.
	assert.ok(
		churns([route("deepseek-flash"), ...settlements(5, PEAK), compact(1, PEAK), ...summary(3, "a"), ...summary(30, "b"), ...summary(60, "c"), ...summary(90, "d")]),
		"one manual compaction leaves the other three automatic ones counted"
	);
	// The cost gate stands alone: one summary that dominates the session is
	// worth naming no matter how few compactions produced it.
	const dominating = [route("deepseek-flash"), ...settlements(1, PEAK), ...summary(5, "a", { inputTokens: 100000, outputTokens: 1000 })];
	assert.ok(churns(dominating), "a single dominating summary is churn on cost alone");
}

{
	const failure = (seq, id) => [
		{ type: "tool/call", seq, time: PEAK, data: { turn: 1, step: 1, callId: id, name: "bash", arguments: JSON.stringify({ command: "false" }) } },
		{ type: "tool/result", seq: seq + 1, time: PEAK + 5, data: { turn: 1, step: 1, message: { source: { callId: id } }, error: { name: "ToolError", code: "exit-1" } } }
	];
	assert.ok(adviceCodes([route("deepseek-flash"), ...failure(1, "a"), ...failure(3, "b"), ...failure(5, "c")]).includes("tool-failures"), "a failure run advises");
	assert.deepEqual(adviceCodes([route("deepseek-flash"), ...failure(1, "a"), ...failure(3, "b")]).filter((code) => code === "tool-failures"), [], "two failures is not a run");
}

{
	const retries = [];
	for (let index = 0; index < RETRIES; index += 1) retries.push({ type: "llm/retry-started", seq: index, time: PEAK, data: { turn: 1, step: index + 1 } });
	const codes = adviceCodes([route("deepseek-flash"), ...retries]);
	assert.ok(codes.includes("model-retries"), "retry run");
}

{
	const steps = [];
	for (let index = 0; index < 30; index += 1) steps.push({ type: "step/end", seq: index, time: PEAK, data: { turn: 1, step: index + 1 } });
	assert.ok(adviceCodes([route("deepseek-flash"), ...steps]).includes("idle-grinding"), "steps without a write");
	const productive = [route("deepseek-flash"), ...steps.slice(0, 29), { type: "tool/call", seq: 100, time: PEAK, data: { turn: 1, step: 30, callId: "w", name: "edit", arguments: JSON.stringify({ file_path: "/tmp/x" }) } }, steps[29]];
	assert.ok(!adviceCodes(productive).includes("idle-grinding"), "an edit resets the run");
}

{
	assert.ok(
		adviceCodes([
			route("deepseek-flash"),
			...settlements(50, PEAK).map((event) =>
				event.type === "assistant/message"
					? { ...event, data: { ...event.data, usage: { inputTokens: 100000, cacheReadTokens: 100000, cacheWriteTokens: 0, outputTokens: 10 } } }
					: event
			)
		]).includes("cache-hit-drop"),
		"a fallen cache-hit rate"
	);
}

{
	// Severity ordering: a failure run outranks the informational rules.
	const failure = [
		{ type: "tool/call", seq: 1, time: PEAK, data: { turn: 1, step: 1, callId: "a", name: "bash", arguments: JSON.stringify({ command: "false" }) } },
		{ type: "tool/result", seq: 2, time: PEAK, data: { turn: 1, step: 1, message: { source: { callId: "a" } }, error: { name: "ToolError", code: "exit-1" } } },
		{ type: "tool/call", seq: 3, time: PEAK, data: { turn: 1, step: 1, callId: "b", name: "bash", arguments: JSON.stringify({ command: "false" }) } },
		{ type: "tool/result", seq: 4, time: PEAK, data: { turn: 1, step: 1, message: { source: { callId: "b" } }, error: { name: "ToolError", code: "exit-1" } } },
		{ type: "tool/call", seq: 5, time: PEAK, data: { turn: 1, step: 1, callId: "c", name: "bash", arguments: JSON.stringify({ command: "false" }) } },
		{ type: "tool/result", seq: 6, time: PEAK, data: { turn: 1, step: 1, message: { source: { callId: "c" } }, error: { name: "ToolError", code: "exit-1" } } }
	];
	const view = fold([route("deepseek-flash"), ...settlements(30, PEAK), ...failure]).view;
	assert.equal(view.advice[0].code, "tool-failures", "the most urgent advice leads");
}

//#endregion

{
	// The one-click compaction is judged on the *live* context, not on the
	// lifetime share that raised the tip: a summarize call costs real money, so
	// pressing it after the context has already been shrunk buys nothing.
	const big = { inputTokens: 400000, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 10 };
	const small = { inputTokens: 40000, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 10 };
	const time = PEAK;
	const settled = fold([route("deepseek-flash"), settle(1, 1, big, time), settle(1, 2, small, time + 1000)]).view;
	assert.equal(settled.metrics.lastPromptTokens, 40000, "the last measured prompt is the live context size");
	assert.equal(settled.metrics.peakPromptTokens, 400000, "the peak prompt is remembered");
	assert.equal(settled.metrics.compactedSinceRequest, false, "nothing has compacted yet");
}

{
	// A tip that fired on history carries what its button must be judged on, and
	// a compaction makes that reading stale.
	// `settlements` emits step/start too, which is what lets the settlement close
	// its step — without it the model-call count stays zero and no tip fires.
	const events = [route("deepseek-flash"), ...settlements(40, PEAK)];
	const tip = fold(events).view.advice.find((item) => item.code === "context-reread");
	assert.ok(tip !== undefined, "the re-read tip fires on a re-read-heavy session");
	assert.equal(tip.values.contextTokens, 101000, "the tip carries the live context size");
	assert.equal(tip.values.peakContextTokens, 101000, "and the peak it came down from");
	assert.equal(tip.values.compactedSinceRequest, 0, "and whether a compaction has run since that reading");

	const compaction = {
		type: "compaction/summary",
		seq: 900,
		time: PEAK + 120000,
		data: {
			compactionId: "c1",
			summary: [],
			shadowedRange: { start: 0, end: 1 },
			shadowedSeqs: [0],
			shadowedTokenCount: 10,
			provider: "deepseek-official",
			model: "deepseek-flash",
			rawOutput: [],
			llmStreamCall: true,
			usage: { inputTokens: 1000, outputTokens: 10 }
		}
	};
	const after = fold(events.concat([compaction])).view;
	assert.equal(after.metrics.compactedSinceRequest, true, "a compaction makes the measured context stale");
	assert.equal(after.compaction.lastAt, PEAK + 120000, "the compaction's instant is remembered");
	assert.ok(after.compaction.lastCostNano > 0, "and what it cost, as the price of pressing the button again");
	const stale = after.advice.find((item) => item.code === "context-reread");
	assert.equal(stale.values.compactedSinceRequest, 1, "the tip reports the staleness, so the button is withheld");
}

{
	// Tips are ordered by the money at stake, and each says whether it is priced
	// at all: a pattern worth ¥0.10 of a ¥200 session must not outrank one worth
	// ¥50, and a tip whose leak is not a bill line must not invent a figure.
	const events = [
		route("deepseek-flash"),
		...settlements(40, PEAK),
		...toolCalls(30, "bash", JSON.stringify({ command: "echo x" }), 100, PEAK)
	];
	const advice = fold(events).view.advice;
	assert.ok(advice.length >= 2, "both the re-read and the fragmented-call tips fire");
	for (const item of advice) {
		assert.equal(typeof item.values.costNano, "number", `${item.code}: carries the money at stake`);
		assert.equal(typeof item.values.priced, "number", `${item.code}: says whether it is priced`);
		assert.equal(typeof item.values.share, "number", `${item.code}: carries its share of the session`);
	}
	// No "act now" tip in this scenario, so the money ordering is what shows.
	assert.equal(advice[0].code, "context-reread", "the tip with a bill line behind it comes first");
	assert.equal(advice[0].values.priced, 1, "and is marked as priced");
	assert.equal(advice[0].values.share, 66, "its share is a percent of the session");
	assert.ok(advice.filter((item) => item.values.priced === 0).length >= 1, "a behavioural tip is present");
	assert.equal(advice[advice.length - 1].values.priced, 0, "unpriced tips sort after every priced one");
}

{
	// An "act now" tip outranks money: the failing tool and the falling balance
	// are about being stuck, and a small priced tip must not bury them.
	const events = [
		route("deepseek-flash"),
		...settlements(40, PEAK),
		...toolCalls(1, "bash", JSON.stringify({ command: "exit 1" }), 100, PEAK),
		...toolCalls(1, "bash", JSON.stringify({ command: "exit 1" }), 100, PEAK),
		...toolCalls(1, "bash", JSON.stringify({ command: "exit 1" }), 100, PEAK)
	];
	const advice = fold(events).view.advice;
	const high = advice.filter((item) => item.severity === "high");
	if (high.length > 0) {
		assert.equal(advice[0].severity, "high", "an urgent tip leads even when a priced tip is present");
	}
	for (let index = 1; index < advice.length; index += 1) {
		const before = advice[index - 1];
		const after = advice[index];
		if (before.severity === "high" || after.severity === "high") continue;
		assert.ok(before.values.costNano >= after.values.costNano, "within the non-urgent band, the money ordering holds");
	}
}

{
	// Producing through the shell counts as producing. `toolCalls` puts every call
	// in one step, so the steps are built by hand here — the counter that decides
	// this tip only moves on `step/end`.
	const shellSteps = (count, command) => {
		const events = [route("deepseek-flash")];
		for (let index = 0; index < count; index += 1) {
			const step = index + 1;
			events.push({ type: "step/start", seq: index * 4, time: PEAK, data: { turn: 1, step } });
			events.push({
				type: "tool/call",
				seq: index * 4 + 1,
				time: PEAK,
				data: { turn: 1, step, callId: `c${String(index)}`, name: "bash", arguments: JSON.stringify({ command }) }
			});
			events.push({
				type: "tool/result",
				seq: index * 4 + 2,
				time: PEAK + 100,
				data: { turn: 1, step, message: { source: { callId: `c${String(index)}` } } }
			});
			events.push({ type: "step/end", seq: index * 4 + 3, time: PEAK + 200, data: { turn: 1, step } });
		}
		return events;
	};
	const idle = (command) => fold(shellSteps(35, command)).view;

	const readOnly = idle("grep -rn TODO src");
	assert.ok(
		readOnly.advice.some((item) => item.code === "idle-grinding"),
		"a read-only shell loop still reads as investigation"
	);
	assert.equal(readOnly.metrics.productiveCalls, 0, "and produces nothing");

	for (const [command, why] of [
		["python3 - <<'PY'\nopen('x','w').write('y')\nPY", "a heredoc that writes files"],
		["echo hi > /tmp/x", "a redirect"],
		["git commit -m 'x'", "a commit"],
		["sed -i 's/a/b/' index.js", "an in-place edit"],
		["pnpm install", "an install"]
	]) {
		const view = idle(command);
		assert.equal(view.advice.some((item) => item.code === "idle-grinding"), false, `${why} clears the tip`);
		assert.ok(view.metrics.productiveCalls >= 35, `${why} counts as output`);
	}

	const sink = idle("node check.mjs > /dev/null 2>&1");
	assert.ok(
		sink.advice.some((item) => item.code === "idle-grinding"),
		"writing to /dev/null and duplicating a descriptor is not producing"
	);
	assert.equal(sink.metrics.productiveCalls, 0, "and counts nothing");
}

{
	// Thinking is billed at the output rate, so the bucket has to carry it —
	// otherwise "output" quietly means "answer + thinking" and a rise in thinking
	// is invisible behind a denominator that grew with it.
	const usage = { inputTokens: 100, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 1000, reasoningTokens: 900 };
	const { view } = fold([route("deepseek-flash"), settle(1, 1, usage, PEAK)]);
	assert.equal(view.total.reasoningTokens, 900, "the thinking subset is kept");
	assert.equal(view.metrics.answerTokens, 100, "and the answer is what is left of the output");
	assert.equal(view.total.outputCostNano, 1000 * 8 * 1000, "the output line's own cost is kept, so thinking can be priced");
}

{
	// The effort tip, and the shape it must stay quiet about.
	const header = (effort) => ({
		type: "request/header",
		seq: 0,
		time: PEAK,
		data: { header: { config: { provider: "deepseek-official", model: "deepseek-flash", reasoningEffort: effort } } }
	});
	// One turn per settlement, so "per turn" means what it says.
	const session = (usage, writes) => {
		const events = [route("deepseek-flash"), header("high")];
		for (let index = 0; index < 25; index += 1) {
			const turn = index + 1;
			events.push({ type: "step/start", seq: index * 4 + 1, time: PEAK, data: { turn, step: 1 } });
			events.push(settle(turn, 1, usage, PEAK));
			if (writes) {
				events.push({
					type: "tool/call",
					seq: index * 4 + 3,
					time: PEAK,
					data: { turn, step: 1, callId: `c${String(index)}`, name: "write", arguments: JSON.stringify({ file_path: `/tmp/f${String(index)}.js`, content: "x" }) }
				});
				events.push({
					type: "tool/result",
					seq: index * 4 + 4,
					time: PEAK,
					data: { turn, step: 1, message: { source: { callId: `c${String(index)}` } } }
				});
			}
			events.push({ type: "step/end", seq: index * 4 + 5, time: PEAK, data: { turn, step: 1 } });
		}
		return events;
	};

	// Heavy thinking, short answers, nothing delivered: max left on for errands.
	const tip = fold(session({ inputTokens: 100, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 1000, reasoningTokens: 900 }, false))
		.view.advice.find((item) => item.code === "reasoning-effort");
	assert.ok(tip !== undefined, "the effort tip fires on short answers with heavy thinking");
	assert.equal(tip.values.effort, "high", "and names the setting it read off the header");
	assert.equal(tip.values.percent, 90, "and the thinking share");
	assert.ok(tip.values.costNano > 0, "and what the thinking cost — the one exactly countable lever");
	assert.equal(tip.values.answer, 100, "and the average answer size");

	// Same thinking share, but real answers and delivered files: leave it alone.
	for (const [usage, writes, why] of [
		[{ inputTokens: 100, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 4000, reasoningTokens: 3600 }, false, "long answers"],
		[{ inputTokens: 100, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 1000, reasoningTokens: 900 }, true, "delivered edits"]
	]) {
		assert.equal(
			fold(session(usage, writes)).view.advice.some((item) => item.code === "reasoning-effort"),
			false,
			`deep work is left alone: ${why}`
		);
	}
}

{
	// A peak settlement fills both the total and the peak twin; an off-peak one
	// fills only the total. This is what makes "peak only / off-peak only" possible
	// without a second fold. Steps land on `step/end`, so the sequence is built.
	const usage = { inputTokens: 100, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 1000 };
	const dayAt = (time) => {
		const days = fold([
			route("deepseek-flash"),
			{ type: "step/start", seq: 1, time, data: { turn: 1, step: 1 } },
			settle(1, 1, usage, time),
			{ type: "step/end", seq: 3, time, data: { turn: 1, step: 1 } }
		]).view.days;
		return days[Object.keys(days)[0]];
	};

	const atPeak = dayAt(PEAK);
	assert.equal(atPeak.steps, 1, "the peak step is counted overall");
	assert.equal(atPeak.peakSteps, 1, "and on the peak side, because it happened at peak");
	assert.equal(atPeak.requests, 1, "the request is counted overall");
	assert.equal(atPeak.peakRequests, 1, "and on the peak side");
	assert.equal(atPeak.peakOutputTokens, 1000, "splitting tokens as well as money");
	assert.equal(atPeak.peakOutputCostNano, atPeak.outputCostNano, "and the output cost with them");

	const atOff = dayAt(1789876800000);
	assert.equal(atOff.steps, 1, "the off-peak step is still counted overall");
	assert.equal(atOff.peakSteps, 0, "but not on the peak side");
	assert.equal(atOff.peakRequests, 0, "and neither is its request");
	assert.equal(atOff.peakOutputTokens, 0, "and no tokens either");
}

process.stdout.write(`check: dsh-cost-audit host half OK (${registrations.length} projection units, ${routes.length} connection routes)\n`);
