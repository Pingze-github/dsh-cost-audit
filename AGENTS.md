# dsh-cost-audit — project facts

Project-specific facts only. Global rules live in `~/.dsh/AGENTS.md`.

## What this is

A DeepSeek Harness plugin, **not** a standalone app. Two halves:

- `index.js` — host half. A plain Cordis plugin: registers the `dshCostAudit` session
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
| `bash scripts/smoke.sh [--gui]` | The runtime verification in **one call**: the gate, the plugin's hot-swap phase, then an invariant sweep over every session on the machine through the live route (`--gui` adds a headless render of the newest session here). Prefer this to a handful of curls. |
| `bash scripts/link-deps.sh` | Points the checkout's `node_modules` at the running harness (`zod`, `@deepseek-ai/dsh-llm`, `-credentials`, `-session-projection`, `cordis`). `check.sh` runs it on demand. |
| `node scripts/gui-views.mjs --url <authenticated-url> [--session <id>]` | **The GUI check in one call.** One probe, one retry, both views (session panel, advice card, bill), and a verdict that separates a real failure from "could not verify". Prefer this to a hand-written `--report` expression. |
| `node scripts/gui-probe.mjs --url <authenticated-url> [--session <id>] [--out shot.png] [--wait <sel>] [--click <sel>] [--size W,H]` | The generic primitive underneath: renders the live GUI in headless Chromium and reports what reached the DOM (`--report` takes a JS expression). Reach for it only when `gui-views.mjs` does not cover the question. `--size 1000,900` exercises the narrow-viewport fallback. |

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
  under `/api/`, e.g. `/api/dsh-cost-audit.balance`.
- **Read services as *properties*, not `ctx.get()`.** Cordis's tracker only
  rebinds a service to the reading fiber (and only that rebinding makes
  `connection.fetch` / `.rpc` scope correctly) on a **property** read. Use
  `injected.connection`; `injected.get("connection")` returns the untracked
  instance.
- **A newly registered projection unit has no value for sessions whose persisted
  projection checkpoint predates it.** The session list carries projections from
  `cachedSnapshot` (already-materialized cells only), so a unit missing from the
  checkpoint is simply absent until that session takes another event. That is
  why the `/api/dsh-cost-audit.balance` route also folds a session's log on demand —
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
  `tokenUsage`, not `sessionStats`, not `dsh-context`. `dshCostAudit` folds it into
  the session total and names it in its own panel row.
- **`web/deepseek-search-llm-request` and `session/title-llm-request` log only a
  request body** — no usage, so their spend is not merely uncounted but
  unmeasurable from the log. Do not promise a figure for them.
- **`ask_user_question` time is human time.** A tool call's wall time is
  dispatch → result, so waiting for a human shows up as tool time (our session:
  18 minutes of 27). The per-tool breakdown is what makes this legible; do not
  "fix" it by dropping slow calls.
- **`useInput` is a selector hook, like `useChat`/`useProjection`.** Calling it
  with no argument crashes with `TypeError: l is not a function` deep inside
  `useSyncExternalStoreWithSelector`, and the crash takes the **whole dock entry**
  down (harness logs `slot entry crashed in 'conversation.composer.dock'`). Read
  primitives: `useInput((state) => state.draft)`. `AdvicePill` now sits behind a
  `SlotBoundary` so the next such mistake cannot cost a client its cost pill.
- **Submitting into a session from a slot** is
  `props.inputActions.setDraft(text)` then `props.inputActions.submit()`. The
  first is a `discrete: true` Lexical update so the state is published before the
  second reads it; `submit()` runs with mode `"queue"`, so it steers a running
  turn instead of failing. Verified end to end by submitting `/goal` (a
  read-only command — no model call, no mutation) into a finished session and
  reading back `command/run` + `command/done` from its log.
- **A new session renders the hero, not the conversation.** Slots under
  `conversation.composer.dock` do not mount until the session has a transcript,
  so anything reached through those props is unreachable in a fresh session.
- **Submitting into a session RESUMES it and runs a turn.** `setDraft` +
  `submit` on a session that looks finished starts a new turn there, against
  that session's own working directory. During this plugin's verification that
  resurrection ran `deploy.sh` in the user's linfev repo before it could be
  interrupted. **Never click an untested action button on a session you did not
  create** — build a throwaway session, or test the record path with a pre-mount
  storage seed instead (`gui-probe.mjs --seed '<key>=<json>'`, which installs
  storage before any page script so mount-time reads see it; writing storage from
  a report races the component that already read it).
- **An action's floor must be relative.** The advisory floors are shares, but one
  metric is a ratio and another is a token count; comparing an absolute move
  against a share reported "got worse" for a 0.1% drift. Compare
  `(before - after) / before` and guard `before === 0`.
- **An adopted verdict must name the action and the baseline.** The first
  adoption that shipped printed "Adopted · too early to tell" with no numbers,
  and the user read it as "I clicked and nothing happened" — even though
  `command/run` + `command/done` in the session log proved `/compact` had run and
  the context had already dropped from 280K to 46K per request. Every actionable
  code therefore carries an `advice.<segment>.ran` past-tense line (check.sh
  asserts one exists per code in `ADVICE_ACTIONS`), the baseline reading prints
  while the sample is short, and `/compact`'s own bill is diffed from the
  `compaction.count` / `summaryCostNano` snapshotted into the record at click
  time.
- **Renaming a `link:`-installed plugin leaves a colliding boot entry.** `dsh web`
  mounts the profile's bundles at boot, and `dsh plugin add/remove` hot-swaps only
  the *new* entry — it cannot unmount the one from boot. After the rename both
  `dsh-stats` and `dsh-cost-audit` resolved to the same `client.js`, so the
  browser executed one bundle twice and died with `client-modules: duplicate
  factory registration for "dsh-cost-audit"`, which cascades into other modules
  (`@deepseek-ai/dsh-api-gateway` too) and shows the user "Failed to load
  plugins". A stub package under the old name does **not** help: the server
  resolved the client path at boot and caches it. What works without restarting
  the harness is removing the bundle from the profile manifest and adding it
  back — every entry then re-resolves its path, and the stale one resolves to
  nothing and drops out. A `dsh web` restart does the same and kills the session
  hosting it.
- **A panel must be capped, or a long list runs off the top of the screen.** The
  advice panel is anchored above its pill, so once the tip list grew past the
  viewport its own top went off-screen and the earliest tips became unreachable —
  not scrolled to, gone. `.dshstats-panel` is now a flex column capped at
  `min(72vh, 620px)` with `.dshstats-panelBody` scrolling inside it and the title
  pinned. Any new list in a panel inherits that; do not add one outside the body.
- **Order tips by the money at stake, with "act now" as the only exception.** A
  tip that accounts for ¥0.10 of a ¥200 session is noise, and acting on it can
  cost more than it saves, so the list leads with whatever costs the most.
  Severity is not the axis — except for `high` (`tool-failures`, `balance-low`),
  which are about being *stuck*, not about spending, and lead whatever they cost.
  Every tip carries `costNano` / `share` / `priced` in its values (normalised in
  one place in `buildAdvice`, not at eight push sites); `priced: 0` is the honest
  answer for the behavioural tips, whose leak is not a bill line — only the
  re-read bill and the summarize calls can be read straight off the log.
- **File a figure by the question it answers, not by its scope.** The account
  report first shipped as the last section of the per-session cost panel, where
  the author could not find it; then as its own dock pill, which he asked to have
  put back inside the advice card "where the suggestions are". Both poles were
  wrong the same way. It is now a view inside the advice card: a two-way switch
  at the top, then today / 7-day / 30-day tabs and a cost-per-turn sparkline.
- **Every text element in a panel inherits the panel's 12px/18px.** A hint that
  sets its own `line-height` is instantly visible as the odd one out — the author
  reported exactly that about the report's notes (`line-height:1.35`, 16.2px
  against the panel's 18px). Differentiate with colour, never with size, and
  check with `getComputedStyle` rather than by eye.
- **A check that is retyped is a check that drifts.** The author restated his
  batching rule after a session in which the same three GUI clicks were written
  as an inline `--report` expression over and over, each with its own sleeps and
  its own parsing. Anything reusable belongs in `scripts/`: `gui-views.mjs` now
  answers the whole "does the GUI render" question in one command, and
  `smoke.sh --gui` is a one-line call into it. Before sending a second read-only
  probe in a turn, stop and put both in one script.
- **Draw cost per turn, never the daily total.** A daily total rises whenever you
  work more, so a curve of it says nothing about efficiency; cost per turn is the
  one series where a rising line means something. Days with no turns are gaps
  rather than zeros — a day off is not a cheap day — and a line through fewer than
  three days is not drawn at all.
- **A tip diagnoses history; its button acts on the present.** The re-read tip is
  raised by a *lifetime* share, but its one-click `/compact` spends real money
  (¥0.42 on the session where this was found) and only pays while the context is
  still big **now** — pressed right after an automatic or manual compaction it
  pays for a second summary to remove context that is already gone. The fold
  therefore records `lastPromptTokens` / `peakPromptTokens` /
  `compactedSinceRequest`, and the button is withheld (with the reason printed)
  while a compaction has run since the last measured request or the context sits
  under half its peak. The diagnosis stays; the button returns by itself when the
  context grows back. Audit every actionable tip this way — the others only steer
  the agent, this one bills.
- **An advisor must be closed under its own advice.** The re-read tip
  recommends `/compact`; the churn tip fired at `compaction.count >= 2`. So
  doing what the panel said produced a second compaction and an immediate
  complaint that the user compacted too often — the advisor arguing with itself.
  Only compactions the *harness* decided on now feed the rule: `command/run` with
  `name: "compact"` sets `pendingCompactAt` (a five-minute window), the next
  `compaction/summary` claims it into `compaction.manual` / `manualCostNano`, and
  the marker is spent either way so it cannot swallow a later automatic one.
  Bumped `stateVersion` to 6. Check any rule you add against the actions the
  other rules offer.
- **A locale placeholder and its parameter are only correct together.** A body
  asking for `{automatic}` renders the literal "undefined" when `adviceParams`
  returns something else, and nothing else catches it: the key exists, the string
  exists. `check.sh` now compares every `{placeholder}` in a code's strings
  against the object that code's `adviceParams` case returns, in both directions.
- **The fold's `wire.view` is memoized on the state reference**, so anything read
  from the wall clock inside `statsView` freezes until the next event. Daily
  spend is therefore folded into a keyed map by `dayOf(event.time)` and the
  *browser* picks today's key at render time — a day rollover lands without
  needing an event.
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
  -b <cookie-jar> -d '{"id":"dsh-cost-audit"}' http://127.0.0.1:3080/_dsh/hotswap/restart
```

`GET /_dsh/hotswap/state` lists every loader entry with its phase — the quickest
way to confirm a plugin is `active`.
