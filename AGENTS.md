# dsh-stats — project facts

Project-specific facts only. Global rules live in `~/.dsh/AGENTS.md`.

## What this is

A DeepSeek Harness plugin, **not** a standalone app. Two halves:

- `index.js` — host half. A plain Cordis plugin: registers the `dshStats` session
  projection and one exact Connection Fetch route.
- `client.js` — browser half. Hand-written CJS bundle in the
  `window.__ModuleLoader__.load({ id, factory })` form; **no build step, no
  TypeScript, no bundler**. Keep it that way: `prepare` scripts are blocked by
  pnpm for git-hosted deps, and a `link:` install needs the files to be final.

No runtime dependency on any third-party plugin.

## Commands

| Command | What it does |
| --- | --- |
| `bash scripts/check.sh` | **The single success criterion.** Parses both halves, runs the host-half behaviour suite, checks bundle wiring. |
| `bash scripts/link-deps.sh` | Points the checkout's `node_modules` at the running harness (`zod`, `@deepseek-ai/dsh-llm`, `-credentials`, `-session-projection`, `cordis`). `check.sh` runs it on demand. |
| `node scripts/gui-probe.mjs --url <authenticated-url> [--session <id>] [--out shot.png] [--wait <sel>] [--click <sel>] [--size W,H]` | Renders the live GUI in headless Chromium and reports what reached the DOM (`--report` takes a JS expression). `--size 1000,900` exercises the narrow-viewport fallback. |

Install into a profile:

```bash
dsh plugin --profile web add link:/mnt/f/DSH/dsh-stats
```

## Harness facts that cost real time to rediscover

- **`connection.rpc.handle(channel, handler)` is unusable from a plugin.** It
  registers the channel through the *reading* context, and the registry resolves
  `webServer` from the Context that registered Connection — where it is not
  injected — so every registration dies with
  `cannot get property "webServer" without inject`. `dsh-context`'s
  `/dsh-context` channel is dead in this deployment for the same reason. Use
  `connection.fetch.register({ path, methods, requestBody, fetch })` instead: it
  has no such dependency and is scoped to the calling fiber. The path must sit
  under `/api/`, e.g. `/api/dsh-stats.balance`.
- **Read services as *properties*, not `ctx.get()`.** Cordis's tracker only
  rebinds a service to the reading fiber (and only that rebinding makes
  `connection.fetch` / `.rpc` scope correctly) on a **property** read. Use
  `injected.connection`; `injected.get("connection")` returns the untracked
  instance.
- **A newly registered projection unit has no value for sessions whose persisted
  projection checkpoint predates it.** The session list carries projections from
  `cachedSnapshot` (already-materialized cells only), so a unit missing from the
  checkpoint is simply absent until that session takes another event. That is
  why the `/api/dsh-stats.balance` route also folds a session's log on demand —
  do not remove it as redundancy.
- **A projection's `wire.view` must reuse its reference.** The live drive
  publishes on a changed `view` result compared with `Object.is`; rebuilding the
  object every call publishes on every event. Hence `statsView()` (pure, used by
  the on-demand fold) plus a one-slot memo in `wire.view`.
- **`Context.prototype` reads are strict.** `ctx.foo` throws
  `cannot get property "foo" without inject` unless the reading context injected
  `foo`; `ctx.get("foo")` never throws. That asymmetry is the fastest way to tell
  why an injection callback silently did nothing.
- **Slot wrappers are `display: contents`, so they measure 0×0.** Walking from a
  rendered slot entry to "its container" hits a zero-size wrapper first; any
  layout decision that needs the real band must walk up past every zero-width
  ancestor. Getting this wrong silently disabled the session pill's inline
  placement (`halfBand` came out as 0).
- **Placement cannot rely on re-rendering.** The official stats row mounts on
  its own schedule and its labels change as the session runs, so a layout effect
  alone can measure before the row exists and never run again. The client pairs
  the render effect with a `MutationObserver` on the dock slot wrapper.
- **The composer dock stacks its entries.** Sharing the official stats line is
  therefore negative-margin work, and the lifted row must be
  `pointer-events: none` (with the pill re-enabled) or it swallows the official
  pills' hover and clicks.
- **A padding cannot be negative, a margin can.** The indent that lands the pill
  beside the official content is `(officialContent + gap - pillWidth) / 2`, which
  is legitimately negative when this pill is wider than the official pills;
  `padding-left` would clamp it to 0 and put the pill at the band's left edge.
  It rides `margin-left` on the pill instead.
- **Centring the pair needs the official row moved.** The official pills stay
  centred on their own axis, so a second pill beside them always reads as
  off-centre. The plugin shifts the official node left by
  `(gap + pillWidth) / 2` with an inline `translateX` and clears it on unmount
  and whenever it falls back to its own line. React never set a `style` on that
  node, so the shift survives the official component's re-renders.
- **`str.replace` in the patch scripts hits every occurrence.** The two locale
  dictionaries both end with the same key, so a patch anchored there pasted the
  Chinese advice block into the English dict as well. Key parity cannot see it —
  `check.sh` now asserts every advice string actually differs between locales.
- **Compaction spend is invisible everywhere else.** `compaction/summary` carries
  the summarize call's own `usage`, and nothing in the tree reads it: not
  `tokenUsage`, not `sessionStats`, not `dsh-context`. `dshStats` folds it into
  the session total and names it in its own panel row.
- **`web/deepseek-search-llm-request` and `session/title-llm-request` log only a
  request body** — no usage, so their spend is not merely uncounted but
  unmeasurable from the log. Do not promise a figure for them.
- **`ask_user_question` time is human time.** A tool call's wall time is
  dispatch → result, so waiting for a human shows up as tool time (our session:
  18 minutes of 27). The per-tool breakdown is what makes this legible; do not
  "fix" it by dropping slow calls.
- `dsh plugin add` only writes the profile manifest; a bundle becomes a profile
  layer at boot **unless** `dsh-hotswap` is mounted, which watches
  `dsh.profile.bundles` and hot-mounts new entries. Keep `dsh-hotswap` mounted or
  a restart is needed (and restarting `dsh web` kills the session hosting it).

## Verified against

`@deepseek-ai/dsh` **0.1.5-rc.1 / 0.1.5-rc.2**, profile `web`, provider
`deepseek-official`, model `deepseek-flash`.

## GUI probe

The bundled Debian Chromium (120) predates the `Iterator` global that
`dsh-client-ui-sidebar-documentpreview` touches at module scope, so the probe
installs a one-line polyfill before page scripts. Without it the app boots to
"Failed to load plugins: Iterator is not defined".

The GUI needs an authenticated URL: `grep -o 'http://127.0.0.1:3080/?token=[^ ]*' /var/log/dsh-web.log | tail -1`.
`--session <id>` seeds `localStorage["dsh.sessions.current"]` so the probe opens a
deterministic session. Use a **normal** session: subagent sessions refuse to load
standalone ("subagent Sessions require their durable parent address"), which
shows up as `turnPills: []` and is not a plugin fault.

Plugins are hot-restarted (host code reload) with:

```bash
curl -s -X POST -H 'content-type: application/json' -H 'Origin: http://127.0.0.1:3080' \
  -b <cookie-jar> -d '{"id":"dsh-stats"}' http://127.0.0.1:3080/_dsh/hotswap/restart
```

`GET /_dsh/hotswap/state` lists every loader entry with its phase — the quickest
way to confirm a plugin is `active`.
