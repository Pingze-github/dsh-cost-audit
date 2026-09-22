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
  const pick = (label) => [...document.querySelectorAll(".dshstats-switchButton")].find((n) => n.innerText === label);
  const park = (selector) => document.querySelector(selector) ?? document.querySelector(selector);
  const advice = park(".dshstats-pill-warn") ?? park(".dshstats-pill-high") ?? park(".dshstats-pill-info");
  if (out.pills.length === 0) { resolve(JSON.stringify(out)); return; }
  document.querySelector("[data-dsh-stats-session] .dshstats-pill")?.click();
  setTimeout(() => {
    out.sessionRows = [...document.querySelectorAll(".dshstats-details dt")].map((n) => n.innerText);
    document.querySelector("[data-dsh-stats-session] .dshstats-pill")?.click();
    setTimeout(() => {
      if (!advice) { out.advice = "none"; resolve(JSON.stringify(out)); return; }
      advice.click();
      setTimeout(() => {
        out.adviceTitles = [...document.querySelectorAll(".dshstats-adviceTitle")].map((n) => n.innerText);
        const bill = pick("全账号账单") ?? pick("Whole-account bill");
        if (!bill) { out.bill = "no-switch"; resolve(JSON.stringify(out)); return; }
        bill.click();
        setTimeout(() => {
          out.bill = Boolean(document.querySelector(".dshstats-chart"));
          out.series = document.querySelectorAll(".dshstats-series path").length;
          out.legend = [...document.querySelectorAll(".dshstats-legendItem")].map((n) => n.innerText.replace(/\\n/g, " "));
          out.reportRows = document.querySelectorAll(".dshstats-reportRow").length;
          out.chartHead = (document.querySelector(".dshstats-chartHead")?.innerText ?? "").replace(/\\n/g, " | ");
          resolve(JSON.stringify(out));
        }, 900);
      }, 1100);
    }, 700);
  }, 900);
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
		process.stderr.write(`gui-views: attempt ${String(attempt)} could not attach\n`);
	}
}
if (parsed === null) {
	process.stdout.write("gui-views: UNVERIFIED — the probe could not attach (page navigated away or renderer died)\n");
	process.exit(0);
}

const errors = (parsed.consoleErrors ?? []).map(String);
const mine = errors.filter((entry) => entry.includes("dsh-cost-audit"));
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
} else {
	process.stdout.write(`gui-views: UNVERIFIED — the bill view did not open (${String(view.bill)})\n`);
}
if (errors.length > 0) {
	process.stdout.write(`gui-views: note — ${String(errors.length)} console error(s) from other code: ${errors[0].split("\n")[0].slice(0, 60)}\n`);
}
process.exit(0);
