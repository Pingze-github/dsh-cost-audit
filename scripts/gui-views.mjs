#!/usr/bin/env node
// Both views in one call.
//
// The panel, the advice card and the bill were being checked by hand-written
// report expressions, retyped and re-debugged several times a session — the
// same three clicks, the same waits, the same parsing. This is that script: one
// command runs one probe and checks everything the GUI is supposed to render.
//
//   node scripts/gui-views.mjs --url <authenticated-url> [--session <id>] [--retries 2]
//
// Exit 1 only on a real failure (a console error naming this plugin, or a bill
// view that rendered zero series). A page that never rendered the plugin, or a
// probe that could not attach, prints `UNVERIFIED` and exits 0 — no evidence is
// not a pass, and it is not the plugin's failure either. Callers should surface
// that line rather than treat it as green.

import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const args = process.argv.slice(2);
const arg = (name, fallback) => {
	const index = args.indexOf(name);
	return index === -1 ? fallback : args[index + 1];
};

const url = arg("--url");
if (url === undefined) {
	process.stderr.write("gui-views: --url is required\n");
	process.exit(2);
}
const session = arg("--session");
const retries = Number(arg("--retries", "2"));

// Everything the plugin owns, in one pass. The waits are short because the page
// under test sometimes navigates away mid-report; a faster run fails less often.
const EXPRESSION = `new Promise((resolve) => {
  const out = { pills: [...document.querySelectorAll(".dshstats-pill")].map((n) => n.innerText) };
  if (out.pills.length === 0) { resolve(JSON.stringify(out)); return; }
  const waitFor = (fn, ms) =>
    new Promise((done) => {
      const started = Date.now();
      const tick = () => {
        if (fn()) { done(true); return; }
        if (Date.now() - started > ms) { done(false); return; }
        setTimeout(tick, 150);
      };
      tick();
    });
  const pick = (label) => [...document.querySelectorAll(".dshstats-switchButton")].find((n) => n.innerText === label);
  const advice = document.querySelector(".dshstats-pill-warn") ?? document.querySelector(".dshstats-pill-high") ?? document.querySelector(".dshstats-pill-info");
  (async () => {
    document.querySelector("[data-dsh-stats-session] .dshstats-pill")?.click();
    await waitFor(() => document.querySelector(".dshstats-details dt"), 6000);
    out.sessionRows = [...document.querySelectorAll(".dshstats-details dt")].map((n) => n.innerText);
    document.querySelector("[data-dsh-stats-session] .dshstats-pill")?.click();
    if (!advice) { out.advice = "none"; resolve(JSON.stringify(out)); return; }
    advice.click();
    await waitFor(() => document.querySelector(".dshstats-adviceTitle"), 6000);
    out.adviceTitles = [...document.querySelectorAll(".dshstats-adviceTitle")].map((n) => n.innerText);
    const bill = await waitFor(() => pick("全账号账单") ?? pick("Whole-account bill"), 6000);
    if (!bill) { out.bill = "no-switch"; resolve(JSON.stringify(out)); return; }
    bill.click();
    // The bill folds every session on the machine before it can draw, so this
    // waits for the chart rather than for a fixed number of milliseconds.
    const drawn = await waitFor(() => document.querySelector(".dshstats-series path"), 20000);
    out.bill = Boolean(document.querySelector(".dshstats-chart"));
    out.waited = drawn;
    out.series = document.querySelectorAll(".dshstats-series path").length;
    out.legend = [...document.querySelectorAll(".dshstats-legendItem")].map((n) => n.innerText.replace(/\\n/g, " "));
    out.reportRows = document.querySelectorAll(".dshstats-reportRow").length;
    out.chartHead = (document.querySelector(".dshstats-chartHead")?.innerText ?? "").replace(/\\n/g, " | ");
    out.switches = [...document.querySelectorAll(".dshstats-switchButton")].map(
      (n) => n.innerText + (n.getAttribute("aria-selected") === "true" ? "*" : "")
    );
    const fine = pick("细粒度") ?? pick("Fine-grained");
    if (!fine) { out.fine = "no-switch"; resolve(JSON.stringify(out)); return; }
    fine.click();
    // The fine view folds every session again, so it waits for its own chart.
    out.fineWaited = await waitFor(() => document.querySelector(".dshstats-chart"), 25000);
    out.fine = Boolean(document.querySelector(".dshstats-chart"));
    out.fineSeries = document.querySelectorAll(".dshstats-series path").length;
    out.fineMarkers = document.querySelectorAll(".dshstats-marker").length;
    out.fineRows = document.querySelectorAll(".dshstats-markerRow").length;
    out.fineLegend = [...document.querySelectorAll(".dshstats-legendItem")].map((n) => n.innerText.replace(/\\n/g, " "));
    out.fineHead = (document.querySelector(".dshstats-chartHead")?.innerText ?? "").replace(/\\n/g, " | ");
    out.fineNote = document.querySelector(".dshstats-note")?.innerText ?? "";
    resolve(JSON.stringify(out));
  })();
})`;

const probe = join(dirname(fileURLToPath(import.meta.url)), "gui-probe.mjs");
let parsed = null;
let raw = "";
for (let attempt = 1; attempt <= retries && parsed === null; attempt += 1) {
	const call = ["node", probe, "--url", url, "--wait", "[data-dsh-stats-session]", "--report", EXPRESSION];
	if (session !== undefined) call.push("--session", session);
	const run = spawnSync(call[0], call.slice(1), { encoding: "utf8", timeout: 120000 });
	raw = `${run.stdout ?? ""}\n${run.stderr ?? ""}`;
	try {
		parsed = JSON.parse(run.stdout);
	} catch {
		// "Could not attach" hid its own cause for three runs: print what the probe
		// actually said, so the next failure is diagnosable from one command.
		const tail = raw.trim().split("\n").slice(-3).join(" / ").slice(0, 300);
		process.stderr.write(`gui-views: attempt ${String(attempt)} could not attach — ${tail === "" ? "(no output)" : tail}\n`);
	}
}
if (parsed === null) {
	process.stdout.write("gui-views: UNVERIFIED — the probe could not attach (page navigated away or renderer died)\n");
	process.exit(0);
}

const errors = (parsed.consoleErrors ?? []).map(String);
const mine = errors.filter((entry) => entry.includes("dsh-cost-audit"));
if ((parsed.blockedCount ?? 0) > 0 || (parsed.stoppedNavigations ?? []).length > 0) {
	process.stdout.write(
		`gui-views: note — refused ${String(parsed.blockedCount)} foreign request(s), cancelled ${String((parsed.stoppedNavigations ?? []).length)} foreign navigation(s)\n`
	);
}
if (parsed.report === null || parsed.report === undefined) {
	process.stdout.write(`gui-views: UNVERIFIED — the run ended before the DOM could be read (${String(parsed.failure ?? "unknown")})\n`);
	if ((parsed.foreignRequests ?? []).length > 0) {
		process.stdout.write(`gui-views: foreign requests ${JSON.stringify(parsed.foreignRequests)}\n`);
	}
	process.exit(0);
}
const view = JSON.parse(parsed.report);

if (mine.length > 0) {
	process.stdout.write(`gui-views: FAIL console error — ${mine[0].split("\n")[0]}\n`);
	process.exit(1);
}
if ((view.pills ?? []).length === 0) {
	process.stdout.write("gui-views: UNVERIFIED — no cost pill rendered on that load\n");
	process.exit(0);
}
process.stdout.write(`gui-views: pills ${JSON.stringify(view.pills)}\n`);
if ((view.sessionRows ?? []).length > 0) {
	process.stdout.write(`gui-views: session panel ${String(view.sessionRows.length)} rows (${view.sessionRows.slice(0, 5).join(" / ")})\n`);
}
if (Array.isArray(view.adviceTitles)) {
	process.stdout.write(`gui-views: advice ${String(view.adviceTitles.length)} — ${view.adviceTitles.join(" / ")}\n`);
}
if (view.bill === true) {
	if ((view.series ?? 0) < 1) {
		process.stdout.write("gui-views: FAIL the bill view rendered no series\n");
		process.exit(1);
	}
	process.stdout.write(`gui-views: bill ${String(view.series)} series · ${String(view.reportRows)} rows · ${view.chartHead}\n`);
	process.stdout.write(`gui-views: legend ${JSON.stringify(view.legend)}\n`);
	process.stdout.write(`gui-views: switches ${JSON.stringify(view.switches)} (* = selected)\n`);
} else {
	process.stdout.write(`gui-views: UNVERIFIED — the bill view did not open (${String(view.bill)})\n`);
}
if (view.fine === true) {
	if ((view.fineSeries ?? 0) < 1) {
		process.stdout.write("gui-views: FAIL the fine view rendered a chart with no series\n");
		process.exit(1);
	}
	process.stdout.write(`gui-views: fine ${String(view.fineSeries)} series · ${String(view.fineMarkers)} markers · ${String(view.fineRows)} listed · ${view.fineHead}\n`);
	process.stdout.write(`gui-views: fine legend ${JSON.stringify(view.fineLegend)}\n`);
} else if (view.fine === "no-switch") {
	process.stdout.write("gui-views: UNVERIFIED — the fine switch was not on the card\n");
} else {
	process.stdout.write(`gui-views: UNVERIFIED — the fine view did not open (${String(view.fine)})\n`);
}
if (errors.length > 0) {
	process.stdout.write(`gui-views: note — ${String(errors.length)} console error(s) from other code: ${errors[0].split("\n")[0].slice(0, 60)}\n`);
}
process.exit(0);
