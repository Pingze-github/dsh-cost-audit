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
        // Resolve the matched value, not true: the bill step needs the switch
        // element itself. Returning a boolean made bill.click() throw inside
        // the async walk, whose rejection the outer Promise never settles —
        // which surfaced only as "Runtime.evaluate did not answer".
        const value = fn();
        if (value) { done(value); return; }
        if (Date.now() - started > ms) { done(false); return; }
        setTimeout(tick, 150);
      };
      tick();
    });
  // Switches are identified by their untranslated key, not their label. The
  // labels follow the UI language, so a text match works in Chinese and silently
  // reports "no switch" in English — which is exactly how a healthy view read as
  // unverified once the probe got a fresh browser profile with en-US defaults.
  const view = (key) => document.querySelector('[data-dsh-stats-view="' + key + '"]');
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
    const bill = await waitFor(() => view("bill"), 6000);
    if (!bill) { out.bill = "no-switch"; resolve(JSON.stringify(out)); return; }
    bill.click();
    // The bill folds every session on the machine before it can draw, so this
    // waits for the chart rather than for a fixed number of milliseconds. The
    // fold is cold once per cache window and grows with the session count: 63 s
    // for 168 sessions here, and 10 s warm. Shorter waits have twice reported a
    // healthy view as "did not open".
    const drawn = await waitFor(() => document.querySelector(".dshstats-series path"), 120000);
    out.bill = Boolean(document.querySelector(".dshstats-chart"));
    out.waited = Boolean(drawn);
    out.series = document.querySelectorAll(".dshstats-series path").length;
    out.legend = [...document.querySelectorAll(".dshstats-legendItem")].map((n) => n.innerText.replace(/\\n/g, " "));
    out.reportRows = document.querySelectorAll(".dshstats-reportRow").length;
    out.chartHead = (document.querySelector(".dshstats-chartHead")?.innerText ?? "").replace(/\\n/g, " | ");
    // The card's own view switch marks itself with aria-pressed; the tabs
    // inside use aria-selected. Read both or the selected view loses its star.
    out.switches = [...document.querySelectorAll(".dshstats-switchButton")].map(
      (n) => n.innerText + ((n.getAttribute("aria-selected") ?? n.getAttribute("aria-pressed")) === "true" ? "*" : "")
    );
    const fine = view("fine");
    if (!fine) { out.fine = "no-switch"; resolve(JSON.stringify(out)); return; }
    fine.click();
    // Switching views unmounts the bill chart; the fine view then folds every
    // session again. Requiring the chart to disappear first is what separates
    // "the switch did not take" from "the fold is still running" — polling for
    // any chart matched the bill's own chart and hid the difference.
    await new Promise((done) => setTimeout(done, 600));
    out.fineSwitched = document.querySelector(".dshstats-chart") === null;
    // Boolean, not the element: waitFor resolves what matched, and an element in
    // this object made JSON.stringify throw inside both the resolve below and the
    // catch that was meant to report it. The promise then never settled, and the
    // only symptom was "Runtime.evaluate did not answer" — with a circular-JSON
    // console error as the sole clue.
    out.fineWaited = Boolean(await waitFor(() => document.querySelector(".dshstats-series path"), 120000));
    out.fine = out.fineSwitched === true && Boolean(document.querySelector(".dshstats-chart"));
    out.fineSeries = document.querySelectorAll(".dshstats-series path").length;
    out.fineMarkers = document.querySelectorAll(".dshstats-marker").length;
    out.fineRows = document.querySelectorAll(".dshstats-markerRow").length;
    out.fineLegend = [...document.querySelectorAll(".dshstats-legendItem")].map((n) => n.innerText.replace(/\\n/g, " "));
    out.fineHead = (document.querySelector(".dshstats-chartHead")?.innerText ?? "").replace(/\\n/g, " | ");
    out.fineNote = document.querySelector(".dshstats-note")?.innerText ?? "";
    resolve(JSON.stringify(out));
  })().catch((error) => {
    // Never stringify the collected object here: the failure it is reporting may
    // be exactly that object refusing to serialise, and a throw inside this
    // handler leaves the promise unsettled all over again.
    resolve(JSON.stringify({ error: String((error && error.stack) || error) }));
  });
  // A promise that never settles reads as "Runtime.evaluate did not answer",
  // which hides the cause. Settle with what was collected instead.
  setTimeout(() => resolve(JSON.stringify({ timedOut: true })), 260000);
})`;

const probe = join(dirname(fileURLToPath(import.meta.url)), "gui-probe.mjs");
let parsed = null;
let raw = "";
for (let attempt = 1; attempt <= retries && parsed === null; attempt += 1) {
	const call = ["node", probe, "--url", url, "--wait", "[data-dsh-stats-session]", "--report", EXPRESSION];
	if (session !== undefined) call.push("--session", session);
	const run = spawnSync(call[0], call.slice(1), { encoding: "utf8", timeout: 340000 });
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
// The harness names the slot that crashed, not the plugin that registered it,
// so a `slot entry crashed` in one of the two slots this client mounts is
// treated as ours: the alternative is reporting "no pill" (UNVERIFIED, exit 0)
// for a render failure that is exactly what this check exists to catch.
const OUR_SLOTS = ["conversation.composer.dock", "conversation.chat.assistant-actions"];
// Attribute on what the error says, never on its stack. Every client module is
// loaded through one `plugins/??a,b,c` URL, so that URL names this plugin and
// appears in *every* frame — including a sidebar failure that merely fired while
// the probe was switching sessions. Matching the raw entry failed the gate for
// another package's error ("Session reference … is released"). Our own log lines
// are prefixed `dsh-cost-audit`, and a render crash is named by its slot; those
// two are the honest signals.
const mine = errors.filter((entry) => {
	const message = entry.split("\n")[0];
	if (message.includes("dsh-cost-audit")) return true;
	return message.includes("slot entry crashed") && OUR_SLOTS.some((slot) => message.includes(slot));
});
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

if (view.error !== undefined) {
	process.stdout.write(`gui-views: FAIL the view walk threw — ${String(view.error).split("\n")[0]}\n`);
	process.exit(1);
}
if (view.timedOut === true) {
	process.stdout.write("gui-views: UNVERIFIED — the view walk did not settle in 260 s\n");
	process.exit(0);
}

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
if (view.advice === "none") {
	// The advice card is the door to both charts, so a session with no tips has
	// none to check. Say that once, rather than printing two fold-speed excuses.
	process.stdout.write("gui-views: UNVERIFIED — this session has no advice tips, so the bill and fine views were not reached\n");
	process.exit(0);
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
	process.stdout.write(`gui-views: UNVERIFIED — the bill did not draw within 120 s (the fold is the slow part, and it is cold here) (${String(view.bill)})\n`);
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
	if (view.fineSwitched === false) {
		process.stdout.write("gui-views: FAIL the fine switch did not change the panel's view\n");
		process.exit(1);
	}
	process.stdout.write(`gui-views: UNVERIFIED — the fine view did not draw within 120 s; it folds every session too (${String(view.fine)})\n`);
}
if (errors.length > 0) {
	process.stdout.write(`gui-views: note — ${String(errors.length)} console error(s) from other code: ${errors[0].split("\n")[0].slice(0, 60)}\n`);
}
process.exit(0);
