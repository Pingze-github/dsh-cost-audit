#!/usr/bin/env bash
# Point the plugin's own node_modules at the running harness's copies, so the
# checkout resolves `zod`, `@deepseek-ai/dsh-llm`, and
# `@deepseek-ai/dsh-credentials` both for `scripts/check.sh` and for a
# `link:` install into a profile.
#
# Nothing here is committed: node_modules/ is generated.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PROFILE_ROOT="${DSH_PROFILE_ROOT:-/root/.dsh/profiles/web/node_modules}"
SHARED_ROOT="${DSH_SHARED_ROOT:-/root/.dsh/profiles/node_modules}"

[ -d "$PROFILE_ROOT" ] || { echo "link-deps: no profile at $PROFILE_ROOT" >&2; exit 1; }
[ -d "$SHARED_ROOT" ] || { echo "link-deps: no shared root at $SHARED_ROOT" >&2; exit 1; }

mkdir -p "$ROOT/node_modules/@deepseek-ai"

link() {
  local target="$1" dest="$2"
  [ -e "$target" ] || { echo "link-deps: missing $target" >&2; exit 1; }
  ln -sfn "$target" "$dest"
}

link "$PROFILE_ROOT/zod" "$ROOT/node_modules/zod"
for pkg in dsh-llm dsh-credentials dsh-session dsh-session-projection cordis; do
  link "$SHARED_ROOT/@deepseek-ai/$pkg" "$ROOT/node_modules/@deepseek-ai/$pkg"
done

echo "link-deps: node_modules linked to the running harness"
