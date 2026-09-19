/**
 * dsh-cost-audit — browser half.
 *
 * Adds two extensions to the harness's own statistics surfaces, in the
 * official form (an icon pill that opens a trigger-anchored `dt`/`dd` panel,
 * same design tokens, same geometry):
 *
 * - a per-turn cost pill beside the official turn token/time pills in
 *   `conversation.chat.assistant-actions`, reading that turn's billed buckets
 *   from the host's `dshCostAudit` projection and showing its CNY cost plus the
 *   full hit-rate / cache / input / output breakdown;
 * - a whole-session cost + account-balance pill in `conversation.composer.dock`,
 *   under the official session stats row. The balance is the only live read:
 *   it rides the plugin's own `/dsh-cost-audit` Connection RPC channel.
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
 * @module dsh-cost-audit/client
 */

window.__ModuleLoader__.load({
	id: "dsh-cost-audit",
	factory: (require) => {
		var module = { exports: {} };
		module.exports;

		const react = require("react");
		const reactDom = require("react-dom");
		const primitives = require("@deepseek-ai/dsh-client-ui-primitives");
		const h = react.createElement;
		const Fragment = react.Fragment;

		const NS = "dsh-cost-audit";
		/** The host half's exact Fetch route on Connection's `/api` prefix. */
		const BALANCE_PATH = "/api/dsh-cost-audit.balance";
		/** Account-wide daily totals, merged host-side across every session. */
		const REPORT_PATH = "/api/dsh-cost-audit.report";
		/** The report's headline window, and the window it is compared against. */
		const REPORT_DAYS = 7;
		const REPORT_MIN_INTERVAL_MS = 60000;
		/** Every field one day bucket carries; anything missing counts as zero. */
		const REPORT_FIELDS = [
			"costNano",
			"cacheReadCostNano",
			"uncachedCostNano",
			"outputCostNano",
			"compactionCostNano",
			"peakCostNano",
			"offPeakCostNano",
			"uncachedInputTokens",
			"cacheReadTokens",
			"cacheWriteTokens",
			"outputTokens",
			"turns",
			"steps",
			"toolCalls",
			"edits",
			"requests",
			"compactions"
		];
		const PROJECTION = "dshCostAudit";
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
			"session.aria": "会话费用 {cost} · 今日 {today} · 账户余额 {balance}（点击查看详情）",
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
			"cost.unpriced": "另有 {count} 未收录价格，未计入费用",
			"timing.title": "耗时分布",
			"timing.wall": "总耗时",
			"timing.model": "模型用时",
			"timing.ttft": "首 token 平均（TTFT）",
			"timing.decode": "模型生成",
			"timing.tool": "工具调用用时",
			"timing.other": "其他开销",
			"timing.byTool": "工具明细",
			"timing.more": "其余 {count} 个工具",
			"timing.calls": "{count} 次",
			"duration.seconds": "{seconds}秒",
			"duration.minutes": "{minutes}分{seconds}秒",
			"tps": "{tps} tok/s",
			"session.today": "今日",
			"session.cacheReadCost": "其中缓存重读",
			"session.compaction": "其中压缩摘要",
			"session.compactionValue": "{cost} · {count} 次压缩",
			"session.compactionManual": "{cost} · {count} 次压缩（含手动 {manual}）",
			"report.title": "全账号 · 最近 {days} 天",
			"report.vs": "对比前 {days} 天",
			"report.before": "前 {days} 天 {cost}",
			"report.steady": "基本持平",
			"report.rise": "↑ {percent}%",
			"report.fall": "↓ {percent}%",
			"report.perTurn": "每回合",
			"report.perTurnHint": "你每发一条消息平均花多少钱 —— 分母由你决定，建议改不动它，所以看趋势最公平",
			"report.perEdit": "每产出编辑",
			"report.perEditHint": "每 write / edit / present 一次多少钱 —— 工作量口径；纯聊天、纯调研的日子没有产出，显示 —",
			"report.perOutput": "每 1K 输出 token",
			"report.perOutputHint": "产出 1000 token 要付多少 —— 输入是输出的很多倍时它就高，缓存和上下文都在这里体现",
			"report.hit": "缓存命中率",
			"report.hitHint": "命中的输入按 1/50 计价（0.02 对 1 元/M）—— 掉一个点，钱就上一个台阶",
			"report.split": "重读 / 冷输入 / 输出",
			"report.splitHint": "这三项加起来才是总花费；只看总数看不出「为什么动了」",
			"report.compaction": "其中压缩摘要",
			"report.compactionHint": "摘要调用本身花的钱 —— 它已经算在上面三项里了，所以是子集，不是第四项",
			"report.peak": "高峰占比",
			"report.peakHint": "高峰是工作日 9-12 点与 14-18 点，单价翻倍 —— 这里只报数字，不做建议",
			"report.note": "金额按列表价计算。网页搜索与标题生成这两个调用的日志里没有用量，所以这是下界。报表能显示花费变了，但不能证明是你采纳的建议带来的。",
			"advice.pill": "{count} 条建议",
			"advice.title": "省 Token 建议",
			"advice.high": "紧急",
			"advice.warn": "注意",
			"advice.info": "参考",
			"advice.dismiss": "忽略这条",
			"advice.restore": "恢复已忽略的建议",
			"advice.contextReread.title": "上下文重读占了大头",
			"advice.contextReread.body": "本次会话 {totalCost} 里有 {cost}（{percent}%）是同一份上下文被重读了 {calls} 次。缩小上下文比少输出更省：开新会话、压缩，或让工具少吐内容。",
			"advice.fragmentedTools.title": "碎调用偏多",
			"advice.fragmentedTools.body": "{tool} 调用了 {calls} 次，其中 {fast} 次不到 2 秒。每次的输出都会进入上下文、并在之后每一轮被重读 —— 合并成一个脚本更省。",
			"advice.repeatedTarget.title": "同一目标反复调用",
			"advice.repeatedTarget.body": "{tool} 对同一个目标调用了 {count} 次：{target}",
			"advice.compactionChurn.title": "压缩偏频繁 / 摘要本身在花钱",
			"advice.compactionChurn.body": "系统自己压缩了 {automatic} 次（你手动触发的 {manual} 次不计入），这 {automatic} 次摘要花掉 {cost}（{percent}% 会话费用），累计重写 {shadowed} tok 上下文。阈值 thresholdRatio 越低，每次摘要要回放的历史越短、单次越便宜，但压得越勤 —— 这是次数与单价的取舍，不是单向的省。",
			"advice.compactionChurn.manual": "要改就改 agent preset 里的 `compaction-basic.thresholdRatio` —— 插件读不到也改不了宿主配置。",
			"advice.toolFailures.title": "同一工具连续失败",
			"advice.toolFailures.body": "{tool} 连续失败 {consecutive} 次。再试一次大概率还是一样 —— 先停下来看错误。",
			"advice.modelRetries.title": "模型重试偏多",
			"advice.modelRetries.body": "已重试 {retries} 次。重试会重复计费 —— 先确认是限速、超时，还是请求本身有问题。",
			"advice.idleGrinding.title": "只有调查、没有产出",
			"advice.idleGrinding.body": "连续 {steps} 步没有 write / edit / present（{calls} 次模型调用）。可能在反复调查 —— 人工给个方向比继续烧 token 划算。",
			"advice.cacheHitDrop.title": "缓存命中率下滑",
			"advice.cacheHitDrop.body": "{calls} 次调用里命中率 {percent}%。未命中按约 50 倍计价 —— 查一下是否有东西每轮在改请求头（AGENTS.md、技能注入）。",
			"advice.balanceLow.title": "余额偏低",
			"advice.balanceLow.body": "余额 {balance}，本会话已花 {cost}。按这个速度不多了。",
			"advice.modelRetries.manual": "先确认是限速、超时，还是请求本身有问题 —— 重试次数没有开关可调。",
			"advice.balanceLow.manual": "去 DeepSeek 控制台充值 —— 插件只能读余额，不能充值。",
			"advice.sent": "已发送",
			"advice.blocked": "输入框里还有内容 —— 先清空再执行",
			"advice.contextReread.action": "立即压缩本会话",
			"advice.contextReread.instruction": "/compact",
			"advice.fragmentedTools.action": "让它合并命令",
			"advice.fragmentedTools.instruction": "把刚才那一批零碎的命令合并成一次调用（写成一个脚本再跑），不要一条一条来。后续的验证也照此办理。",
			"advice.repeatedTarget.action": "让它别重复读",
			"advice.repeatedTarget.instruction": "你在反复读同一个目标：{target}。一次读完把结论记下来，之后改用 grep 或局部读取定位，不要整篇重读。",
			"advice.idleGrinding.action": "要一份进度汇报",
			"advice.idleGrinding.instruction": "停下当前动作，先汇报：你在找什么、已经试过什么、现在卡在哪、下一步打算做什么。不要继续盲目摸索。",
			"advice.toolFailures.action": "让它停下看错误",
			"advice.toolFailures.instruction": "{tool} 已经连续失败多次。停下来把完整错误读一遍，说明根因和下一步方案，不要重复同样的调用。",
			"advice.cacheHitDrop.action": "让它排查缓存",
			"advice.cacheHitDrop.instruction": "本会话的缓存命中率偏低。查清楚是什么在每一轮改变请求头或前缀（AGENTS.md、技能注入、系统提示），找出并说明。",
			"advice.contextReread.note": "当前上下文 {context} token（上次实测）—— 压缩的收益看的是这个数，不是历史占比",
			"advice.contextReread.pointless": "现在再压基本是白花钱：刚压过（上次花了 {cost}），或上下文已经不大（{context} token）。等它再涨回来，这个按钮会自己回来。",
			"advice.contextReread.ran": "已执行 /compact",
			"advice.fragmentedTools.ran": "已发出合并指令",
			"advice.repeatedTarget.ran": "已发出停止重读的指令",
			"advice.idleGrinding.ran": "已发出进度汇报指令",
			"advice.toolFailures.ran": "已发出排障指令",
			"advice.cacheHitDrop.ran": "已发出排查缓存的指令",
			"verdict.improved": "已采纳 · 有改善",
			"verdict.steady": "已采纳 · 基本持平",
			"verdict.worse": "已采纳 · 反而变差",
			"verdict.waiting": "已采纳 · 还在观察",
			"verdict.metric": "{label}：{before} → {after}",
			"verdict.sample": "采纳后已有 {calls} 次调用 / {requests} 次模型调用",
			"verdict.done": "采纳后完成 {edits} 次改动，当前连续 {steps} 步无产出",
			"verdict.metric.prompt": "每请求上下文 token",
			"verdict.metric.fast": "短调用占比",
			"verdict.metric.repeat": "重复调用占比",
			"verdict.metric.hit": "缓存命中率",
			"verdict.metric.error": "工具失败占比",
			"verdict.spent": "本次花费 {cost}",
			"verdict.baseline": "基线 {label} {value}",
			"verdict.remaining.requests": "还差 {n} 次模型调用判定",
			"verdict.remaining.toolCalls": "还差 {n} 次工具调用判定",
			"verdict.remaining.steps": "还差 {n} 步判定",
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
			"session.aria": "Session cost {cost} · today {today} · balance {balance} (click for details)",
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
			"cost.unpriced": "{count} further tokens have no listed price and are not billed here",
			"timing.title": "Timing",
			"timing.wall": "Total wall",
			"timing.model": "LLM time",
			"timing.ttft": "Avg time to first token (TTFT)",
			"timing.decode": "Generation",
			"timing.tool": "Tool time",
			"timing.other": "Other overhead",
			"timing.byTool": "By tool",
			"timing.more": "{count} more tools",
			"timing.calls": "{count} calls",
			"duration.seconds": "{seconds}s",
			"duration.minutes": "{minutes}m {seconds}s",
			"tps": "{tps} tok/s",
			"session.today": "today",
			"session.cacheReadCost": "of which cache re-read",
			"session.compaction": "of which compaction",
			"session.compactionValue": "{cost} · {count}×",
			"session.compactionManual": "{cost} · {count}× ({manual} manual)",
			"report.title": "Whole account · last {days} days",
			"report.vs": "vs the previous {days} days",
			"report.before": "{cost} the week before",
			"report.steady": "about the same",
			"report.rise": "up {percent}%",
			"report.fall": "down {percent}%",
			"report.perTurn": "Per turn",
			"report.perTurnHint": "What one message of yours costs on average — the denominator is yours, no advice can move it, so the trend is the fair comparison",
			"report.perEdit": "Per edit delivered",
			"report.perEditHint": "What one write / edit / present costs — the work denominator; a day of pure chat or research has none and reads —",
			"report.perOutput": "Per 1K output tokens",
			"report.perOutputHint": "What 1000 tokens of output costs — it rises when the input is many times the output, which is where cache and context show up",
			"report.hit": "Cache hit rate",
			"report.hitHint": "A hit bills at 1/50 of a miss (0.02 vs 1 CNY per M) — one point off and the money steps up",
			"report.split": "Re-read / cold input / output",
			"report.splitHint": "These three are the total; the total alone cannot say why it moved",
			"report.compaction": "of which compaction",
			"report.compactionHint": "What the summarization calls cost — already inside the three above, so a subset rather than a fourth line",
			"report.peak": "Peak-hour share",
			"report.peakHint": "Peak is Mon-Fri 09-12 and 14-18, at double the price — a figure here, not advice",
			"report.note": "Amounts use the configured list prices. The web-search and title-generation calls carry no usage in the log, so this is a lower bound. The report shows that spending moved; it cannot show that your own advice caused it.",
			"advice.pill": "{count} tips",
			"advice.title": "Token-saving tips",
			"advice.high": "Urgent",
			"advice.warn": "Watch",
			"advice.info": "FYI",
			"advice.dismiss": "Dismiss",
			"advice.restore": "Show dismissed tips",
			"advice.contextReread.title": "Most spend is context re-read",
			"advice.contextReread.body": "{cost} of {totalCost} ({percent}%) is the same context re-read across {calls} requests. A smaller context saves more than shorter answers: start a fresh session, compact, or have tools emit less.",
			"advice.fragmentedTools.title": "Fragmented calls",
			"advice.fragmentedTools.body": "{tool} ran {calls} times, {fast} of them under 2s. Every result joins the context and is re-read on later turns — merging them into one script saves both.",
			"advice.repeatedTarget.title": "Same target again and again",
			"advice.repeatedTarget.body": "{tool} hit the same target {count} times: {target}",
			"advice.compactionChurn.title": "Compaction churn, and its own bill",
			"advice.compactionChurn.body": "The harness compacted on its own {automatic} times ({manual} manual ones are not counted); those summaries cost {cost} ({percent}% of the session) and rewrote {shadowed} tok of context. A lower thresholdRatio shortens each replay and cheapens each summary, but makes them more frequent — that trades frequency against unit price, it is not a one-way saving.",
			"advice.compactionChurn.manual": "Change `compaction-basic.thresholdRatio` in the agent preset — the plugin can neither read nor write host configuration.",
			"advice.toolFailures.title": "Repeated tool failure",
			"advice.toolFailures.body": "{tool} failed {consecutive} times in a row. Another attempt probably fails the same way — stop and read the error.",
			"advice.modelRetries.title": "Many model retries",
			"advice.modelRetries.body": "{retries} retries so far. Retries bill twice — check whether it is rate limiting, a timeout, or the request itself.",
			"advice.idleGrinding.title": "Investigation without output",
			"advice.idleGrinding.body": "{steps} steps with no write, edit, or deliverable ({calls} model calls). Possibly going in circles — a human steer is cheaper than more tokens.",
			"advice.cacheHitDrop.title": "Cache hit rate has fallen",
			"advice.cacheHitDrop.body": "{percent}% hit rate over {calls} calls. A miss bills at roughly 50× — check whether something rewrites the request head every turn (AGENTS.md, skill injection).",
			"advice.balanceLow.title": "Balance running low",
			"advice.balanceLow.body": "Balance {balance}; this session has spent {cost}.",
			"advice.modelRetries.manual": "Check whether it is rate limiting, a timeout, or the request itself — there is no retry setting to turn down.",
			"advice.balanceLow.manual": "Top up in the DeepSeek console — the plugin can read the balance but not add to it.",
			"advice.sent": "Sent",
			"advice.blocked": "Clear the composer first",
			"advice.contextReread.action": "Compact this session",
			"advice.contextReread.instruction": "/compact",
			"advice.fragmentedTools.action": "Ask it to merge commands",
			"advice.fragmentedTools.instruction": "Merge that batch of small commands into a single call — write one script and run it — instead of one at a time. Do the same for later verification.",
			"advice.repeatedTarget.action": "Ask it to stop re-reading",
			"advice.repeatedTarget.instruction": "You keep re-reading the same target: {target}. Read it once, keep the conclusion, then locate things with grep or a partial read instead of reading it whole again.",
			"advice.idleGrinding.action": "Ask for a status report",
			"advice.idleGrinding.instruction": "Stop and report: what you are looking for, what you have already tried, where you are stuck, and what you plan to do next. Do not keep probing blindly.",
			"advice.toolFailures.action": "Ask it to read the error",
			"advice.toolFailures.instruction": "{tool} has failed repeatedly. Stop, read the full error, and state the root cause and your next plan; do not repeat the same call.",
			"advice.cacheHitDrop.action": "Ask it to investigate",
			"advice.cacheHitDrop.instruction": "This session's cache hit rate is low. Find out what changes the request head or prefix every turn (AGENTS.md, skill injection, system prompt) and report it.",
			"advice.contextReread.note": "Current context: {context} tokens as last measured — what compaction buys depends on this, not on the lifetime share",
			"advice.contextReread.pointless": "Compacting now would buy nothing: one already ran (it cost {cost}) or the context is already small ({context} tokens). The button comes back once it grows again.",
			"advice.contextReread.ran": "Ran /compact",
			"advice.fragmentedTools.ran": "Sent the merge instruction",
			"advice.repeatedTarget.ran": "Sent the stop-re-reading instruction",
			"advice.idleGrinding.ran": "Sent the status-report instruction",
			"advice.toolFailures.ran": "Sent the read-the-error instruction",
			"advice.cacheHitDrop.ran": "Sent the cache-investigation instruction",
			"verdict.improved": "Adopted · improved",
			"verdict.steady": "Adopted · about the same",
			"verdict.worse": "Adopted · got worse",
			"verdict.waiting": "Adopted · too early to tell",
			"verdict.metric": "{label}: {before} → {after}",
			"verdict.sample": "{calls} tool calls / {requests} model calls since adoption",
			"verdict.done": "{edits} edits since adoption; {steps} steps without output right now",
			"verdict.metric.prompt": "Context tokens per request",
			"verdict.metric.fast": "Short-call share",
			"verdict.metric.repeat": "Repeat-call share",
			"verdict.metric.hit": "Cache hit rate",
			"verdict.metric.error": "Tool failure share",
			"verdict.spent": "Cost {cost}",
			"verdict.baseline": "Baseline {label} {value}",
			"verdict.remaining.requests": "{n} more model calls before a verdict",
			"verdict.remaining.toolCalls": "{n} more tool calls before a verdict",
			"verdict.remaining.steps": "{n} more steps before a verdict",
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
			".dshstats-row{max-width:var(--dsh-chat-content-width);box-sizing:border-box;width:100%;padding:2px calc(var(--dsh-composer-side-clearance) + 16px) 0;font-size:var(--dsh-content-font-size-secondary,13px);line-height:calc(20px + var(--dsh-content-font-delta-secondary,0px));justify-content:center;align-items:center;gap:12px;margin:0 auto;display:flex}",
			// Sharing the official session-stats line: the row is lifted by the
			// official row's measured height and its content indented past the
			// official pills. `pointer-events` keeps the official pills clickable
			// underneath the lifted row.
			".dshstats-row[data-dsh-stats-inline]{max-width:none;height:var(--dshstats-lift,auto);margin:calc(-1 * var(--dshstats-lift,0px)) 0 0;padding:0;justify-content:flex-start;pointer-events:none}",
			// A margin (not padding) carries the indent: it may legitimately be
			// negative when this row is wider than the official content, and
			// padding would clamp that to zero. Only the first child takes it —
			// the row's own gap spaces everything after.
			".dshstats-row[data-dsh-stats-inline]>*{pointer-events:auto}",
			".dshstats-row[data-dsh-stats-inline]>:first-child{margin-left:var(--dshstats-indent,0px)}",
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
			".dshstats-details .dshstats-note{grid-column:1 / -1;color:var(--dsw-alias-label-caption);text-align:left}",
			".dshstats-details .dshstats-sectionTitle{grid-column:1 / -1;color:var(--dsw-alias-label-caption);text-align:left}",
			".dshstats-details .dshstats-sub{color:var(--dsw-alias-label-caption)}",
			".dshstats-pill-warn{color:var(--dsw-alias-state-warn-label)}",
			".dshstats-pill-high{color:var(--dsw-alias-state-error-primary)}",
			".dshstats-advice{max-width:min(440px,100vw - 24px);margin-top:12px}",
			".dshstats-advice:first-child{margin-top:0}",
			".dshstats-adviceHead{align-items:center;gap:8px;display:flex}",
			".dshstats-adviceTitle{color:var(--dsw-alias-label-primary);flex:1;min-width:0;font-weight:500}",
			".dshstats-adviceBody{color:var(--dsw-alias-label-tertiary);margin:4px 0 0;overflow-wrap:anywhere}",
			".dshstats-tag{border-radius:4px;flex:none;padding:0 4px;font-size:11px;line-height:16px}",
			".dshstats-tag-high{background:var(--dsw-alias-state-error-tertiary);color:var(--dsw-alias-state-error-primary)}",
			".dshstats-tag-warn{background:var(--dsw-alias-state-warn-tertiary);color:var(--dsw-alias-state-warn-primary)}",
			".dshstats-tag-info{background:var(--dsw-alias-bg-tertiary);color:var(--dsw-alias-label-tertiary)}",
			".dshstats-dismiss,.dshstats-restore{color:var(--dsw-alias-label-caption);cursor:pointer;background:0 0;border:none;padding:0;font:inherit}",
			".dshstats-dismiss:hover,.dshstats-restore:hover{color:var(--dsw-alias-label-secondary);text-decoration:underline}",
			".dshstats-restore{margin-top:12px}",
			".dshstats-adviceFoot{margin-top:8px}",
			".dshstats-act{color:var(--dsw-alias-label-primary);background:var(--dsw-alias-interactive-bg-hover);border:.5px solid var(--dsw-alias-border-l2);border-radius:8px;padding:3px 10px;font:inherit;cursor:pointer}",
			".dshstats-act:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-pressed)}",
			".dshstats-act:disabled{color:var(--dsw-alias-label-caption);cursor:default;opacity:.6}",
			".dshstats-manual{color:var(--dsw-alias-label-caption)}",
			".dshstats-verdict{border-left:2px solid var(--dsw-alias-border-l2);padding-left:8px;display:grid;gap:2px}",
			".dshstats-verdict-improved{border-left-color:var(--dsw-alias-state-success-primary)}",
			".dshstats-verdict-worse{border-left-color:var(--dsw-alias-state-error-primary)}",
			".dshstats-verdict-waiting{border-left-color:var(--dsw-alias-state-warn-primary)}",
			".dshstats-verdictState{color:var(--dsw-alias-label-secondary);font-weight:500}",
			".dshstats-verdict-improved .dshstats-verdictState{color:var(--dsw-alias-state-success-primary)}",
			".dshstats-verdict-worse .dshstats-verdictState{color:var(--dsw-alias-state-error-primary)}",
			".dshstats-verdictRan{color:var(--dsw-alias-label-secondary)}",
			".dshstats-adviceNote{color:var(--dsw-alias-label-caption);line-height:1.35}",
			".dshstats-reportTotal{display:flex;gap:6px;align-items:baseline;font-weight:500}",
			".dshstats-reportRow{display:grid;grid-template-columns:auto 1fr auto;gap:2px 8px;align-items:baseline}",
			".dshstats-reportLabel{color:var(--dsw-alias-label-secondary)}",
			".dshstats-reportValue{text-align:right;font-variant-numeric:tabular-nums}",
			".dshstats-reportDelta{color:var(--dsw-alias-label-tertiary);font-variant-numeric:tabular-nums}",
			".dshstats-reportHint{grid-column:1/-1;color:var(--dsw-alias-label-caption);line-height:1.35}",
			".dshstats-reportNote{margin:8px 0 0;color:var(--dsw-alias-label-caption);line-height:1.35}",
			".dshstats-verdictDetail,.dshstats-verdictSample,.dshstats-verdictSpent,.dshstats-verdictRemaining{color:var(--dsw-alias-label-tertiary)}"
		].join("");

		const STYLE_TAG = "dsh-cost-audit/pills.css";
		if (typeof document !== "undefined" && document.querySelector("style[data-plugin-css=" + JSON.stringify(STYLE_TAG) + "]") === null) {
			const tag = document.createElement("style");
			tag.dataset.plugin = "dsh-cost-audit";
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

		/**
		 * CNY text for a nano-CNY cost: always two decimals, everywhere. A
		 * ten-thousandth of a yuan is not a figure anyone acts on; the only
		 * exception is a real cost too small to survive the rounding, which says
		 * so rather than pretending to be free.
		 * @param costNano - cost in CNY × 1e9.
		 * @returns display string.
		 */
		function formatCny(costNano) {
			const yuan = costNano / NANO;
			if (!Number.isFinite(yuan)) return "—";
			if (yuan === 0) return "¥0";
			const rounded = Math.round(yuan * 100) / 100;
			return rounded === 0 ? "<¥0.01" : `¥${rounded.toFixed(2)}`;
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

		/**
		 * Compact token count for advisory prose (the panels stay exact).
		 * @param value - non-negative count.
		 * @param t - locale seat.
		 * @returns display string.
		 */
		function formatCompact(value, t) {
			const scaled = (candidate) => String(candidate >= 100 ? Math.round(candidate) : Math.round(candidate * 10) / 10);
			if (value < 1000) return String(value);
			if (value < 1000000) return t("number.thousand", { value: scaled(value / 1000) });
			return t("number.million", { value: scaled(value / 1000000) });
		}

		/**
		 * Compact duration, using the harness's own vocabulary: 45.2秒 under a
		 * minute, 2分42秒 from there on.
		 * @param ms - duration in milliseconds.
		 * @param t - locale seat.
		 * @returns display string.
		 */
		function formatDuration(ms, t) {
			const seconds = ms / 1000;
			if (seconds < 60) return t("duration.seconds", { seconds: Math.round(seconds * 10) / 10 });
			const whole = Math.round(seconds);
			return t("duration.minutes", { minutes: Math.floor(whole / 60), seconds: whole % 60 });
		}

		/** Duration plus a call count: `3分20秒 · 37 次`. */
		function durationWithCount(ms, count, t) {
			return `${formatDuration(ms, t)} · ${t("timing.calls", { count })}`;
		}

		/** How many tool names the panel ranks before summarising the tail. */
		const TOOL_ROWS = 6;

		/**
		 * The operation-type timing rows: wall time, model wait, generation, and
		 * tool execution ranked by tool name.
		 * @param timing - one timing bucket from the projection.
		 * @param t - locale seat.
		 * @returns an array of detail elements.
		 */
		function timingRows(timing, t) {
			const rows = [
				h(Detail, { key: "wall", label: t("timing.wall"), children: formatDuration(timing.wallMs, t) }),
				h(Detail, { key: "model", label: t("timing.model"), children: durationWithCount(timing.modelMs, timing.modelCalls, t) })
			];
			if (timing.ttftSteps > 0) {
				rows.push(h(Detail, { key: "ttft", label: t("timing.ttft"), children: formatDuration(timing.ttftMs / timing.ttftSteps, t) }));
			}
			if (timing.decodeMs > 0) {
				const tps = timing.decodeTokens / (timing.decodeMs / 1000);
				rows.push(
					h(Detail, {
						key: "decode",
						label: t("timing.decode"),
						children: `${formatDuration(timing.decodeMs, t)} · ${t("tps", { tps: Math.round(tps * 10) / 10 })}`
					})
				);
			}
			rows.push(h(Detail, { key: "tool", label: t("timing.tool"), children: durationWithCount(timing.toolMs, timing.toolCalls, t) }));
			// Sub-100ms remainders are measurement noise, not a line worth reading.
			const other = timing.wallMs - timing.modelMs - timing.toolMs;
			if (other >= 100) {
				rows.push(h(Detail, { key: "other", label: t("timing.other"), children: formatDuration(other, t) }));
			}
			const ranked = Object.entries(timing.tools).sort((left, right) => right[1].ms - left[1].ms);
			if (ranked.length > 0) {
				rows.push(h("dd", { key: "byTool", className: "dshstats-sectionTitle" }, t("timing.byTool")));
				for (const [name, tool] of ranked.slice(0, TOOL_ROWS)) {
					rows.push(h(Detail, { key: `tool:${name}`, label: name, children: durationWithCount(tool.ms, tool.calls, t), className: "dshstats-route" }));
				}
				if (ranked.length > TOOL_ROWS) {
					const rest = ranked.slice(TOOL_ROWS);
					const ms = rest.reduce((total, entry) => total + entry[1].ms, 0);
					rows.push(h(Detail, { key: "toolRest", label: t("timing.more", { count: rest.length }), children: formatDuration(ms, t) }));
				}
			}
			return rows;
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
			rows.push(h(Detail, { key: "cost", label: costLabel, children: bucket.pricedTokens > 0 ? formatCny(bucket.costNano) : "—" }));
			if (bucket.unpricedTokens > 0) {
				rows.push(
					h("dd", { key: "unpriced", className: "dshstats-note" }, t("cost.unpriced", { count: countText(bucket.unpricedTokens, t) }))
				);
			}
			return rows;
		}

		/**
		 * The panel chrome shared by both pills: title row, hairline rule, then
		 * one `dl` per section — the harness's own dialog geometry, extended
		 * with a labelled section rule between groups.
		 * @returns the portaled panel element, or null while closed.
		 */
		function panelOf({ open, panelRef, pos, icon, title, value, ariaLabel, sections = [], children = null }) {
			if (!open) return null;
			const blocks = [];
			sections.forEach((section, index) => {
				if (index > 0) blocks.push(h("div", { key: `rule:${String(index)}`, className: "dshstats-sectionRule", "aria-hidden": true }));
				blocks.push(
					h(
						"dl",
						{ key: `section:${String(index)}`, className: "dshstats-details" },
						section.title === undefined ? null : h("dd", { className: "dshstats-sectionTitle" }, section.title),
						section.rows
					)
				);
			});
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
					blocks,
					children
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
					ariaLabel: t("turn.title"),
					sections: [
						{ rows: details },
						timingOf(stats, turn) === undefined ? null : { title: t("timing.title"), rows: timingRows(timingOf(stats, turn), t) }
					].filter(Boolean)
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

		/**
		 * The timing bucket of one turn, or undefined when the fold never saw it.
		 * @param stats - the session's projection value.
		 * @param turn - the turn number.
		 * @returns the timing bucket.
		 */
		function timingOf(stats, turn) {
			return stats.timing === undefined ? undefined : stats.timing.turns[String(turn)];
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
		 * Whole-session `dshCostAudit` for one session, folded on the host.
		 *
		 * The projection pipeline only serves a unit once the session has a
		 * materialized cell, so a session whose persisted projection checkpoint
		 * predates this plugin carries no `dshCostAudit` — the endpoint covers
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
		 * The session's `dshCostAudit`: the live projection when the host serves it,
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

		/**
		 * The advice codes a button can actually settle. Every one of them is a
		 * submission into this session — either a slash command (`/compact`) or
		 * a steering instruction the agent reads on its next step. The rest are
		 * honest dead ends (a config value, a top-up), and the panel says so
		 * rather than offering a button that does nothing.
		 */
		const ADVICE_ACTIONS = new Set([
			"context-reread",
			"fragmented-tools",
			"repeated-target",
			"idle-grinding",
			"tool-failures",
			"cache-hit-drop"
		]);

		/** The advice icon, with a fallback in case a release renames it. */
		const ADVICE_ICON = primitives.IconLightOutline16 ?? primitives.IconDataOutline16;

		/** Stable code → locale key segment (dict keys must be identifier-shaped). */
		const ADVICE_KEYS = {
			"context-reread": "contextReread",
			"fragmented-tools": "fragmentedTools",
			"repeated-target": "repeatedTarget",
			"compaction-churn": "compactionChurn",
			"tool-failures": "toolFailures",
			"model-retries": "modelRetries",
			"idle-grinding": "idleGrinding",
			"cache-hit-drop": "cacheHitDrop",
			"balance-low": "balanceLow"
		};

		/**
		 * The interpolation object one advice's localized body needs. The host
		 * sends numbers and names only; every unit and currency is formatted
		 * here, where the locale and the formatters live.
		 * @param code - the advice code.
		 * @param values - the host's raw values.
		 * @param t - locale seat.
		 * @returns the template parameters.
		 */
		function adviceParams(code, values, t) {
			switch (code) {
				case "context-reread":
					return {
						percent: values.percent,
						calls: values.calls,
						cost: formatCny(values.costNano),
						totalCost: formatCny(values.totalCostNano)
					};
				case "fragmented-tools":
					return { tool: values.tool, calls: values.calls, fast: values.fast };
				case "repeated-target":
					return { tool: values.tool, target: values.target, count: values.count };
				case "compaction-churn":
					return {
						automatic: values.automatic,
						manual: values.manual,
						percent: values.percent,
						cost: formatCny(values.costNano),
						shadowed: formatCompact(values.shadowed, t)
					};
				case "tool-failures":
					return { tool: values.tool, consecutive: values.consecutive };
				case "model-retries":
					return { retries: values.retries };
				case "idle-grinding":
					return { steps: values.steps, calls: values.calls };
				case "cache-hit-drop":
					return { percent: values.percent, calls: values.calls };
				case "balance-low":
					return { balance: formatBalance(values.balance), cost: formatCny(values.costNano) };
				default:
					return {};
			}
		}

		/**
		 * The balance rule, which lives here because the balance is a live read
		 * rather than part of the folded log.
		 * @param stats - the session projection value.
		 * @param balance - the balance read result.
		 * @returns an advice item, or null.
		 */
		function balanceAdvice(stats, balance) {
			if (balance === undefined || balance.ok !== true || balance.balance === undefined) return null;
			const costNano = stats.total.costNano;
			if (costNano <= 0) return null;
			// Warn once the balance would cover fewer than five sessions at this
			// burn rate, or is below a floor that is small in absolute terms.
			if (balance.balance.total >= Math.max((costNano / NANO) * 5, 20)) return null;
			return { code: "balance-low", severity: "warn", values: { balance: balance.balance.total, costNano } };
		}

		/**
		 * Whether the one-click compaction would be money for nothing.
		 *
		 * The tip is raised by a *lifetime* share, but its button acts on the
		 * future, and a summarize call is not free — it re-reads the whole
		 * context at the miss rate (¥0.42 on the session this was written for).
		 * So the button is shown only while compacting can still buy something:
		 * if a compaction has run since the last measured request, or the
		 * context has already come down from its peak, pressing it pays for a
		 * second summary to remove context that is no longer there.
		 *
		 * The tip itself stays — the diagnosis is still true — and the button
		 * comes back on its own once the context grows again.
		 *
		 * @param code - the advice code.
		 * @param values - the host's raw values.
		 * @returns whether the action should be withheld.
		 */
		function compactionPointless(code, values) {
			if (code !== "context-reread" || values === undefined) return false;
			if (values.compactedSinceRequest === 1) return true;
			const peak = values.peakContextTokens ?? 0;
			const now = values.contextTokens ?? 0;
			return peak > 0 && now < peak * 0.5;
		}

		/**
		 * What one adopted tip is judged on. `metric` names a derived figure,
		 * `better` its good direction, `floor` the move that counts as a real
		 * change rather than noise, and `sample` the least evidence worth
		 * judging on.
		 */
		const VERDICTS = {
			"context-reread": { metric: "prompt", better: "lower", floor: 0.1, sample: 3, unit: "requests" },
			"fragmented-tools": { metric: "fast", better: "lower", floor: 0.15, sample: 10, unit: "toolCalls" },
			"repeated-target": { metric: "repeat", better: "lower", floor: 0.1, sample: 10, unit: "toolCalls" },
			"tool-failures": { metric: "error", better: "lower", floor: 0.05, sample: 10, unit: "toolCalls" },
			"cache-hit-drop": { metric: "hit", better: "higher", floor: 0.05, sample: 10, unit: "toolCalls" }
		};

		/** One figure from a metrics reading: the label, and the number to compare. */
		function metricValue(metric, reading) {
			const requests = Math.max(1, reading.requests);
			const calls = Math.max(1, reading.toolCalls);
			switch (metric) {
				case "prompt":
					return reading.promptTokens / requests;
				case "fast":
					return reading.fastCalls / calls;
				case "repeat":
					return reading.repeatCalls / calls;
				case "error":
					return reading.toolErrors / calls;
				case "hit":
					return reading.cacheReadTokens / Math.max(1, reading.promptTokens);
				default:
					return 0;
			}
		}

		/** Render one figure for its metric's unit. */
		function metricText(metric, value, t) {
			if (metric === "prompt") return formatCompact(value, t);
			return `${Math.round(value * 1000) / 10}%`;
		}

		/**
		 * Judge one adopted tip against the reading taken when it was applied.
		 *
		 * Everything is measured "since adoption" — the difference of two
		 * cumulative readings — rather than against a lifetime average that
		 * history would drown out. Until the sample is large enough the verdict
		 * stays explicitly undecided instead of guessing.
		 *
		 * @param code - the advice code.
		 * @param baseline - the metrics object captured at adoption.
		 * @param current - the metrics object now.
		 * @param t - locale seat.
		 * @returns the verdict state, its one-line evidence, and — while the
		 *   sample is still short — how much more evidence it is waiting for.
		 */
		function assessAdoption(code, baseline, current, t) {
			if (baseline === undefined || current === undefined) return { state: "waiting", detail: null, remaining: null };
			const since = {
				requests: current.requests - baseline.requests,
				toolCalls: current.toolCalls - baseline.toolCalls,
				steps: current.steps - baseline.steps
			};
			if (code === "idle-grinding") {
				const edits = current.productiveCalls - baseline.productiveCalls;
				const detail = t("verdict.done", { edits, steps: current.stepsSinceProductive });
				if (since.steps < 3) return { state: "waiting", detail, remaining: t("verdict.remaining.steps", { n: 3 - since.steps }) };
				if (current.stepsSinceProductive < current.steps && edits > 0) return { state: "improved", detail, remaining: null };
				if (edits === 0 && current.stepsSinceProductive >= baseline.stepsSinceProductive) return { state: "worse", detail, remaining: null };
				return { state: "steady", detail, remaining: null };
			}
			const plan = VERDICTS[code];
			if (plan === undefined) return { state: "waiting", detail: null, remaining: null };
			const sample = since[plan.unit];
			const label = t(`verdict.metric.${plan.metric}`);
			const before = metricValue(plan.metric, baseline);
			// With nothing measured yet there is no "after" to show — a 0/1
			// division would print a meaningless 0% or 100%. The baseline is
			// still worth printing: it is the evidence that the click landed.
			if (sample === 0) {
				return {
					state: "waiting",
					detail: t("verdict.baseline", { label, value: metricText(plan.metric, before, t) }),
					remaining: t(`verdict.remaining.${plan.unit}`, { n: plan.sample })
				};
			}
			const after = metricValue(plan.metric, { ...current, requests: since.requests, toolCalls: since.toolCalls, promptTokens: current.promptTokens - baseline.promptTokens, cacheReadTokens: current.cacheReadTokens - baseline.cacheReadTokens, fastCalls: current.fastCalls - baseline.fastCalls, repeatCalls: current.repeatCalls - baseline.repeatCalls, toolErrors: current.toolErrors - baseline.toolErrors });
			const detail = t("verdict.metric", { label, before: metricText(plan.metric, before, t), after: metricText(plan.metric, after, t) });
			if (sample < plan.sample) return { state: "waiting", detail, remaining: t(`verdict.remaining.${plan.unit}`, { n: plan.sample - sample }) };
			// `floor` is a share of the baseline, not an absolute move: one
			// metric is a ratio (short-call share) and another is a token count
			// (context per request), and both must be judged on the same scale.
			if (before === 0) return { state: "steady", detail, remaining: null };
			const move = (plan.better === "lower" ? before - after : after - before) / before;
			if (move >= plan.floor) return { state: "improved", detail, remaining: null };
			if (move <= -plan.floor) return { state: "worse", detail, remaining: null };
			return { state: "steady", detail, remaining: null };
		}

		/**
		 * Sessions whose dismissed advice codes are remembered in this browser.
		 *
		 * Deliberately still `dsh-stats.*` after the plugin became dsh-cost-audit:
		 * an adoption record carries the metric reading its verdict will be
		 * judged against, so renaming the namespace would silently throw away
		 * what the user already acted on and leave their verdict blocks blank.
		 * The CSS namespace keeps the old name for a weaker version of the same
		 * reason — it is invisible, and renaming it would churn every selector.
		 */
		const DISMISS_PREFIX = "dsh-stats.dismissed";

		/** Read the advice codes dismissed for one session. */
		function readDismissed(sessionId) {
			try {
				const raw = localStorage.getItem(`${DISMISS_PREFIX}.${String(sessionId)}`);
				const parsed = raw === null ? null : JSON.parse(raw);
				return Array.isArray(parsed) ? parsed.filter((code) => typeof code === "string") : [];
			} catch {
				return [];
			}
		}

		/** Persist the advice codes dismissed for one session. */
		function writeDismissed(sessionId, codes) {
			try {
				localStorage.setItem(`${DISMISS_PREFIX}.${String(sessionId)}`, JSON.stringify(codes));
			} catch {
				// A browser refusing storage is not a reason to break the view.
			}
		}

		/** Adopted tips, with the metrics reading taken when each was applied. */
		const ADOPTED_PREFIX = "dsh-stats.adopted";

		/** Read the tips adopted for one session, in adoption order. */
		function readAdopted(sessionId) {
			try {
				const raw = localStorage.getItem(`${ADOPTED_PREFIX}.${String(sessionId)}`);
				const parsed = raw === null ? null : JSON.parse(raw);
				return Array.isArray(parsed) ? parsed.filter((item) => item !== null && typeof item === "object" && typeof item.code === "string") : [];
			} catch {
				return [];
			}
		}

		/** Persist the adopted tips for one session. */
		function writeAdopted(sessionId, records) {
			try {
				localStorage.setItem(`${ADOPTED_PREFIX}.${String(sessionId)}`, JSON.stringify(records));
			} catch {
				// A browser refusing storage is not a reason to break the view.
			}
		}

		/** Marks the row as sharing the official session-stats line. */
		const INLINE_ATTR = "data-dsh-stats-inline";

		/**
		 * Share the official session-stats line, centred.
		 *
		 * The composer dock stacks its slot entries and the official stats row
		 * is a centred flex row this plugin does not own. Sharing its line means
		 * three measured things: lift this row by the official row's height,
		 * indent its content to start where the official content ends, and give
		 * the official row back half of what this pill adds — a horizontal
		 * `translateX` on the official node, cleared whenever this pill goes
		 * away — so the pair stays centred on the axis the official row already
		 * sat on. Measuring means a longer official label, a changed font size,
		 * or a resized window all land in the right place, and when the pair
		 * would not fit in the band the whole thing falls back to a centred line
		 * of its own rather than overlapping.
		 * @param rowRef - ref on the row being placed.
		 */
		function useInlineWithStats(rowRef) {
			/** The official node currently carrying this plugin's centring shift. */
			const shifted = react.useRef(null);
			const place = react.useCallback(() => {
				const row = rowRef.current;
				if (row === null) return;
				const unshift = () => {
					if (shifted.current !== null) {
						shifted.current.style.transform = "";
						shifted.current = null;
					}
				};
				const clear = () => {
					row.removeAttribute(INLINE_ATTR);
					row.style.removeProperty("--dshstats-lift");
					row.style.removeProperty("--dshstats-indent");
					unshift();
				};
				const official = document.querySelector("[data-composer-stats]");
				const own = [...row.children];
				if (official === null || own.length === 0 || official.getBoundingClientRect().height === 0) {
					clear();
					return;
				}
				const gap = Number.parseFloat(getComputedStyle(official).columnGap) || 0;
				const children = [...official.children];
				const content = children.reduce((total, child) => total + child.getBoundingClientRect().width, 0) + gap * Math.max(0, children.length - 1);
				const pillWidth = own.reduce((total, child) => total + child.getBoundingClientRect().width, 0) + gap * Math.max(0, own.length - 1);
				// The slot wrappers between this row and the composer stack are
				// `display: contents`, so they measure 0 — walk out to the first
				// ancestor that actually owns the band.
				let band = row.parentElement;
				while (band !== null && band.getBoundingClientRect().width === 0) band = band.parentElement;
				const halfBand = (band === null ? row.getBoundingClientRect().width : band.getBoundingClientRect().width) / 2;
				if ((content + gap + pillWidth) / 2 > halfBand - 4) {
					clear();
					return;
				}
				row.setAttribute(INLINE_ATTR, "");
				const lift = `${official.getBoundingClientRect().height}px`;
				// `50%` is this row's own centre, which is the official row's
				// centre too — the two rows are centred in the same band. The
				// official row then gives up half of what this pill adds, so the
				// pair's centre stays on that axis and this pill's start is the
				// group's left edge plus the official content.
				const indent = `calc(50% + ${String((content + gap - pillWidth) / 2)}px)`;
				if (row.style.getPropertyValue("--dshstats-lift") !== lift) row.style.setProperty("--dshstats-lift", lift);
				if (row.style.getPropertyValue("--dshstats-indent") !== indent) row.style.setProperty("--dshstats-indent", indent);
				const shift = `translateX(${String(-(gap + pillWidth) / 2)}px)`;
				if (official.style.transform !== shift) official.style.transform = shift;
				shifted.current = official;
			}, [rowRef]);
			react.useLayoutEffect(place);
			react.useEffect(() => {
				window.addEventListener("resize", place);
				// The official stats row mounts on its own schedule and its labels
				// change as the session runs, so placement cannot rely on this
				// component rendering again.
				const parent = rowRef.current?.parentElement ?? null;
				const observer = parent === null ? null : new MutationObserver(place);
				observer?.observe(parent, { childList: true, subtree: true, characterData: true });
				return () => {
					window.removeEventListener("resize", place);
					observer?.disconnect();
					// Never leave the official row shifted on this plugin's behalf.
					if (shifted.current !== null) {
						shifted.current.style.transform = "";
						shifted.current = null;
					}
				};
			}, [place, rowRef]);
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
			if (typeof props.useInput !== "function" || props.inputActions === undefined) return null;
			return h(SessionRow, props);
		}

		/**
		 * The whole-session cost + account-balance pill. Rendered under the
		 * official session stats row; the balance is read once on mount so the
		 * pill's own label is live, and re-read each time the panel opens.
		 * @param props - slot props carrying the session kit.
		 * @returns the pill, or null until the session has billed anything.
		 */
		/**
		 * Keeps a broken entry from taking the rest of the dock row with it.
		 * The advice pill is the newest and riskiest code here, and a crash in
		 * it must never cost a client its cost and balance pill.
		 */
		class SlotBoundary extends react.Component {
			constructor(props) {
				super(props);
				this.state = { failed: false };
			}
			static getDerivedStateFromError() {
				return { failed: true };
			}
			componentDidCatch(error) {
				console.error("[dsh-cost-audit] slot entry failed", error);
			}
			render() {
				return this.state.failed ? null : this.props.children;
			}
		}

		/**
		 * The whole session-stats surface: one dock row that shares the official
		 * stats line, holding the cost + balance pill and, when there is
		 * something worth saying, the advice pill. The row owns the placement,
		 * so both pills are measured as one group.
		 */
		function SessionRow(props) {
			const rowRef = react.useRef(null);
			const stats = useSessionStats(props);
			const balance = useBalance();
			useInlineWithStats(rowRef);
			if (stats === undefined || stats.total === undefined) return null;
			if (totalTokensOf(stats.total) === 0) return null;
			const shared = { ...props, stats, balance };
			return h(
				"span",
				{ ref: rowRef, className: "dshstats-row", "data-dsh-stats-session": true },
				h(SessionCostPill, shared),
				h(SlotBoundary, null, h(AdvicePill, shared))
			);
		}

		/** The `YYYY-MM-DD` key the host would have used for this instant, on this clock. */
		function reportDayKey(date) {
			return `${String(date.getFullYear())}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
		}

		/**
		 * This session's spend so far today, read from the fold's own daily
		 * buckets by the browser's calendar day — the same clock the host keyed
		 * them with. A day with no settlements reads as zero, which is the
		 * honest answer for a session picked up again the next morning.
		 * @param stats - the session projection value.
		 * @returns cost in CNY × 1e9.
		 */
		function todayCostNano(stats) {
			if (stats.days === undefined) return 0;
			// A day became a structured bucket (v7); its cost is one field of it.
			return stats.days[reportDayKey(new Date())]?.costNano ?? 0;
		}

		/**
		 * Money at ratio scale.
		 *
		 * The pills round to two decimals because a ten-thousandth of a yuan is
		 * not a figure anyone acts on. A *ratio* is the opposite case: cost per
		 * turn is routinely under a cent, and "&lt;¥0.01" would hide the whole
		 * signal the report exists to show. So the report keeps four decimals
		 * below a cent and two above it.
		 *
		 * @param nano - amount in CNY × 1e9.
		 * @returns the formatted amount, or an em dash when there is nothing to divide.
		 */
		function formatRatio(nano) {
			if (nano === undefined || !Number.isFinite(nano) || nano === 0) return "—";
			const yuan = nano / NANO;
			return yuan < 0.01 ? `¥${yuan.toFixed(4)}` : `¥${yuan.toFixed(2)}`;
		}

		/** A ratio, or undefined when its denominator is empty — never a divide by zero. */
		function ratioOf(numerator, denominator) {
			return denominator > 0 ? numerator / denominator : undefined;
		}

		/**
		 * The move between two readings, within the range where a ratio means
		 * something.
		 *
		 * A week-over-week percentage is only as good as its baseline: with a
		 * near-empty previous window the first render of this panel reported
		 * "up 468363%", which is a fact about the baseline and not about
		 * spending. Past ten-fold in either direction the comparison prints the
		 * previous window's absolute instead, which stays true at any ratio.
		 *
		 * @param current - this window's reading.
		 * @param previous - the previous window's reading.
		 * @param t - locale seat.
		 * @returns the delta text, or null when there is nothing to compare.
		 */
		function reportDelta(current, previous, t) {
			if (current === undefined || previous === undefined || previous === 0) return null;
			const move = (current - previous) / previous;
			if (Math.abs(move) > 10) return t("report.before", { cost: formatRatio(previous), days: REPORT_DAYS });
			if (Math.abs(move) < 0.01) return t("report.steady");
			return t(move > 0 ? "report.rise" : "report.fall", { percent: Math.round(Math.abs(move) * 100) });
		}

		/**
		 * Sum `length` calendar days ending `offset` days before today.
		 * @param days - the merged calendar from the report route.
		 * @param offset - how many days back the window ends.
		 * @param length - how many days the window spans.
		 * @returns the summed fields.
		 */
		function reportWindow(days, offset, length) {
			const total = {};
			for (const field of REPORT_FIELDS) total[field] = 0;
			const cursor = new Date();
			cursor.setHours(0, 0, 0, 0);
			cursor.setDate(cursor.getDate() - offset);
			for (let index = 0; index < length; index += 1) {
				const day = days[reportDayKey(cursor)];
				if (day !== undefined) {
					for (const field of REPORT_FIELDS) total[field] += day[field] ?? 0;
				}
				cursor.setDate(cursor.getDate() - 1);
			}
			return total;
		}

		/**
		 * The account-wide report as rows.
		 *
		 * Every row carries its own one-line explanation, because a denominator
		 * nobody understands is worse than no number: the first question this
		 * panel got was "which of these is actually the work".
		 *
		 * @param report - the report route's answer.
		 * @param t - locale seat.
		 * @returns the headline plus rows, or null when there is nothing to show.
		 */
		function reportRows(report, t) {
			const days = report !== undefined && report.ok === true ? report.days : undefined;
			if (days === undefined) return null;
			const now = reportWindow(days, 0, REPORT_DAYS);
			const before = reportWindow(days, REPORT_DAYS, REPORT_DAYS);
			if (now.requests === 0 && before.requests === 0) return null;
			const prompt = now.cacheReadTokens + now.uncachedInputTokens + now.cacheWriteTokens;
			const pastPrompt = before.cacheReadTokens + before.uncachedInputTokens + before.cacheWriteTokens;
			const perTurn = ratioOf(now.costNano, now.turns);
			const perEdit = ratioOf(now.costNano, now.edits);
			const perOutput = ratioOf(now.costNano, now.outputTokens / 1000);
			const hit = ratioOf(now.cacheReadTokens, prompt);
			return {
				total: formatCny(now.costNano),
				totalDelta: reportDelta(now.costNano, before.costNano, t),
				items: [
					{ key: "perTurn", label: t("report.perTurn"), value: formatRatio(perTurn), delta: reportDelta(perTurn, ratioOf(before.costNano, before.turns), t), hint: t("report.perTurnHint") },
					{ key: "perEdit", label: t("report.perEdit"), value: formatRatio(perEdit), delta: reportDelta(perEdit, ratioOf(before.costNano, before.edits), t), hint: t("report.perEditHint") },
					{
						key: "perOutput",
						label: t("report.perOutput"),
						value: formatRatio(perOutput),
						delta: reportDelta(perOutput, ratioOf(before.costNano, before.outputTokens / 1000), t),
						hint: t("report.perOutputHint")
					},
					{
						key: "hit",
						label: t("report.hit"),
						value: hit === undefined ? "—" : `${String(Math.round(hit * 1000) / 10)}%`,
						delta: reportDelta(hit, ratioOf(before.cacheReadTokens, pastPrompt), t),
						hint: t("report.hitHint")
					},
					{
						key: "split",
						label: t("report.split"),
						value: `${formatCny(now.cacheReadCostNano)} / ${formatCny(now.uncachedCostNano)} / ${formatCny(now.outputCostNano)}`,
						delta: null,
						hint: t("report.splitHint")
					},
					{ key: "compaction", label: t("report.compaction"), value: formatCny(now.compactionCostNano), delta: null, hint: t("report.compactionHint") },
					{
						key: "peak",
						label: t("report.peak"),
						value: now.costNano === 0 ? "—" : `${String(Math.round((now.peakCostNano / now.costNano) * 1000) / 10)}%`,
						delta: null,
						hint: t("report.peakHint")
					}
				]
			};
		}

		/** The report, as one panel section. Nothing renders while the route is silent. */
		function reportSection(report, t) {
			const rows = reportRows(report, t);
			if (rows === null) return null;
			const items = rows.items.map((item) =>
				h(
					"div",
					{ key: item.key, className: "dshstats-reportRow" },
					h("span", { className: "dshstats-reportLabel" }, item.label),
					h("span", { className: "dshstats-reportValue" }, item.value),
					item.delta === null ? null : h("span", { className: "dshstats-reportDelta" }, item.delta),
					h("span", { className: "dshstats-reportHint" }, item.hint)
				)
			);
			return {
				title: t("report.title", { days: REPORT_DAYS }),
				rows: [
					h(
						"div",
						{ key: "report", className: "dshstats-report" },
						h(
							"div",
							{ className: "dshstats-reportTotal" },
							rows.total,
							rows.totalDelta === null ? null : h("span", { className: "dshstats-reportDelta" }, rows.totalDelta)
						),
						...items,
						h("p", { className: "dshstats-reportNote" }, t("report.note"))
					)
				]
			};
		}

		/** One report read is reused for a minute; folding every session is not free. */
		let reportCache = { at: 0, value: undefined };

		/** Read the account-wide report, or a reason it is unavailable. Never rejects. */
		async function readReport() {
			const now = Date.now();
			if (reportCache.value !== undefined && now - reportCache.at < REPORT_MIN_INTERVAL_MS) return reportCache.value;
			try {
				const response = await fetch(REPORT_PATH, {
					method: "POST",
					headers: { "content-type": "application/json" },
					body: "{}"
				});
				if (!response.ok) return { ok: false, reason: `http-${String(response.status)}` };
				const parsed = await response.json();
				reportCache = { at: now, value: parsed };
				return parsed;
			} catch {
				return { ok: false, reason: "transport" };
			}
		}

		/** The account-wide report for the panel, fetched once per minute at most. */
		function useReport() {
			const [report, setReport] = react.useState(undefined);
			react.useEffect(() => {
				let live = true;
				readReport().then((result) => {
					if (live) setReport(result);
				});
				return () => {
					live = false;
				};
			}, []);
			return report;
		}

		/** The live account read, lifted so both pills (and the panel) share one fetch. */
		function useBalance() {
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
			return { value: balance, refresh };
		}

		function SessionCostPill(props) {
			const { t, stats, balance } = props;
			const seat = useStatDialog();
			const report = useReport();
			react.useEffect(() => {
				if (!seat.open) return undefined;
				return balance.refresh();
			}, [seat.open, balance]);
			const bucket = stats.total;
			const cost = formatCny(bucket.costNano);
			const today = formatCny(todayCostNano(stats));
			const balanceLabel = balanceText(balance.value, t);
			const loaded = balance.value !== undefined && balance.value.ok === true;
			const sections = [{ rows: bucketDetails(bucket, t, "session", t("session.cost")) }];
			// `bucketDetails` ends with the session total; the daily figure breaks
			// that total down, so it sits immediately after it and before the
			// shares of it that this block appends next.
			sections[0].rows.push(h(Detail, { key: "today", label: t("session.today"), children: formatCny(todayCostNano(stats)) }));
			if (bucket.cacheReadCostNano !== undefined) {
				sections[0].rows = sections[0].rows.concat([
					h(Detail, {
						key: "cacheReadCost",
						label: t("session.cacheReadCost"),
						children: formatCny(bucket.cacheReadCostNano)
					})
				]);
			}
			if (stats.compaction !== undefined && stats.compaction.summaryCostNano > 0) {
				// Name the ones the human asked for: without it this row cannot
				// answer "did I do that, or did the harness?".
				const manual = stats.compaction.manual ?? 0;
				sections[0].rows = sections[0].rows.concat([
					h(Detail, {
						key: "compactionCost",
						label: t("session.compaction"),
						children: t(manual > 0 ? "session.compactionManual" : "session.compactionValue", {
							cost: formatCny(stats.compaction.summaryCostNano),
							count: stats.compaction.count,
							manual
						})
					})
				]);
			}
			if (stats.timing !== undefined) sections.push({ title: t("timing.title"), rows: timingRows(stats.timing.total, t) });
			sections.push({
				title: t("session.balance"),
				rows: loaded
					? [
							h(Detail, { key: "total", label: t("balance.total"), children: formatBalance(balance.value.balance.total) }),
							h(Detail, { key: "granted", label: t("balance.granted"), children: formatBalance(balance.value.balance.granted) }),
							h(Detail, { key: "toppedUp", label: t("balance.toppedUp"), children: formatBalance(balance.value.balance.toppedUp) })
						]
					: [h(Detail, { key: "state", label: t("session.balance"), children: balanceLabel })]
			});
			// Account-wide, not this session's — labelled as such, and last, because
			// it answers a different question than everything above it.
			const account = reportSection(report, t);
			if (account !== null) sections.push(account);
			return h(
				"span",
				{ className: "dshstats-anchor" },
				h(
					"button",
					{
						ref: seat.rootRef,
						type: "button",
						className: "dshstats-pill",
						"aria-haspopup": "dialog",
						"aria-expanded": seat.open,
						"aria-label": t("session.aria", { cost, today, balance: balanceLabel }),
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
						`${t("session.today")} ${today}`,
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
					ariaLabel: t("session.title"),
					sections
				})
			);
		}

		/**
		 * The advice pill: it exists only while there is something to say, so a
		 * healthy session pays no space for it. Advice is dismissed per session
		 * and remembered in this browser.
		 */
		function AdvicePill(props) {
			const { t, stats, sessionId, balance, inputActions, useInput } = props;
			const seat = useStatDialog();
			const [dismissed, setDismissed] = react.useState(() => readDismissed(sessionId));
			const [adopted, setAdopted] = react.useState(() => readAdopted(sessionId));
			// `useInput` is a selector hook, exactly like `useChat` and
			// `useProjection`; two primitive reads keep it reference-stable.
			const draft = useInput((state) => state.draft);
			const phase = useInput((state) => state.phase);
			// Acting means writing the composer draft and submitting it, so the
			// composer has to be free first — never throw away what a human typed.
			const busy = draft.trim() !== "" || phase !== "plain";
			const run = (item) => {
				if (busy || inputActions === undefined) return;
				inputActions.setDraft(t(`advice.${ADVICE_KEYS[item.code]}.instruction`, adviceParams(item.code, item.values, t)));
				inputActions.submit();
				// Keep the reading taken at this moment: every later verdict is
				// the difference between it and a later one. The compaction
				// tally rides along so the `/compact` action's own bill can be
				// singled out once the summary call lands.
				const record = {
					code: item.code,
					at: Date.now(),
					baseline: stats.metrics,
					compactions: stats.compaction?.count ?? 0,
					compactionCost: stats.compaction?.summaryCostNano ?? 0
				};
				const next = adopted.some((entry) => entry.code === item.code)
					? adopted.map((entry) => (entry.code === item.code ? record : entry))
					: adopted.concat([record]);
				setAdopted(next);
				writeAdopted(sessionId, next);
			};
			const fromLog = Array.isArray(stats.advice) ? stats.advice : [];
			const low = balanceAdvice(stats, balance.value);
			const all = low === null ? fromLog : fromLog.concat([low]);
			const shown = all.filter((item) => !dismissed.includes(item.code));
			// An adopted tip leaves the count — it is no longer an open question,
			// it is being measured — but it stays in the list to be read.
			const open = shown.filter((item) => !adopted.some((entry) => entry.code === item.code));
			if (shown.length === 0) return null;
			const dismiss = (code) => {
				const next = dismissed.includes(code) ? dismissed : dismissed.concat([code]);
				setDismissed(next);
				writeDismissed(sessionId, next);
			};
			const restore = () => {
				setDismissed([]);
				writeDismissed(sessionId, []);
			};
			const worst = open.some((item) => item.severity === "high") ? "high" : open.some((item) => item.severity === "warn") ? "warn" : "info";
			const items = shown.map((item) => {
				const segment = ADVICE_KEYS[item.code] ?? "info";
				const action = ADVICE_ACTIONS.has(item.code);
				const record = adopted.find((entry) => entry.code === item.code);
				const verdict = record === undefined ? null : assessAdoption(item.code, record.baseline, stats.metrics, t);
				return h(
					"div",
					{ key: item.code, className: "dshstats-advice" },
					h(
						"div",
						{ className: "dshstats-adviceHead" },
						h("span", { className: `dshstats-tag dshstats-tag-${item.severity}` }, t(`advice.${item.severity}`)),
						h("span", { className: "dshstats-adviceTitle" }, t(`advice.${segment}.title`)),
						h(
							"button",
							{ type: "button", className: "dshstats-dismiss", onClick: () => dismiss(item.code) },
							t("advice.dismiss")
						)
					),
					h("p", { className: "dshstats-adviceBody" }, t(`advice.${segment}.body`, adviceParams(item.code, item.values, t))),
					h(
						"div",
						{ className: "dshstats-adviceFoot" },
						// The number the button acts on, shown before it is pressed.
						verdict === null && item.code === "context-reread" && item.values?.contextTokens !== undefined
							? h(
									"span",
									{ className: "dshstats-adviceNote" },
									t("advice.contextReread.note", { context: formatCompact(item.values.contextTokens, t) })
								)
							: null,
						verdict !== null
							? h(
									"div",
									{ className: `dshstats-verdict dshstats-verdict-${verdict.state}` },
									h("span", { className: "dshstats-verdictState" }, t(`verdict.${verdict.state}`)),
									// "Adopted" alone reads exactly like "nothing
									// happened"; name the thing that ran. For
									// `/compact` the command's own bill is
									// measurable too — its summary call lands a
									// moment later, so this may fill in on a
									// later render rather than immediately.
									action ? h("span", { className: "dshstats-verdictRan" }, t(`advice.${segment}.ran`)) : null,
									record.compactions !== undefined && stats.compaction !== undefined && stats.compaction.count > record.compactions && stats.compaction.summaryCostNano > record.compactionCost
										? h("span", { className: "dshstats-verdictSpent" }, t("verdict.spent", { cost: formatCny(stats.compaction.summaryCostNano - record.compactionCost) }))
										: null,
									verdict.detail === null ? null : h("span", { className: "dshstats-verdictDetail" }, verdict.detail),
									h(
										"span",
										{ className: "dshstats-verdictSample" },
										t("verdict.sample", {
											calls: Math.max(0, stats.metrics.toolCalls - (record.baseline?.toolCalls ?? 0)),
											requests: Math.max(0, stats.metrics.requests - (record.baseline?.requests ?? 0))
										})
									),
									verdict.remaining === null ? null : h("span", { className: "dshstats-verdictRemaining" }, verdict.remaining)
								)
							: action
								? compactionPointless(item.code, item.values)
									? h(
											"span",
											{ className: "dshstats-manual" },
											t("advice.contextReread.pointless", {
												context: formatCompact(item.values.contextTokens ?? 0, t),
												cost: formatCny(item.values.lastCompactionCostNano ?? 0)
											})
										)
									: h(
											"button",
											{
												type: "button",
												className: "dshstats-act",
												disabled: busy,
												title: busy ? t("advice.blocked") : undefined,
												onClick: () => run(item)
											},
											t(`advice.${segment}.action`)
										)
								: h("span", { className: "dshstats-manual" }, t(`advice.${segment}.manual`))
					)
				);
			});
			if (dismissed.length > 0) {
				items.push(
					h(
						"button",
						{ key: "restore", type: "button", className: "dshstats-restore", onClick: restore },
						t("advice.restore")
					)
				);
			}
			return h(
				"span",
				{ className: "dshstats-anchor" },
				h(
					"button",
					{
						ref: seat.rootRef,
						type: "button",
						className: `dshstats-pill dshstats-pill-${worst}`,
						"aria-haspopup": "dialog",
						"aria-expanded": seat.open,
						"aria-label": t("advice.title"),
						onClick: () => {
							seat.setOpen(!seat.open);
						}
					},
					h(ADVICE_ICON, null),
					h("span", { className: "dshstats-label" }, t("advice.pill", { count: open.length }))
				),
				panelOf({
					open: seat.open,
					panelRef: seat.panelRef,
					pos: seat.pos,
					icon: h(ADVICE_ICON, null),
					title: t("advice.title"),
					value: t("advice.pill", { count: open.length }),
					ariaLabel: t("advice.title"),
					children: items
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
			ctx.effect(() => ctx.locale.register(NS, { zh: DICT_ZH, en: DICT_EN }), "dsh-cost-audit: dictionaries");
			const t = ctx.locale.bind(NS);
			ctx.slots.inject("conversation.chat.assistant-actions", () =>
				ctx.slots.register({ name: "conversation.chat.assistant-actions", id: "dsh-cost-audit-turn", order: 30, locale: NS }, (props) =>
					h(TurnSlot, { ...props, t: props.t ?? t })
				)
			);
			ctx.slots.inject("conversation.composer.dock", () =>
				ctx.slots.register({ name: "conversation.composer.dock", id: "dsh-cost-audit-session", order: 10, locale: NS }, (props) =>
					h(SessionSlot, { ...props, t: props.t ?? t })
				)
			);
		}

		module.exports = { name: NS, inject: ["slots", "locale"], apply };
		return module.exports;
	}
});
