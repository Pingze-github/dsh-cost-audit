/**
 * Public types of the `dsh-cost-audit` host half, plus the one module augmentation
 * that makes `useProjection("dshCostAudit")` type-check in client code.
 *
 * @module dsh-cost-audit
 */

/** The plugin's projection key, as it appears in `SessionProjectionMap`. */
export declare const PROJECTION_KEY: "dshCostAudit";

/** One billed bucket: exact token counts and a cost in CNY × 1e9. */
export interface DshCostAuditBucket {
	uncachedInputTokens: number;
	cacheReadTokens: number;
	cacheWriteTokens: number;
	outputTokens: number;
	/** Cost in CNY × 1e9, so every shipped per-million rate prices exactly. */
	costNano: number;
	/** The cache-read share of `costNano`, which the advisor names. */
	cacheReadCostNano: number;
	/** Tokens this plugin could price (a known DeepSeek family was routed). */
	pricedTokens: number;
	/** Tokens left out of `costNano` because the routed model had no rate. */
	unpricedTokens: number;
}

/** One turn's bucket plus the model that served it. */
export interface DshCostAuditTurn extends DshCostAuditBucket {
	model: string;
}

/** One tool's own call count and wall time. */
export interface DshCostAuditToolTiming {
	calls: number;
	ms: number;
}

/**
 * Operation-type timings for one turn, or for the whole session. Durations are
 * milliseconds; `wallMs` brackets the turn (`turn/start` → `turn/end`), so
 * `wallMs - modelMs - toolMs` is harness overhead.
 */
export interface DshCostAuditTiming {
	wallMs: number;
	/** step/start → assistant/message: model wait plus generation. */
	modelMs: number;
	modelCalls: number;
	/** step/start → first output token. */
	ttftMs: number;
	ttftSteps: number;
	/** first output token → assistant/message. */
	decodeMs: number;
	decodeTokens: number;
	/** tool/call → its tool/result, matched by callId. */
	toolMs: number;
	toolCalls: number;
	/** Tool name → its own calls and wall time. */
	tools: Record<string, DshCostAuditToolTiming>;
}

/**
 * What the log says about compaction. The summarize calls bill real money that
 * no other figure in this deployment counts, so `summaryCostNano` is folded into
 * the session total and `count` / `shadowedTokens` drive the advisory.
 */
export interface DshCostAuditCompaction {
	/** Successful `compaction/summary` events. */
	count: number;
	/** `compaction/end` events carrying an error. */
	errors: number;
	/** Model-free prune replacements. */
	prunes: number;
	/** Context the compactions rewrote. */
	shadowedTokens: number;
	/** What the summarization calls billed, in CNY × 1e9. */
	summaryCostNano: number;
	/** Tokens those summarization calls billed. */
	summaryTokens: number;
}

/**
 * One advisory item. `code` and `severity` are stable; the wording lives in the
 * client's locale dictionaries, so `values` carries numbers and names only.
 */
export interface DshCostAuditAdvice {
	code: string;
	severity: "high" | "warn" | "info";
	values: Record<string, number | string>;
}

/** The `dshCostAudit` client view: whole-log tokens, CNY cost, timings, and advice. */
export interface DshCostAuditProjection {
	/** Always `CNY` — DeepSeek's list prices are published in RMB. */
	currency: "CNY";
	/** Route provider last seen in the log ("" while unknown). */
	provider: string;
	/** Route model last seen in the log ("" while unknown). */
	model: string;
	/** Whole-session billed totals. */
	total: DshCostAuditBucket;
	/** Turn number (decimal string) → that turn's billed totals. */
	turns: Record<string, DshCostAuditTurn>;
	/** Operation-type timings, per turn and for the whole session. */
	timing: { total: DshCostAuditTiming; turns: Record<string, DshCostAuditTiming> };
	/** Compaction activity and its own bill. */
	compaction: DshCostAuditCompaction;
	/** Token-saving advice, most urgent first; empty when there is nothing to say. */
	advice: DshCostAuditAdvice[];
}

/** The `/api/dsh-cost-audit.balance` answer for an account read. */
export type DshCostAuditBalanceResult =
	| { ok: true; balance: { currency: string; total: number; granted: number; toppedUp: number }; fetchedAt: number }
	| { ok: false; reason: string; status?: number; message?: string };

/** The `/api/dsh-cost-audit.balance` answer for an on-demand session fold. */
export type DshCostAuditSessionResult = { ok: true; stats: DshCostAuditProjection } | { ok: false; reason: string; message?: string };

declare module "@deepseek-ai/dsh-session-projection/types" {
	interface SessionProjectionMap {
		/** Billed tokens, CNY cost, operation timings, and advisory. */
		dshCostAudit: DshCostAuditProjection;
	}
}
