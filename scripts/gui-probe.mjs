/**
 * Render the live Web GUI in headless Chromium and report what actually
 * reached the DOM.
 *
 * The bundled Debian Chromium predates the `Iterator` global the harness's
 * document-preview bundle touches at module scope, so the probe installs a
 * one-line polyfill before any page script runs. Everything else is the real
 * app: same server, same plugin graph, same client bundles.
 *
 * Usage:
 *   node scripts/gui-probe.mjs --url <authenticated-url> --out <shot.png>
 *                              [--wait <selector>] [--click <selector>]
 *                              [--session <id>] [--timeout <ms>]
 *                              [--seed '<key>=<json>'] [--profile <dir>]
 *                              [--report '<js expression>']
 *
 * @module dsh-stats/scripts/gui-probe
 */

import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
import { setTimeout as delay } from "node:timers/promises";

const argv = process.argv.slice(2);
const arg = (flag, fallback) => {
	const index = argv.indexOf(flag);
	return index === -1 ? fallback : argv[index + 1];
};

const url = arg("--url");
const out = arg("--out");
const waitFor = arg("--wait");
const sessionId = arg("--session");
const click = arg("--click");
const timeoutMs = Number(arg("--timeout", "45000"));
const port = Number(arg("--port", "9333"));
const profileDir = arg("--profile", `/tmp/dsh-stats-probe-${process.pid}`);
const seedPair = arg("--seed");
const reportExpr = arg(	"--report",
	`JSON.stringify({
		bootFailure: document.body.innerText.includes("Failed to load plugins"),
		sessionStats: [...document.querySelectorAll("[data-composer-stats]")].map((n) => n.innerText),
		sessionRows: [...document.querySelectorAll("[data-dsh-stats-session]")].map((n) => n.innerText),
		panels: [...document.querySelectorAll(".dshstats-panel")].map((n) => n.innerText),
		turnPills: [...document.querySelectorAll("[data-dsh-stats-turn]")].map((n) => n.getAttribute("data-dsh-stats-turn") + "|" + n.innerText),
		officialTurnUsage: document.querySelectorAll("[data-turn-usage-details]").length
	})`
);

if (url === undefined) {
	process.stderr.write("gui-probe: --url is required\n");
	process.exit(2);
}

/** The harness bundle touches `Iterator.prototype` at module scope. */
const POLYFILL = "globalThis.Iterator = globalThis.Iterator || function Iterator() {}; Iterator.prototype = Object.getPrototypeOf(Object.getPrototypeOf([][Symbol.iterator]()));";

let chromium = spawn(
	"chromium",
	[
		"--headless",
		"--no-sandbox",
		"--disable-gpu",
		"--hide-scrollbars",
		"--disable-dev-shm-usage",
		`--user-data-dir=${profileDir}`,
		`--remote-debugging-port=${port}`,
		`--window-size=${arg("--size", "1500,1400")}`,
		"about:blank"
	],
	{ stdio: ["ignore", "ignore", "ignore"] }
);

let socket;
let nextId = 1;
const pending = new Map();
const consoleErrors = [];

function send(method, params = {}) {
	const id = nextId++;
	socket.send(JSON.stringify({ id, method, params }));
	return new Promise((resolve, reject) => {
		pending.set(id, { resolve, reject });
	});
}

async function connect(deadline) {
	while (Date.now() < deadline) {
		try {
			const answer = await fetch(`http://127.0.0.1:${port}/json/list`);
			const targets = await answer.json();
			const page = targets.find((target) => target.type === "page");
			if (page !== undefined) return page.webSocketDebuggerUrl;
		} catch {}
		await delay(200);
	}
	throw new Error("gui-probe: chromium never exposed a page target");
}

async function evaluate(expression) {
	const result = await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
	if (result.exceptionDetails !== undefined) throw new Error(`gui-probe: evaluate failed: ${result.exceptionDetails.text}`);
	return result.result?.value;
}

async function main() {
	const deadline = Date.now() + timeoutMs;
	const wsUrl = await connect(deadline);
	socket = new WebSocket(wsUrl);
	await new Promise((resolve, reject) => {
		socket.addEventListener("open", resolve, { once: true });
		socket.addEventListener("error", () => reject(new Error("gui-probe: websocket failed")), { once: true });
	});
	socket.addEventListener("message", (event) => {
		const message = JSON.parse(event.data);
		if (message.id !== undefined) {
			const seat = pending.get(message.id);
			pending.delete(message.id);
			if (message.error !== undefined) seat?.reject(new Error(`gui-probe: ${message.error.message}`));
			else seat?.resolve(message.result ?? {});
			return;
		}
		if (message.method === "Runtime.exceptionThrown") {
			consoleErrors.push(message.params.exceptionDetails?.exception?.description ?? message.params.exceptionDetails?.text ?? "exception");
		}
		if (message.method === "Runtime.consoleAPICalled" && message.params.type === "error") {
			consoleErrors.push(message.params.args.map((a) => a.value ?? a.description ?? "").join(" "));
		}
	});

	await send("Page.enable");
	await send("Runtime.enable");
	await send("Page.addScriptToEvaluateOnNewDocument", { source: POLYFILL });
	if (sessionId !== undefined) {
		const seed = `try { localStorage.setItem("dsh.sessions.current", JSON.stringify({ sessionId: ${JSON.stringify(sessionId)} })); } catch {}`;
		await send("Page.addScriptToEvaluateOnNewDocument", { source: seed });
	}
	if (seedPair !== undefined) {
		// A storage seed installed before any page script runs. This is the only
		// reliable way to test mount-time reads: writing storage from a report
		// races the component that already read it.
		const split = seedPair.indexOf("=");
		const key = seedPair.slice(0, split);
		const value = seedPair.slice(split + 1);
		const source = `try { localStorage.setItem(${JSON.stringify(key)}, ${JSON.stringify(value)}); } catch {}`;
		await send("Page.addScriptToEvaluateOnNewDocument", { source });
	}
	await send("Page.navigate", { url });

	if (waitFor !== undefined) {
		while (Date.now() < deadline) {
			try {
				if (await evaluate(`!!document.querySelector(${JSON.stringify(waitFor)})`)) break;
			} catch {}
			await delay(300);
		}
	} else {
		await delay(6000);
	}
	if (click !== undefined) {
		await evaluate(`document.querySelector(${JSON.stringify(click)})?.click()`);
		await delay(1200);
	}
	// Let the last paint settle before capturing.
	await delay(1200);

	const report = await evaluate(`(() => (${reportExpr}))()`);
	const shot = await send("Page.captureScreenshot", { format: "png", captureBeyondViewport: true });
	if (out !== undefined) writeFileSync(out, Buffer.from(shot.data, "base64"));

	process.stdout.write(`${JSON.stringify({ report, consoleErrors }, null, 1)}\n`);
}

main()
	.catch((error) => {
		process.stderr.write(`${String(error?.stack ?? error)}\n`);
		process.exitCode = 1;
	})
	.finally(() => {
		try {
			socket?.close();
		} catch {}
		chromium.kill("SIGKILL");
	});
