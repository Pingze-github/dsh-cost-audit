#!/usr/bin/env bash
# dsh-cost-audit — the runtime verification, in one call.
#
# `check.sh` is the static gate: it parses both halves and runs the host suite on
# synthetic events. This script asks the *running* harness instead, and sweeps
# every session on the machine for invariants that must hold whatever the log
# contains. One invocation, one process — the plugin's own "fragmented calls"
# advice is about this script's raison d'être.
#
#   bash scripts/smoke.sh          gate + live invariants
#   bash scripts/smoke.sh --gui    …and render the panel in headless Chromium
#
# Exits non-zero on the first failed invariant.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

# This deployment's layout, derived rather than welded to one box: another
# install has a different DSH home and a workspace directory named after its own
# checkout path. All three are overridable for when the derivation is wrong.
DSH_HOME="${DSH_HOME:-/root/.dsh}"
SESSIONS_ROOT="${DSH_STATS_SESSIONS:-$DSH_HOME/sessions}"
WORKSPACE_DEFAULT="--$(printf '%s' "${ROOT#/}" | tr '/' '-')--"
WORKSPACE_DIR="${DSH_STATS_WORKSPACE:-$WORKSPACE_DEFAULT}"
# The loader entry id is the package name; derive it so a rename cannot desync.
PLUGIN_ID="$(python3 -c 'import json;print(json.load(open("package.json"))["name"])')"

BASE="http://127.0.0.1:3080"
JAR="${TMPDIR:-/tmp}/dsh-cost-audit-smoke.cookies"
GUI=0
[ "${1:-}" = "--gui" ] && GUI=1

# The GUI is token-authenticated; the token is printed once at boot.
TOKEN_URL="${DSH_STATS_URL:-$(grep -o 'http://127.0.0.1:3080/?token=[A-Za-z0-9_-]*' /var/log/dsh-web.log 2>/dev/null | tail -1 || true)}"
if [ -z "$TOKEN_URL" ]; then
  echo "smoke: no authenticated URL — set DSH_STATS_URL" >&2
  exit 2
fi
curl -s -o /dev/null -c "$JAR" "$TOKEN_URL"
AUTH=(-b "$JAR" -H 'Origin: http://127.0.0.1:3080')

echo "smoke: static gate"
bash scripts/check.sh

echo "smoke: plugin phase ($PLUGIN_ID)"
PHASE=$(curl -s "${AUTH[@]}" "$BASE/_dsh/hotswap/state" | PLUGIN_ID="$PLUGIN_ID" python3 -c '
import json, os, sys
target = os.environ["PLUGIN_ID"]
entries = json.load(sys.stdin)["value"]["entries"]
hit = [e for e in entries if e["id"] == target]
print(hit[0]["phase"] if hit else "missing")
')
if [ "$PHASE" != "active" ]; then
  echo "smoke: $PLUGIN_ID phase is '$PHASE', expected 'active'" >&2
  exit 1
fi

echo "smoke: live invariants over every session"
SESSIONS=()
for dir in "$SESSIONS_ROOT"/*/session-*/; do
  [ -d "$dir" ] || continue
  SESSIONS+=("$(basename "$dir")")
done

# The whole sweep is one python process: a curl per session, every assertion in
# the same place, and a single non-zero exit if any of them fails.
DSH_STATS_BASE="$BASE" DSH_STATS_JAR="$JAR" PLUGIN_ID="$PLUGIN_ID" python3 - "${SESSIONS[@]}" <<'PY'
import json, os, subprocess, sys

base = os.environ["DSH_STATS_BASE"]
jar = os.environ["DSH_STATS_JAR"]
plugin = os.environ["PLUGIN_ID"]
sessions = sys.argv[1:]
balance_url = f"{base}/api/{plugin}.balance"
report_url = f"{base}/api/{plugin}.report"

CODES = {
    "context-reread", "fragmented-tools", "repeated-target", "compaction-churn",
    "tool-failures", "model-retries", "idle-grinding", "cache-hit-drop", "balance-low",
}
SEVERITIES = {"high", "warn", "info"}
failures = []
folded = 0
biggest = 0

def check(condition, session, message):
    if not condition:
        failures.append(f"{session}: {message}")

for session in sessions:
    raw = subprocess.run(
        ["curl", "-s", "-b", jar, "-X", "POST",
         "-H", "content-type: application/json", "-H", "Origin: http://127.0.0.1:3080",
         "-d", json.dumps({"sessionId": session}), balance_url],
        capture_output=True, text=True,
    ).stdout
    try:
        payload = json.loads(raw)
    except json.JSONDecodeError:
        failures.append(f"{session}: route returned non-JSON")
        continue
    if not payload.get("ok"):
        continue  # sessions the harness itself will not resolve are not our fault
    folded += 1
    stats = payload["stats"]
    compaction = stats["compaction"]
    total = stats["total"]["costNano"]
    count, manual = compaction["count"], compaction["manual"]
    manual_cost = compaction["manualCostNano"]
    automatic = count - manual
    automatic_cost = compaction["summaryCostNano"] - manual_cost

    check(manual <= count, session, f"manual {manual} > count {count}")
    check(manual_cost <= compaction["summaryCostNano"], session, "manual cost exceeds total summary cost")
    check(manual_cost >= 0 and automatic_cost >= 0, session, "negative cost split")
    check(compaction["summaryCostNano"] <= total, session, "summary cost exceeds session cost")

    # Every day is a bucket with two independent splits, and each has to add up
    # to the same total — otherwise the report's "why did it move" is
    # arithmetic that does not close.
    day_total = 0
    biggest = max(biggest, total)
    for day_key, day in stats["days"].items():
        token_axis = day["cacheReadCostNano"] + day["uncachedCostNano"] + day["outputCostNano"]
        tariff_axis = day["peakCostNano"] + day["offPeakCostNano"]
        check(token_axis == day["costNano"], session, f"{day_key}: token split {token_axis} != day total {day['costNano']}")
        check(tariff_axis == day["costNano"], session, f"{day_key}: tariff split {tariff_axis} != day total {day['costNano']}")
        check(day["compactionCostNano"] <= day["costNano"], session, f"{day_key}: compaction cost exceeds the day total")
        day_total += day["costNano"]
    check(day_total <= total, session, f"the kept days ({day_total}) sum to more than the session ({total})")

    codes = [item["code"] for item in stats["advice"]]
    for item in stats["advice"]:
        check(item["code"] in CODES, session, f"unknown advice code {item['code']}")
        check(item["severity"] in SEVERITIES, session, f"unknown severity {item['severity']}")

    # The rule this project already got wrong once: a compaction the user ran on
    # our own advice is not churn, and neither is one automatic compaction.
    share = 0 if total == 0 else automatic_cost / total
    expected = automatic >= 3 or share >= 0.1
    check(("compaction-churn" in codes) == expected, session,
          f"churn tip {'missing' if expected else 'present'} at {automatic} automatic compaction(s), share {share:.1%}")
    if "compaction-churn" in codes:
        values = next(item for item in stats["advice"] if item["code"] == "compaction-churn")["values"]
        check(values["automatic"] == automatic, session, f"tip says {values['automatic']} automatic, fold says {automatic}")
        check(values["manual"] == manual, session, f"tip says {values['manual']} manual, fold says {manual}")

# The account-wide report has to be the merge of what we just folded. It is the
# figure that answers "am I spending less than I used to", so both splits have to
# close on it exactly as they do per session.
raw = subprocess.run(
    ["curl", "-s", "-b", jar, "-X", "POST",
     "-H", "content-type: application/json", "-H", "Origin: http://127.0.0.1:3080",
     "-d", "{}", report_url],
    capture_output=True, text=True,
).stdout
try:
    report = json.loads(raw)
except json.JSONDecodeError:
    report = {}
check(report.get("ok") is True, "account", "the report route did not answer ok")
report_days = report.get("days", {})
check(len(report_days) > 0, "account", "the report carries no days")
report_total = 0
for key, day in sorted(report_days.items()):
    token_axis = day["cacheReadCostNano"] + day["uncachedCostNano"] + day["outputCostNano"]
    tariff_axis = day["peakCostNano"] + day["offPeakCostNano"]
    check(token_axis == day["costNano"], "account", f"{key}: report token split {token_axis} != {day['costNano']}")
    check(tariff_axis == day["costNano"], "account", f"{key}: report tariff split {tariff_axis} != {day['costNano']}")
    report_total += day["costNano"]
check(report.get("sessions", 0) >= 1, "account", "the report folded no sessions")
check(report_total >= biggest, "account", f"the report ({report_total}) is less than the largest session ({biggest})")
check(len(report_days) <= 90, "account", "the report keeps more than 90 days")

print(f"smoke: folded {folded} of {len(sessions)} session(s)")
print(f"smoke: report merged {report.get('sessions')} session(s), {len(report_days)} day(s), {report_total / 1e9:.2f} CNY")
if failures:
    for line in failures:
        print(f"smoke: FAIL {line}", file=sys.stderr)
    sys.exit(1)
PY

if [ "$GUI" = "1" ]; then
  echo "smoke: rendering the panel"
  # The most recently written session in this workspace is the one a human is
  # actually looking at; a fresh session renders the hero and no dock at all.
  SESSION="${DSH_STATS_SESSION:-$(ls -t "$SESSIONS_ROOT/$WORKSPACE_DIR"/session-*/session.v3.jsonl.zstd 2>/dev/null | head -1 | xargs -r dirname | xargs -r basename)}"
  [ -z "$SESSION" ] && { echo "smoke: no session in this workspace to render" >&2; exit 1; }
  echo "smoke: session $SESSION"
  # Both views, not just the dock. A view that throws is caught by the slot
  # boundary, so the card simply vanishes and nothing else notices — the bill
  # view died exactly that way once, off the back of a chart change, and the
  # only thing that saw it was this probe's console-error list.
  GUI_REPORT="${TMPDIR:-/tmp}/dsh-cost-audit-gui.json"
  node scripts/gui-probe.mjs --url "$TOKEN_URL" --session "$SESSION" \
    --wait "[data-dsh-stats-session]" \
    --report 'new Promise((r) => {
      const done = (extra) =>
        r(JSON.stringify(Object.assign({
          pills: [...document.querySelectorAll(".dshstats-pill")].map((n) => n.innerText),
          bootFailure: document.body.innerText.includes("Failed to load plugins")
        }, extra)));
      const pill =
        document.querySelector(".dshstats-pill-warn") ??
        document.querySelector(".dshstats-pill-high") ??
        document.querySelector(".dshstats-pill-info");
      if (!pill) { done({ bill: "no-advice-pill" }); return; }
      pill.click();
      const pick = (label) => [...document.querySelectorAll(".dshstats-switchButton")].find((n) => n.innerText === label);
      const t0 = Date.now();
      const step = () => {
        const bill = pick("Whole-account bill");
        if (!bill) { if (Date.now() - t0 > 15000) { done({ bill: "no-switch" }); return; } setTimeout(step, 200); return; }
        bill.click();
        setTimeout(() => {
          const thirty = pick("30 days");
          if (thirty) thirty.click();
          setTimeout(() => done({
            bill: Boolean(document.querySelector(".dshstats-chart")),
            series: document.querySelectorAll(".dshstats-series").length,
            legend: document.querySelectorAll(".dshstats-legendItem").length
          }), 900);
        }, 3000);
      };
      step();
    })' > "$GUI_REPORT"
  DSH_STATS_GUI_REPORT="$GUI_REPORT" python3 - <<'PY2'
import json, os, re, sys

raw = open(os.environ["DSH_STATS_GUI_REPORT"]).read()
try:
    parsed = json.loads(raw)
except json.JSONDecodeError:
    match = re.search(r'\{\s*"report":\s*"(.*?)",\s*"consoleErrors":\s*(\[.*\])\s*\}\s*$', raw, re.S)
    if match is None:
        print("smoke: FAIL the gui probe produced no report", file=sys.stderr)
        print(raw[-400:], file=sys.stderr)
        sys.exit(1)
    parsed = {"report": json.loads('"' + match.group(1) + '"'), "consoleErrors": json.loads(match.group(2))}

errors = parsed.get("consoleErrors") or []
if errors:
    print("smoke: FAIL console error: %s" % str(errors[0]).split("\n")[0], file=sys.stderr)
    sys.exit(1)
report = json.loads(parsed["report"])
if report.get("bootFailure"):
    print("smoke: FAIL the plugin list did not boot", file=sys.stderr)
    sys.exit(1)
if report.get("bill") is True and report.get("series", 0) < 1:
    print("smoke: FAIL the bill view rendered no series", file=sys.stderr)
    sys.exit(1)
print("smoke: pills %s · bill %s · series %s · legend %s" % (report.get("pills"), report.get("bill"), report.get("series"), report.get("legend")))
PY2
fi

echo "smoke: all green"
