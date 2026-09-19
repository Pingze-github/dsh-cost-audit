/**
 * dsh-stats — browser half.
 *
 * Adds two extensions to the harness's own statistics surfaces, in the
 * official form (an icon pill that opens a trigger-anchored `dt`/`dd` panel,
 * same design tokens, same geometry):
 *
 * - a per-turn cost pill beside the official turn token/time pills in
 *   `conversation.chat.assistant-actions`, reading that turn's billed buckets
 *   from the host's `dshStats` projection and showing its CNY cost plus the
 *   full hit-rate / cache / input / output breakdown;
 * - a whole-session cost + account-balance pill in `conversation.composer.dock`,
 *   under the official session stats row. The balance is the only live read:
 *   it rides the plugin's own `/dsh-stats` Connection RPC channel.
 *
 * This module is the body of the package's `./client` bundle: it registers a
 * factory in the bootstrap facade and materializes only when the web app
 * imports the entry. Everything outside the browser seed table is inlined —
 * `react`, `react-dom`, and the UI primitives come from the seed `require`.
 *
 * Every slot component fails closed: a missing projection key, a missing
 * session kit, or an unresolved turn renders nothing instead of throwing, so a
 * host-half problem can never break the conversation view.
 *
 * @module dsh-stats/client
 */

window.__ModuleLoader__.load({
	id: "dsh-stats",
	factory: (require) => {
		var module = { exports: {} };
		module.exports;

		const react = require("react");
		const reactDom = require("react-dom");
		const primitives = require("@deepseek-ai/dsh-client-ui-primitives");
		const h = react.createElement;
		const Fragment = react.Fragment;

		const NS = "dsh-stats";
		/** The host half's exact Fetch route on Connection's `/api` prefix. */
		const BALANCE_PATH = "/api/dsh-stats.balance";
		const PROJECTION = "dshStats";
		const NANO = 1e9;

		//#region locale

		const DICT_ZH = {
			"number.thousand": "{value}K",
			"number.million": "{value}M",
			"number.groupSeparator": ",",
			"count": "{count} tokens",
			"turn.aria": "本轮费用 {cost}（点击查看详情）",
			"turn.title": "本轮用量与费用",
			"turn.model": "模型",
			"turn.cacheHit": "缓存命中率",
			"turn.cacheRead": "缓存输入",
			"turn.uncached": "未缓存输入",
			"turn.cacheWrite": "缓存写入",
			"turn.input": "总输入",
			"turn.output": "输出",
			"turn.cost": "本轮费用",
			"session.aria": "会话费用 {cost} · 账户余额 {balance}（点击查看详情）",
			"session.title": "会话用量与费用",
			"session.cost": "会话总费用",
			"session.cacheHit": "缓存命中率",
			"session.cacheRead": "缓存输入",
			"session.uncached": "未缓存输入",
			"session.cacheWrite": "缓存写入",
			"session.input": "总输入",
			"session.output": "输出",
			"session.balance": "账户余额",
			"balance.total": "总余额",
			"balance.granted": "赠送余额",
			"balance.toppedUp": "充值余额",
			"balance.loading": "读取中…",
			"balance.error": "读取失败",
			"balance.noKey": "未配置 API Key",
			"cost.unpriced": "另有 {count} 未收录价格，未计入费用"
		};

		const DICT_EN = {
			"number.thousand": "{value}K",
			"number.million": "{value}M",
			"number.groupSeparator": ",",
			"count": "{count} tokens",
			"turn.aria": "This turn cost {cost} (click for details)",
			"turn.title": "Turn usage & cost",
			"turn.model": "Model",
			"turn.cacheHit": "Cache hit",
			"turn.cacheRead": "Cache read",
			"turn.uncached": "Uncached input",
			"turn.cacheWrite": "Cache write",
			"turn.input": "Total input",
			"turn.output": "Output",
			"turn.cost": "Turn cost",
			"session.aria": "Session cost {cost} · balance {balance} (click for details)",
			"session.title": "Session usage & cost",
			"session.cost": "Session cost",
			"session.cacheHit": "Cache hit",
			"session.cacheRead": "Cache read",
			"session.uncached": "Uncached input",
			"session.cacheWrite": "Cache write",
			"session.input": "Total input",
			"session.output": "Output",
			"session.balance": "Account balance",
			"balance.total": "Total balance",
			"balance.granted": "Granted",
			"balance.toppedUp": "Topped up",
			"balance.loading": "Loading…",
			"balance.error": "Unavailable",
			"balance.noKey": "No API key configured",
			"cost.unpriced": "{count} further tokens have no listed price and are not billed here"
		};

		//#endregion

		//#region styles

		/**
		 * The official pill and panel rules, re-emitted under this plugin's own
		 * class names. Copying the declarations (rather than reusing the chat
		 * package's build-hashed classes) keeps the geometry and the design
		 * tokens identical while leaving this plugin's styling self-contained
		 * across harness upgrades.
		 */
		const CSS = [
			".dshstats-anchor{min-width:0;display:inline-flex}",
			".dshstats-trigger{min-width:0;height:calc(28px + var(--dsh-content-font-delta,0px));color:var(--dsw-alias-label-tertiary);font-size:var(--dsh-content-font-size-secondary,13px);font-variant-numeric:tabular-nums;line-height:calc(24px + var(--dsh-content-font-delta,0px));white-space:nowrap;cursor:pointer;background:0 0;border:none;border-radius:28px;align-items:center;gap:4px;padding:6px 8px;display:inline-flex}",
			".dshstats-trigger svg{width:calc(15px + var(--dsh-content-font-delta,0px));height:calc(15px + var(--dsh-content-font-delta,0px));flex:none}",
			".dshstats-trigger:hover,.dshstats-trigger[aria-expanded=true]{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-secondary)}",
			".dshstats-label{text-overflow:ellipsis;min-width:0;overflow:hidden}",
			".dshstats-row{max-width:var(--dsh-chat-content-width);box-sizing:border-box;width:100%;padding:2px calc(var(--dsh-composer-side-clearance) + 16px) 0;font-size:var(--dsh-content-font-size-secondary,13px);line-height:calc(20px + var(--dsh-content-font-delta-secondary,0px));justify-content:center;gap:12px;margin:0 auto;display:flex}",
			".dshstats-pill{box-sizing:border-box;max-width:100%;color:var(--dsw-alias-label-tertiary);font:inherit;font-variant-numeric:tabular-nums;line-height:inherit;white-space:nowrap;background:0 0;border:none;border-radius:24px;align-items:center;gap:6px;padding:1px 8px;display:inline-flex;cursor:pointer}",
			".dshstats-pill svg{flex:none;width:14px;height:14px}",
			".dshstats-pill:hover,.dshstats-pill[aria-expanded=true]{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-secondary)}",
			".dshstats-sep{color:var(--dsw-alias-separator-primary);margin:0 6px}",
			".dshstats-panel{z-index:1100;box-sizing:border-box;background:var(--dsw-specific-menu);--dsw-elevation-stroke-color:var(--dsw-alias-border-l1);width:max-content;min-width:min(300px,100vw - 24px);max-width:min(440px,100vw - 24px);box-shadow:var(--dsw-elevation-prominent);color:var(--dsw-alias-label-secondary);cursor:default;border:0;border-radius:12px;padding:16px;font-size:12px;line-height:18px;position:fixed}",
			".dshstats-panelTitle{color:var(--dsw-alias-label-primary);justify-content:space-between;gap:16px;margin-bottom:8px;font-weight:500;display:flex}",
			".dshstats-panelRule{border-top:.5px solid var(--dsw-alias-border-l2);margin-bottom:10px}",
			".dshstats-sectionRule{border-top:.5px solid var(--dsw-alias-border-l2);margin:10px 0}",
			".dshstats-panelValue{font-variant-numeric:tabular-nums}",
			".dshstats-panelLabel{align-items:center;gap:6px;min-width:0;display:inline-flex}",
			".dshstats-panelLabel svg{flex:none;width:14px;height:14px}",
			".dshstats-details{color:var(--dsw-alias-label-tertiary);grid-template-columns:minmax(76px,auto) minmax(0,1fr);gap:6px 16px;margin:0;display:grid}",
			".dshstats-details dt,.dshstats-details dd{min-width:0;margin:0}",
			".dshstats-details dd{color:var(--dsw-alias-label-secondary);font-variant-numeric:tabular-nums;text-align:right}",
			".dshstats-details .dshstats-route{overflow-wrap:anywhere}",
			".dshstats-details .dshstats-note{grid-column:1 / -1;color:var(--dsw-alias-label-caption);text-align:left}"
		].join("");

		const STYLE_TAG = "dsh-stats/pills.css";
		if (typeof document !== "undefined" && document.querySelector("style[data-plugin-css=" + JSON.stringify(STYLE_TAG) + "]") === null) {
			const tag = document.createElement("style");
			tag.dataset.plugin = "dsh-stats";
			tag.dataset.pluginCss = STYLE_TAG;
			tag.textContent = CSS;
			document.head.appendChild(tag);
		}

		//#endregion

		//#region formatting

		/**
		 * Exact integer token count with locale-owned digit grouping.
		 * @param value - non-negative safe integer token count.
		 * @param t - locale seat.
		 * @returns an unrounded display string.
		 */
		function formatExactTokens(value, t) {
			const digits = String(value);
			const groups = [];
			for (let end = digits.length; end > 0; end -= 3) groups.unshift(digits.slice(Math.max(0, end - 3), end));
			return groups.join(t("number.groupSeparator"));
		}

		/**
		 * Round a cache-read ratio to exact percentage units, ties up — the
		 * harness's own integer arithmetic, so a partial hit can never round to
		 * a bare 100%.
		 */
		function roundedPercentUnits(cacheReadTokens, denominator, decimalPlaces) {
			const scale = (decimalPlaces === 0 ? 1 : 10) * 100;
			const doubledScale = scale * 2;
			const denominatorQuotient = Math.floor(denominator / doubledScale);
			const denominatorRemainder = denominator % doubledScale;
			let lower = 0;
			let upper = scale;
			while (lower < upper) {
				const candidate = Math.floor((lower + upper + 1) / 2);
				const factor = candidate * 2 - 1;
				if (cacheReadTokens >= factor * denominatorQuotient + Math.ceil((factor * denominatorRemainder) / doubledScale)) lower = candidate;
				else upper = candidate - 1;
			}
			return lower;
		}

		function displayPercentUnits(units, decimalPlaces) {
			if (decimalPlaces === 0) return String(units);
			const whole = Math.floor(units / 10);
			const tenths = units % 10;
			return tenths === 0 ? String(whole) : `${whole}.${tenths}`;
		}

		/**
		 * Display-ready cache-hit share without rounding a partial hit to 100%.
		 * @param cacheReadTokens - exact prompt tokens served from cache.
		 * @param promptTokens - exact aggregate prompt tokens.
		 * @param decimalPlaces - ordinary-ratio precision.
		 * @returns percentage text, or null when there was no prompt input.
		 */
		function formatCacheHitPercent(cacheReadTokens, promptTokens, decimalPlaces = 0) {
			if (promptTokens === 0) return null;
			const missedInputTokens = promptTokens - cacheReadTokens;
			if (missedInputTokens === 0) return "100";
			const roundedUnits = roundedPercentUnits(cacheReadTokens, promptTokens, decimalPlaces);
			if (roundedUnits < (decimalPlaces === 0 ? 100 : 1e3)) return displayPercentUnits(roundedUnits, decimalPlaces);
			let distinguishingPlaces = 1;
			let scaledDoubleGap = missedInputTokens * 200;
			const denominatorTens = Math.floor(promptTokens / 10);
			while (scaledDoubleGap <= denominatorTens) {
				scaledDoubleGap *= 10;
				distinguishingPlaces += 1;
			}
			const denominatorOnes = promptTokens % 10;
			let roundedLoss = 5;
			for (let loss = 1; loss < 5; loss += 1) {
				const factor = loss * 2 + 1;
				const threshold = factor * denominatorTens + Math.floor((factor * denominatorOnes) / 10);
				if (scaledDoubleGap <= threshold) {
					roundedLoss = loss;
					break;
				}
			}
			return `99.${"9".repeat(distinguishingPlaces - 1)}${10 - roundedLoss}`;
		}

		/** Drop the trailing zeros a fixed-point rendering leaves behind. */
		function trimZeros(text) {
			return text.includes(".") ? text.replace(/0+$/, "").replace(/\.$/, "") : text;
		}

		/**
		 * CNY text for a nano-CNY cost. The pill stays short; the panel keeps
		 * enough precision that a sub-cent turn is still legible (and never
		 * rounds one away to a bare ¥0).
		 * @param costNano - cost in CNY × 1e9.
		 * @param exact - true for the panel's fuller precision.
		 * @returns display string.
		 */
		function formatCny(costNano, exact = false) {
			const yuan = costNano / NANO;
			if (!Number.isFinite(yuan)) return "—";
			if (yuan === 0) return "¥0";
			if (yuan >= 1) return `¥${yuan.toFixed(exact ? 4 : 2)}`;
			if (yuan >= 0.01) return `¥${trimZeros(yuan.toFixed(4))}`;
			const fixed = trimZeros(yuan.toFixed(6));
			return fixed === "0" ? `¥${yuan.toPrecision(2)}` : `¥${fixed}`;
		}

		/** Input-side total: the three disjoint prompt buckets. */
		function inputTokensOf(bucket) {
			return bucket.uncachedInputTokens + bucket.cacheReadTokens + bucket.cacheWriteTokens;
		}

		/** All billed tokens of one bucket. */
		function totalTokensOf(bucket) {
			return inputTokensOf(bucket) + bucket.outputTokens;
		}

		/** The cache-hit share of a bucket, or null when no prompt was billed. */
		function cacheHitOf(bucket) {
			return formatCacheHitPercent(bucket.cacheReadTokens, inputTokensOf(bucket), 1);
		}

		function countText(value, t) {
			return t("count", { count: formatExactTokens(value, t) });
		}

		//#endregion

		//#region dialog seat

		const PANEL_MARGIN = 12;
		const PANEL_GAP = 8;
		const MEASURE_STYLE = { visibility: "hidden", left: 0, top: 0 };

		/**
		 * One trigger-anchored dialog seat: open state, viewport-clamped
		 * placement above the trigger, outside-pointer and Escape close.
		 * @returns refs and placement for the trigger and its portaled panel.
		 */
		function useStatDialog() {
			const [open, setOpen] = react.useState(false);
			const rootRef = react.useRef(null);
			const panelRef = react.useRef(null);
			const pos = primitives.useAnchoredPosition({
				open,
				anchorRef: rootRef,
				panelRef,
				side: "top",
				gap: PANEL_GAP,
				margin: PANEL_MARGIN
			});
			primitives.useDismissOnOutsidePointer(rootRef, open, setOpen, panelRef);
			react.useEffect(() => {
				if (!open) return undefined;
				const onKeyDown = (event) => {
					if (event.key === "Escape") setOpen(false);
				};
				document.addEventListener("keydown", onKeyDown);
				return () => {
					document.removeEventListener("keydown", onKeyDown);
				};
			}, [open]);
			return { open, setOpen, rootRef, panelRef, pos };
		}

		/**
		 * One `dt`/`dd` pair. A fragment, so the panel's CSS grid keeps both
		 * cells in the same row.
		 */
		function Detail({ label, children, className }) {
			return h(Fragment, null, h("dt", null, label), h("dd", className === undefined ? null : { className }, children));
		}

		/** The request-order bucket rows: hit rate, cache input, total input, output. */
		function bucketDetails(bucket, t, prefix, costLabel) {
			const hit = cacheHitOf(bucket);
			const rows = [
				h(Detail, { key: "hit", label: t(`${prefix}.cacheHit`), children: hit === null ? "—" : `${hit}%` }),
				h(Detail, { key: "cacheRead", label: t(`${prefix}.cacheRead`), children: countText(bucket.cacheReadTokens, t) }),
				h(Detail, { key: "uncached", label: t(`${prefix}.uncached`), children: countText(bucket.uncachedInputTokens, t) })
			];
			if (bucket.cacheWriteTokens > 0) {
				rows.push(h(Detail, { key: "cacheWrite", label: t(`${prefix}.cacheWrite`), children: countText(bucket.cacheWriteTokens, t) }));
			}
			rows.push(h(Detail, { key: "input", label: t(`${prefix}.input`), children: countText(inputTokensOf(bucket), t) }));
			rows.push(h(Detail, { key: "output", label: t(`${prefix}.output`), children: countText(bucket.outputTokens, t) }));
			rows.push(h(Detail, { key: "cost", label: costLabel, children: bucket.pricedTokens > 0 ? formatCny(bucket.costNano, true) : "—" }));
			if (bucket.unpricedTokens > 0) {
				rows.push(
					h("dd", { key: "unpriced", className: "dshstats-note" }, t("cost.unpriced", { count: countText(bucket.unpricedTokens, t) }))
				);
			}
			return rows;
		}

		/**
		 * The panel chrome shared by both pills: title row, hairline rule, and
		 * the `dl` carrying the details — plus an optional `footer` element
		 * (used by the session panel for the balance section).
		 * @returns the portaled panel element, or null while closed.
		 */
		function panelOf({ open, panelRef, pos, icon, title, value, details, ariaLabel, footer }) {
			if (!open) return null;
			return reactDom.createPortal(
				h(
					"div",
					{ ref: panelRef, className: "dshstats-panel", role: "dialog", "aria-label": ariaLabel, style: pos ?? MEASURE_STYLE },
					h(
						"div",
						{ className: "dshstats-panelTitle" },
						h("span", { className: "dshstats-panelLabel" }, icon, title),
						value === null || value === undefined ? null : h("span", { className: "dshstats-panelValue" }, value)
					),
					h("div", { className: "dshstats-panelRule", "aria-hidden": true }),
					h("dl", { className: "dshstats-details" }, details),
					footer === undefined ? null : footer
				),
				document.body
			);
		}

		//#endregion

		//#region turn pill

		/**
		 * Hook-free gate for the turn slot: a slot whose session kit is
		 * incomplete renders nothing, and the decision never changes the hook
		 * order of a mounted component.
		 */
		function TurnSlot(props) {
			if (typeof props.useChat !== "function" || typeof props.useProjection !== "function") return null;
			return h(TurnCostPill, props);
		}

		/**
		 * The per-turn cost pill. The turn number comes from the Chat selector
		 * (its Assistant node is what carries the slot's `messageId`); when that
		 * lookup misses, the pill renders nothing rather than guessing.
		 * @param props - slot props: the tail message id plus the session kit.
		 * @returns the pill, or null when this turn has nothing billed.
		 */
		function TurnCostPill(props) {
			const { messageId, useChat, t } = props;
			const seat = useStatDialog();
			const turn = useChat((snapshot) => lookupTurn(snapshot, messageId));
			const stats = useSessionStats(props);
			if (turn === undefined || stats === undefined || stats.turns === undefined) return null;
			const bucket = stats.turns[String(turn)];
			if (bucket === undefined) return null;
			const model = typeof bucket.model === "string" && bucket.model !== "" ? bucket.model : stats.model;
			const cost = formatCny(bucket.costNano);
			const details = [];
			if (typeof model === "string" && model !== "") {
				details.push(h(Detail, { key: "model", label: t("turn.model"), children: model, className: "dshstats-route" }));
			}
			details.push(...bucketDetails(bucket, t, "turn", t("turn.cost")));
			return h(
				"span",
				{ ref: seat.rootRef, className: "dshstats-anchor" },
				h(
					"button",
					{
						type: "button",
						className: "dshstats-trigger",
						"aria-haspopup": "dialog",
						"aria-expanded": seat.open,
						"aria-label": t("turn.aria", { cost }),
						"data-dsh-stats-turn": turn,
						onClick: () => {
							seat.setOpen(!seat.open);
						}
					},
					h(primitives.IconDataOutline16, null),
					h("span", { className: "dshstats-label" }, cost)
				),
				panelOf({
					open: seat.open,
					panelRef: seat.panelRef,
					pos: seat.pos,
					icon: h(primitives.IconDataOutline16, null),
					title: t("turn.title"),
					value: countText(totalTokensOf(bucket), t),
					details,
					ariaLabel: t("turn.title")
				})
			);
		}

		/**
		 * Resolve the turn owning one Assistant message id from the Chat
		 * selector's node window.
		 * @param snapshot - the Chat snapshot.
		 * @param messageId - the slot's message identity.
		 * @returns the turn number, or undefined when the window does not hold it.
		 */
		function lookupTurn(snapshot, messageId) {
			try {
				const nodes = snapshot?.legacy?.nodes;
				if (nodes === undefined || messageId === undefined) return undefined;
				for (const node of nodes) {
					if (node.messageId === messageId && typeof node.turn === "number") return node.turn;
				}
			} catch {}
			return undefined;
		}

		//#endregion

		//#region session pill

		/**
		 * One POST to the host half's endpoint. Plain same-origin fetch: the
		 * route already rides Connection's Host/Origin fence and browser
		 * authentication, so no client RPC plumbing is involved. Never rejects.
		 * @param body - the JSON body to send.
		 * @returns the parsed value, or undefined on any failure.
		 */
		async function post(body) {
			try {
				const response = await fetch(BALANCE_PATH, {
					method: "POST",
					headers: { "content-type": "application/json" },
					body: JSON.stringify(body)
				});
				if (!response.ok) return undefined;
				return await response.json();
			} catch {
				return undefined;
			}
		}

		/**
		 * Read the account balance.
		 * @returns `{ok:true, balance}` or `{ok:false, reason}`.
		 */
		async function readBalance() {
			const value = await post({});
			if (value !== null && value !== undefined && value.ok === true && value.balance !== undefined) return { ok: true, balance: value.balance };
			return { ok: false, reason: value?.reason ?? "network" };
		}

		/** Sessions whose on-demand fold already answered, and when. */
		const statsCache = /* @__PURE__ */ new Map();
		/** Sessions with an on-demand fold in flight. */
		const statsInflight = /* @__PURE__ */ new Map();
		/** Minimum spacing between two on-demand folds of one session. */
		const STATS_MIN_INTERVAL_MS = 3000;

		/**
		 * Whole-session `dshStats` for one session, folded on the host.
		 *
		 * The projection pipeline only serves a unit once the session has a
		 * materialized cell, so a session whose persisted projection checkpoint
		 * predates this plugin carries no `dshStats` — the endpoint covers
		 * exactly that case, from the same unit definition the live pipeline
		 * uses. Reads are deduplicated and spaced out.
		 * @param sessionId - the session to fold.
		 * @returns the wire view, or undefined when it cannot be read.
		 */
		function sessionStatsFor(sessionId) {
			const inflight = statsInflight.get(sessionId);
			if (inflight !== undefined) return inflight;
			const cached = statsCache.get(sessionId);
			if (cached !== undefined && Date.now() - cached.at < STATS_MIN_INTERVAL_MS) return Promise.resolve(cached.value);
			const promise = post({ sessionId })
				.then((value) => {
					const stats = value !== null && value !== undefined && value.ok === true && value.stats !== undefined ? value.stats : undefined;
					statsCache.set(sessionId, { at: Date.now(), value: stats });
					return stats;
				})
				.finally(() => {
					statsInflight.delete(sessionId);
				});
			statsInflight.set(sessionId, promise);
			return promise;
		}

		/**
		 * The session's `dshStats`: the live projection when the host serves it,
		 * else the on-demand fold. Callers must gate on both session hooks
		 * first, so every hook here runs on every render of a mounted caller.
		 */
		function useSessionStats(props) {
			const { sessionId, useChat, useProjection } = props;
			const projected = useProjection(PROJECTION);
			// The Chat node window is the closest thing to a durable cursor a
			// slot gets; it changes on every settled event, which is exactly
			// when an on-demand fold can have gone stale.
			const cursor = useChat((snapshot) => snapshot.legacy.nodes);
			const [fallback, setFallback] = react.useState(undefined);
			const needsFold = projected === undefined && typeof sessionId === "string" && sessionId !== "";
			react.useEffect(() => {
				if (!needsFold) return undefined;
				let live = true;
				sessionStatsFor(sessionId).then((stats) => {
					if (live) setFallback({ sessionId, stats });
				});
				return () => {
					live = false;
				};
			}, [needsFold, sessionId, cursor]);
			if (projected !== undefined) return projected;
			return fallback !== undefined && fallback.sessionId === sessionId ? fallback.stats : undefined;
		}

		/** CNY text for one DeepSeek balance figure. */
		function formatBalance(amount) {
			const value = Number(amount);
			if (!Number.isFinite(value)) return "—";
			return `¥${value.toFixed(2)}`;
		}

		/**
		 * Short status text for the balance read, used as both the pill's and the
		 * panel's value while no figure is available.
		 */
		function balanceText(state, t) {
			if (state === undefined) return t("balance.loading");
			if (state.ok === true) return formatBalance(state.balance.total);
			if (state.reason === "no-api-key" || state.reason === "no-credentials-service") return t("balance.noKey");
			return t("balance.error");
		}

		/** Hook-free gate for the session slot, same contract as {@link TurnSlot}. */
		function SessionSlot(props) {
			if (typeof props.useChat !== "function" || typeof props.useProjection !== "function") return null;
			return h(SessionCostPill, props);
		}

		/**
		 * The whole-session cost + account-balance pill. Rendered under the
		 * official session stats row; the balance is read once on mount so the
		 * pill's own label is live, and re-read each time the panel opens.
		 * @param props - slot props carrying the session kit.
		 * @returns the pill, or null until the session has billed anything.
		 */
		function SessionCostPill(props) {
			const { t } = props;
			const seat = useStatDialog();
			const stats = useSessionStats(props);
			const [balance, setBalance] = react.useState(undefined);
			const refresh = react.useCallback(() => {
				let live = true;
				readBalance().then((result) => {
					if (live) setBalance(result);
				});
				return () => {
					live = false;
				};
			}, []);
			react.useEffect(() => refresh(), [refresh]);
			react.useEffect(() => {
				if (!seat.open) return undefined;
				return refresh();
			}, [seat.open, refresh]);
			if (stats === undefined || stats.total === undefined) return null;
			const bucket = stats.total;
			if (totalTokensOf(bucket) === 0) return null;
			const cost = formatCny(bucket.costNano);
			const balanceLabel = balanceText(balance, t);
			const loaded = balance !== undefined && balance.ok === true;
			const balanceFooter = h(
				Fragment,
				null,
				h("div", { className: "dshstats-sectionRule", "aria-hidden": true }),
				h(
					"dl",
					{ className: "dshstats-details" },
					h(Detail, { key: "head", label: t("session.balance"), children: balanceLabel }),
					loaded
						? [
								h(Detail, { key: "granted", label: t("balance.granted"), children: formatBalance(balance.balance.granted) }),
								h(Detail, { key: "toppedUp", label: t("balance.toppedUp"), children: formatBalance(balance.balance.toppedUp) })
							]
						: null
				)
			);
			return h(
				"span",
				{ ref: seat.rootRef, className: "dshstats-row", "data-dsh-stats-session": true },
				h(
					"button",
					{
						type: "button",
						className: "dshstats-pill",
						"aria-haspopup": "dialog",
						"aria-expanded": seat.open,
						"aria-label": t("session.aria", { cost, balance: balanceLabel }),
						onClick: () => {
							seat.setOpen(!seat.open);
						}
					},
					h(primitives.IconDataOutline16, null),
					h(
						"span",
						{ className: "dshstats-label" },
						cost,
						h("span", { className: "dshstats-sep", "aria-hidden": true }, "·"),
						`${t("session.balance")} ${balanceLabel}`
					)
				),
				panelOf({
					open: seat.open,
					panelRef: seat.panelRef,
					pos: seat.pos,
					icon: h(primitives.IconDataOutline16, null),
					title: t("session.title"),
					value: countText(totalTokensOf(bucket), t),
					details: bucketDetails(bucket, t, "session", t("session.cost")),
					ariaLabel: t("session.title"),
					footer: balanceFooter
				})
			);
		}

		//#endregion

		//#region plugin

		/**
		 * Mount the browser half: dictionaries, then the two slot entries.
		 * @param ctx - the owning UI Conversation context.
		 */
		function apply(ctx) {
			ctx.effect(() => ctx.locale.register(NS, { zh: DICT_ZH, en: DICT_EN }), "dsh-stats: dictionaries");
			const t = ctx.locale.bind(NS);
			ctx.slots.inject("conversation.chat.assistant-actions", () =>
				ctx.slots.register({ name: "conversation.chat.assistant-actions", id: "dsh-stats-turn", order: 30, locale: NS }, (props) =>
					h(TurnSlot, { ...props, t: props.t ?? t })
				)
			);
			ctx.slots.inject("conversation.composer.dock", () =>
				ctx.slots.register({ name: "conversation.composer.dock", id: "dsh-stats-session", order: 10, locale: NS }, (props) =>
					h(SessionSlot, { ...props, t: props.t ?? t })
				)
			);
		}

		module.exports = { name: NS, inject: ["slots", "locale"], apply };
		return module.exports;
	}
});
