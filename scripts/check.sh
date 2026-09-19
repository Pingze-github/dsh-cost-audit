#!/usr/bin/env bash
# dsh-cost-audit — the project's single success criterion.
#
# Exits non-zero on any failure. Run it before every release/install.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

if [ ! -d node_modules ]; then
  bash scripts/link-deps.sh
fi

echo "check: parsing host half"
node --check index.js

echo "check: parsing client half"
node --check client.js

echo "check: host-half behaviour"
node scripts/check.mjs

echo "check: bundle wiring"
node - <<'NODE'
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";

const pkg = JSON.parse(readFileSync("package.json", "utf8"));
assert.ok(/^dsh-[a-z0-9-]+$/.test(pkg.name), `package name is a dsh-* id (${pkg.name})`);
assert.equal(pkg.dsh?.bundle?.patch, "./cordis.patch.yml", "declares a bundle patch");
assert.equal(pkg.dsh?.client?.platform, "web", "declares a web client half");
assert.ok(existsSync(pkg.dsh.bundle.patch), "bundle patch file exists");
assert.ok(existsSync("client.js"), "client half exists");

// The entry id, the module specifier and the client bundle id are the same
// string in three different files. Derive the expectation from package.json
// rather than repeating it, so a rename cannot leave one of them behind.
const patch = readFileSync(pkg.dsh.bundle.patch, "utf8");
assert.match(patch, new RegExp(`id:\\s*${pkg.name}\\b`), `patch mounts the ${pkg.name} entry`);
assert.match(patch, new RegExp(`name:\\s*['"]?${pkg.name}['"]?`), `patch names the ${pkg.name} package`);

const client = readFileSync("client.js", "utf8");
assert.match(client, /window\.__ModuleLoader__\.load\(/, "client is a bootstrap-facade bundle");
assert.match(client, new RegExp(`id:\\s*"${pkg.name}"`), "client bundle id matches the package name");
assert.match(client, /conversation\.chat\.assistant-actions/, "registers the per-turn slot");
assert.match(client, /conversation\.composer\.dock/, "registers the session slot");

process.stdout.write("check: bundle wiring OK\n");

// Every label the client asks for must exist in BOTH shipped locales, and the
// two dictionaries must carry exactly the same keys — a missing key renders a
// raw "turn.cacheHit" in the panel.
const dictKeys = (name) => {
  const start = client.indexOf(`const ${name} = {`);
  assert.ok(start > 0, `${name} is declared`);
  const end = client.indexOf("\n\t\t};", start);
  const body = client.slice(start, end);
  return new Set([...body.matchAll(/"([a-zA-Z][\w.]*)":/g)].map((match) => match[1]));
};
const zh = dictKeys("DICT_ZH");
const en = dictKeys("DICT_EN");
assert.ok(zh.size > 20, `the zh dictionary is populated (${String(zh.size)} keys)`);
assert.deepEqual([...zh].sort(), [...en].sort(), "zh and en carry the same keys");

const asked = new Set([...client.matchAll(/\bt\("([a-zA-Z][\w.]*)"/g)].map((match) => match[1]));
for (const prefix of ["turn", "session"]) {
  for (const match of client.matchAll(new RegExp(`\\$\\{prefix\\}\\.([a-zA-Z]+)`, "g"))) asked.add(`${prefix}.${match[1]}`);
}
const missing = [...asked].filter((key) => !zh.has(key));
assert.deepEqual(missing, [], "every requested label is translated");

// Advice wording is reached through a code → key-segment table, so it needs
// its own completeness check: every code must have a title and a body in both
// locales, or the panel renders a raw key.
const adviceStart = client.indexOf("const ADVICE_KEYS = {");
assert.ok(adviceStart > 0, "the advice key table is declared");
const adviceTable = client.slice(adviceStart, client.indexOf("};", adviceStart));
const adviceCodes = [...adviceTable.matchAll(/"([a-z-]+)":\s*"([a-zA-Z]+)"/g)].map((match) => [match[1], match[2]]);
assert.equal(adviceCodes.length, 9, "nine advice codes are tabled");
for (const [code, segment] of adviceCodes) {
  for (const [name, dict] of [["zh", zh], ["en", en]]) {
    assert.ok(dict.has(`advice.${segment}.title`), `${name} title for ${code}`);
    assert.ok(dict.has(`advice.${segment}.body`), `${name} body for ${code}`);
  }
  assert.match(client, new RegExp(`"${code}"`), `the host can emit ${code}`);
}

// Key parity cannot see a translation that was pasted into the wrong locale,
// which is exactly how the advice block first shipped. Every advice string must
// actually differ between the two locales.
const dictValue = (name, key) => {
  const start = client.indexOf(`const ${name} = {`);
  const body = client.slice(start, client.indexOf("\n\t\t};", start));
  const match = new RegExp(`"${key.replace(".", "\\.")}":\\s*"((?:[^"\\\\]|\\\\.)*)"`).exec(body);
  return match === null ? null : match[1];
};
for (const [code, segment] of adviceCodes) {
  for (const suffix of ["title", "body"]) {
    const key = `advice.${segment}.${suffix}`;
    assert.notEqual(dictValue("DICT_ZH", key), dictValue("DICT_EN", key), `${key} is translated, not copied`);
  }
}

// An actionable code also needs a past-tense line: adopting replaces the button
// with the verdict block, and a bare "Adopted · too early to tell" is
// indistinguishable from "the click did nothing". Every code with a button must
// therefore be able to say what actually ran.
const actionsStart = client.indexOf("const ADVICE_ACTIONS = new Set([");
assert.ok(actionsStart > 0, "the action table is declared");
const actionCodes = [...client.slice(actionsStart, client.indexOf("]);", actionsStart)).matchAll(/"([a-z-]+)"/g)].map((match) => match[1]);
assert.ok(actionCodes.length > 0, "at least one advice is actionable");
const segmentOfCode = new Map(adviceCodes);
for (const code of actionCodes) {
  const segment = segmentOfCode.get(code);
  assert.ok(segment !== undefined, `${code} has a locale segment`);
  for (const [name, dict] of [["zh", zh], ["en", en]]) {
    assert.ok(dict.has(`advice.${segment}.ran`), `${name} past-tense line for ${code}`);
  }
  const key = `advice.${segment}.ran`;
  assert.notEqual(dictValue("DICT_ZH", key), dictValue("DICT_EN", key), `${key} is translated, not copied`);
}

// The other half of the same invariant: a tip with no button has to say what the
// human is meant to do instead. It used to render one generic "this one is yours
// to handle" line, which named no action and read as a shrug.
for (const [code, segment] of adviceCodes) {
  if (actionCodes.includes(code)) continue;
  for (const [name, dict] of [["zh", zh], ["en", en]]) {
    assert.ok(dict.has(`advice.${segment}.manual`), `${name} manual line for ${code}`);
  }
  const key = `advice.${segment}.manual`;
  assert.notEqual(dictValue("DICT_ZH", key), dictValue("DICT_EN", key), `${key} is translated, not copied`);
}
assert.ok(!zh.has("advice.manual"), "the generic manual line is gone — every code carries its own");
assert.ok(!/t\("advice\.manual"\)/.test(client), "the panel no longer asks for the removed generic line");

// A body that asks for {automatic} renders the literal "undefined" unless
// adviceParams returns that key, and a param nobody interpolates is dead
// weight. Neither shows up in any other check: the key exists, the string
// exists, and only the two together are wrong.
const paramsStart = client.indexOf("function adviceParams(");
assert.ok(paramsStart > 0, "adviceParams is declared");
const paramKeys = new Map();
for (const match of client.slice(paramsStart, client.indexOf("\n\t\t}", paramsStart)).matchAll(/case "([a-z-]+)":\s*return \{([^}]*)\}/g)) {
  paramKeys.set(match[1], new Set([...match[2].matchAll(/([a-zA-Z]\w*)\s*:/g)].map((key) => key[1])));
}
assert.equal(paramKeys.size, adviceCodes.length, "adviceParams has a case for every tabled code");
for (const [code, segment] of adviceCodes) {
  const declared = paramKeys.get(code);
  assert.ok(declared !== undefined, `adviceParams handles ${code}`);
  const used = new Set();
  for (const suffix of ["title", "body", "action", "instruction", "ran", "manual"]) {
    for (const name of ["DICT_ZH", "DICT_EN"]) {
      const text = dictValue(name, `advice.${segment}.${suffix}`);
      if (text === null) continue;
      for (const placeholder of text.matchAll(/\{([a-zA-Z]\w*)\}/g)) used.add(placeholder[1]);
    }
  }
  assert.deepEqual([...used].sort(), [...declared].sort(), `every placeholder ${code} uses is one adviceParams supplies, and vice versa`);
}

process.stdout.write(`check: locales OK (${String(zh.size)} keys, ${String(asked.size)} requested)\n`);
NODE

echo "check: all green"
