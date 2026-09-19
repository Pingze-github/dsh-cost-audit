#!/usr/bin/env bash
# dsh-stats — the project's single success criterion.
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
assert.equal(pkg.name, "dsh-stats", "package name");
assert.equal(pkg.dsh?.bundle?.patch, "./cordis.patch.yml", "declares a bundle patch");
assert.equal(pkg.dsh?.client?.platform, "web", "declares a web client half");
assert.ok(existsSync(pkg.dsh.bundle.patch), "bundle patch file exists");
assert.ok(existsSync("client.js"), "client half exists");

const patch = readFileSync(pkg.dsh.bundle.patch, "utf8");
assert.match(patch, /id:\s*dsh-stats/, "patch mounts the dsh-stats entry");
assert.match(patch, /name:\s*['"]?dsh-stats['"]?/, "patch names the dsh-stats package");

const client = readFileSync("client.js", "utf8");
assert.match(client, /window\.__ModuleLoader__\.load\(/, "client is a bootstrap-facade bundle");
assert.match(client, /id:\s*"dsh-stats"/, "client bundle id matches the package name");
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

process.stdout.write(`check: locales OK (${String(zh.size)} keys, ${String(asked.size)} requested)\n`);
NODE

echo "check: all green"
