/**
 * Public types of the `dsh-stats` host half, plus the one module augmentation
 * that makes `useProjection("dshStats")` type-check in client code.
 *
 * @module dsh-stats
 */

/** The plugin's projection key, as it appears in `SessionProjectionMap`. */
export declare const PROJECTION_KEY: "dshStats";

/** One billed bucket: exact token counts and a cost in CNY × 1e9. */
export interface DshStatsBucket {
	uncachedInputTokens: number;
	cacheReadTokens: number;
	cacheWriteTokens: number;
	outputTokens: number;
	/** Cost in CNY × 1e9, so every shipped per-million rate prices exactly. */
	costNano: number;
	/** Tokens this plugin could price (a known DeepSeek family was routed). */
	pricedTokens: number;
	/** Tokens left out of `costNano` because the routed model had no rate. */
	unpricedTokens: number;
}

/** One turn's bucket plus the model that served it. */
export interface DshStatsTurn extends DshStatsBucket {
	model: string;
}

/** The `dshStats` client view: whole-log tokens and CNY cost. */
export interface DshStatsProjection {
	/** Always `CNY` — DeepSeek's list prices are published in RMB. */
	currency: "CNY";
	/** Route provider last seen in the log ("" while unknown). */
	provider: string;
	/** Route model last seen in the log ("" while unknown). */
	model: string;
	/** Whole-session billed totals. */
	total: DshStatsBucket;
	/** Turn number (decimal string) → that turn's billed totals. */
	turns: Record<string, DshStatsTurn>;
}

/** The `/api/dsh-stats.balance` answer for an account read. */
export type DshStatsBalanceResult =
	| { ok: true; balance: { currency: string; total: number; granted: number; toppedUp: number }; fetchedAt: number }
	| { ok: false; reason: string; status?: number; message?: string };

/** The `/api/dsh-stats.balance` answer for an on-demand session fold. */
export type DshStatsSessionResult = { ok: true; stats: DshStatsProjection } | { ok: false; reason: string; message?: string };

declare module "@deepseek-ai/dsh-session-projection/types" {
	interface SessionProjectionMap {
		/** Whole-log billed tokens and CNY cost, per turn and per session. */
		dshStats: DshStatsProjection;
	}
}
