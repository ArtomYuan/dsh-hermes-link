# Change Log

> **Since 0.10.0 the ledger lives at the repository root `CHANGELOG.md`** (merged into
> `dsh-hermes-link`, lock-step versioning). This file keeps the history up to 0.9.0.

[简体中文](CHANGELOG.md)

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/).

## [0.7.0] - 2026-10-18

> The **server side** of §2.1 **workspace selection** and §2.4 **sandbox tier**: two optional
> keys are read from the A2A initial message's `message.metadata` (`x-dsh-workspace` /
> `x-dsh-sandbox`) and used to resolve the session cwd and apply the sandbox tier.
> **Omitted = today's behaviour**: no config surface changes and no existing behaviour changes.

### Added

- **`src/request-options.ts`** (new; pure logic with injected dependencies, zero dsh runtime
  dependency, its own `lib/request-options.js` entry for unit tests):
  - `readRequestOptions` / `parseSandboxTier` / `parseWorkspaceSpec`: metadata parsing and
    strict validation (exact three-tier values; workspace names reject path separators, `.`/`..`,
    and are ≤64 chars; path form rejects `..` segments);
  - `resolveWorkspaceTarget`: a name is matched exactly against existing workspaces by title /
    directory name (unique hit wins; several hits → error, never a guess); no hit → a same-named
    directory under the server cwd; an absolute path is used as-is (created if missing);
  - `applySandboxTier`: applies a **session-level override** through
    `ctx.permissionPresets.set(session, tier)` (the same write path as the GUI sandbox switch,
    idempotent); a missing plugin / an unknown preset name / a write error warns loudly and
    leaves the current tier untouched.
- **Request-level cwd**: `resolveSession`'s reuse key already contains the cwd
  (`${contextId}\0${cwd}`), so "switch workspace in one conversation = new session, same
  workspace = reuse" is guaranteed by the key itself; roster registration reuses the existing
  `ensureWorkspace + attachSession`.
- **Where the tier lands**: after session resolution and before `followup` (effective from the
  first turn); repeating the same tier appends no event (`permissionPresets.set` is idempotent).
- Tests: `tests/request-options.test.mjs` (10 cases: wire-literal lock, parsing/validation incl. C1/bidi control characters and null symmetry, four workspace resolution paths, five tier outcomes) and
  `tests/request-options-contract.test.mjs` (2 cases: **wire contract** — both metadata keys
  arrive intact at the executor after the SDK's JSON-RPC encode/decode; `undefined` when absent).

### Changed

- `execute()` performs **syntactic** parsing before publishing any task event: an invalid shape
  throws there → the SDK synthesises task + FAILED and the client receives a clear error (never
  silently replaced by defaults). **Semantic workspace errors** (ambiguous name, mkdir failure)
  happen during resolution/creation and may occur after SUBMITTED/WORKING — they still close as
  FAILED with the reason.
- `runDshTask` gains a `requestOptions` parameter and a `resolveRequestCwd` helper; two
  informational log lines were added (workspace: request/hit-kind/cwd; sandbox: request/outcome/session).
- `tsdown.prepare.config.ts` gains the `src/request-options.ts` entry; the `package.json` test
  script includes both new test files; the agent-card `version` is synced to 0.7.0.

### Compatibility and scoping

- No config key is added or removed; deliveries without request-level options behave exactly as
  in 0.6.0.
- Read scoping (corrected after review): none of the three tiers restricts reads; "confines
  writes only" holds for `read-only` / `workspace-write` (`danger-full-access` confines
  nothing). The `workspace-write` writable set includes, besides the session cwd, `/tmp` and
  `os.tmpdir()` (a private tmpfs under bwrap).
- **An unapplied tier is now visible**: when the host lacks the preset or the write fails, the
  server warns *and* a streaming task emits a text warning in the stream (synchronous tasks do
  not pollute artifacts) — callers can no longer believe it applied.
- The sandbox tier is a **session-level override**: a later request with a different tier
  switches that session; omitting it changes nothing.
- Known boundary: switching workspace within one conversation opens a new session (intended);
  the old session and its result-delivery address are unchanged (§2.5 lock-session
  reconciliation lands in a later section).

## [0.6.0] - 2026-10-17

> §2.6 **Interactive Q&A bridge (server side)**: a mid-task dsh `ask_user_question` can
> now be **seen and answered** over A2A — while suspended the task enters
> `INPUT_REQUIRED` and the question payload goes out with the stream; the answer comes
> back as a **continuation on the same `taskId`**, releasing the first hop, whose
> remaining events flow on the continuation stream.
> **No timeout anywhere** (fixed requirement); **claiming requires an explicit client
> declaration**, so undeclared callers behave exactly as in 0.5.1.

### Added

- **`src/questions.ts`** (new; pure logic, no dsh runtime dependency, its own
  `lib/questions.js` entry for unit tests): normalization `toQuestionItems`, payload
  builder `questionPayload`, claim `claimQuestion`, answer parsing `readQuestionAnswer`,
  release `resolveQuestion` (exact `askId` first; when exactly one ask is pending an
  `askId`-less degraded hit is allowed **with a loud warning**; a stale token warns and is
  ignored), task-end release `abandonQuestions`.
- **Question seam**: a **prepended** listener on dsh's `user-questions/request`
  (agent-scoped waterfall) that claims **only agents running our own A2A tasks** and calls
  `next()` otherwise — the GUI answerer keeps working (line priority: questions of an
  A2A-owned session belong to the line that started it).
- **Two visible surfaces**: (1) a `question` event (`artifactUpdate` + `data` part, which
  the bridge renders into a card); (2) `statusUpdate(INPUT_REQUIRED)` whose status message
  carries the same payload, so `tasks/get` shows which task awaits which question.
- **`question-answer` data-part return path**: the continuation carries `askId` plus
  structured answers (`answers[].selected` / `custom`); `skipped=true` means the user
  skipped (closed as aborted).
- **Client capability declaration**: only tasks whose first message carries
  `metadata["x-dsh-user-questions"]=true` (and streams) are claimed. **This is what keeps
  the default unchanged**: undeclared callers (older bridges, direct A2A clients) still see
  the question fail immediately with `NO_PROVIDER` instead of entering a no-timeout wait —
  otherwise a question would be parked where no answer can ever arrive and hang silently.
- **No dangling waits**: three exits — answered / `signal` aborted / task ended; `cancelTask`
  also releases pending questions, and every task path ends with `abandonQuestions` so the
  asker receives an abort rather than hanging forever.
- **Misused continuations are closed explicitly**: a `taskId` continuation without an answer
  payload, when the task *is* awaiting an answer, gets `INPUT_REQUIRED` back to end that
  stream (the SDK terminates cleanly at input-required), so the client learns the task awaits
  input; the original question keeps waiting for a real answer and the first hop is
  unaffected. **No stream is left with just a snapshot and then silence.**
- Tests: `tests/questions.test.mjs` (8 cases) and `tests/qna-continuation.test.mjs`
  (4 cases: **A2A-side contract regression** — `input-required` ends the first stream,
  `taskId` continuation is accepted, the continuation stream receives the first hop's later
  events, capability metadata survives, plus one deliberate tripwire).

### Changed

- **`execute()` handles continuations**: a message carrying a `taskId`
  (`requestContext.task` present) no longer starts a fresh dsh turn; it goes through
  `resumeTask`.
- New `resumeTask`: publish a **task snapshot first**, then release — the continuation is a
  **new stream** and the SDK's `_advanceStreamPattern` requires its first frame to be
  task/message, otherwise it throws `UnsupportedOperationError` ("Received artifactUpdate
  before initial 'Message'/'Task' event", measured at runtime). Afterwards the answer is
  matched by `askId`, and the call **conservatively waits for the first hop's terminal
  state** — the answer path does not rely on the SDK detail that `INPUT_REQUIRED` keeps the
  bus alive, whereas the "misused continuation closed with `INPUT_REQUIRED`" path below
  **does** (verified: `keepBusAliveStates` includes `INPUT_REQUIRED` by default, so the first
  hop's bus is never cleaned up and the task is never put into a false terminal state).
- `runDshTask` registers the first-hop drain (always) and the claim-table entry (declared
  tasks only); its `finally` unregisters first, then releases pending questions and
  continuation waiters (the order matters).
- `cancelTask` releases that task's pending questions.
- `tsdown.prepare.config.ts` gains the `src/questions.ts` entry (matching the
  settle/compat precedent); the `package.json` test script now includes both new test files.
- Agent-card `version` synced to 0.6.0.

### Compatibility

- No config key added or removed; undeclared callers (including the synchronous
  `SendMessage` path) behave **exactly as in 0.5.1**.
- Known limitation: with several concurrent A2A tasks on one session, question attribution
  is ambiguous (claims are keyed by agent); not covered in v1.

## [0.5.1] - 2026-10-12

### Changed

- **Wait for live continuable subagents before releasing the Lead (A2A "close the
  window at the source")**: previously the request called `handle.dispose()`
  immediately after `whenIdle()`, so a Lead that settled right after delegating was
  gone by the time a late child return arrived — dsh-subagent reported
  `PARENT_UNAVAILABLE` (rc.2+ has a queue patch as a fallback, but the main path
  still waited for the next session activation). Since 0.5.1 the handle is released
  only once the Lead is **idle _and_ has no live continuable subagent**: a return
  that arrives while the parent is still registered is delivered and continues the
  chain immediately, so the "parent absent" window no longer exists in the main
  path. The wait is **event-driven** (`subagent/start|end` plus this agent's
  `agent/status`; no busy polling): turns started by a child return run to
  completion before the next check, and children spawned by those turns are picked
  up from a refreshed catalog.
- **Request lifecycle (explicit semantic change)**: finalization moves from "the
  Lead went idle once" to "after the subagents settled", so the bridge stream stays
  open across stages. Acceptance is unchanged: SUBMITTED / WORKING and the bridge's
  "⏳ accepted" receipt still return immediately; only the final result is later.
- **New setting `settleCapMs`** (default `1800000` = 30 min; `0` disables the wait
  and restores the old semantics): a stuck or endlessly forking child must not block
  forever — on timeout the handle **is released** with a warning naming the live
  count and stating that late returns fall back to the dsh-subagent queue patch.
  Keep the cap ≤ the bridge's `a2a_agents.dsh.timeout` minus the task's own duration
  (3600 s on this host; the default leaves half of it).
- **Degradation**: if the host has no `subagents` service (e.g. dsh 0.1.5) or the
  catalog query fails, the plugin does not wait (0.5.0 behaviour) and warns; in all
  three degraded paths the dsh-subagent queue patch remains the fallback.

### Added

- `src/settle.ts` (new; pure logic, zero dsh dependencies, emitted as its own
  `lib/settle.js` entry so it can be unit tested): `waitForSubagentQuiescence` plus
  the pure helpers `continuableChildIds` / `liveChildIds` / `applySignal`. Liveness
  = the durable subagent catalog (`mode === 'continuable'` only) minus ended events
  (`end` removes, `start` re-adds — a cold resume is a new epoch), baselined on the
  children still present in this process's agent registry when the wait starts.
- `tests/settle-window.test.mjs` (15 cases): catalog parsing (filter/dedupe/bad
  rows), baseline + event folding, all four outcomes (`quiesced` / `cap` /
  `disabled` / `unavailable`), event-driven waiting (`waitForSignal` calls ==
  rounds), no lost wakeup (a child that settles and is then cold-resumed must not be
  released early even though its `start` arrives during `whenIdle()`), guaranteed
  unsubscribe, and a bounded cap.
- `CONFIGURATION.md` / `CONFIGURATION.en.md`: the `settleCapMs` field and a
  "Waiting for subagents before release" section (motivation, liveness rule, cap,
  request lifecycle, threshold advice, degradation).

### Notes

- Field count goes from 9 to 10 (`settleCapMs`); existing fields and defaults are
  unchanged and the 0.1.5 / 0.2.0 dual-version compatibility surface is unaffected
  (the new behaviour is capability-probed).

## [0.5.0] - 2026-10-10

### Fixed

- **Live stream had no text/thinking frames on dsh 0.2.0**: 0.2.0-rc.2 removed the
  `assistant/chunk` session event; live assistant deltas are now published as the
  process-local cordis event `agent/assistant-stream` (payload `{ agent, frame }`,
  where frame is `start`/`chunk`/`end`). 0.4.0 only knew the old event surface, so
  on 0.2.0 the live stream carried only turn_start / tool_call / tool_result /
  turn_end (confirmed by a real-machine A2A SSE capture). Since 0.5.0 both paths
  coexist: 0.1.5 keeps using `session/event`, while 0.2.0 subscribes to
  `agent/assistant-stream` (filtered by `payload.agent === handle.agent`, released
  on task completion alongside the existing `dispose()`), reusing the same
  block-index buffering and `block-end` whole-block landing semantics (text →
  `text` frame, reasoning → `thinking` frame, empty blocks never land). On 0.2.0,
  turn/step come from the most recent `start` frame; on 0.1.5 they still come from
  `data.turn/step`.

### Added

- A one-way dedup gate across the two event surfaces: once a task has seen any
  `agent/assistant-stream` frame, later `session/event` `assistant/chunk` chunks
  for that task are ignored, so one block can never land twice. The reverse gate
  is deliberately absent — 0.1.5 never publishes the process-local frames, so a
  reverse gate would only matter if both surfaces fired; the process-local one is
  the earlier and more complete surface, so letting it always win avoids losing
  low-latency frames.
- New pure helpers in `src/compat.ts` (node builtins only):
  `supportsAssistantStreamEvents` (version predicate; unknown versions count as
  true — missing the subscription would silently drop every 0.2.0 frame while an
  extra inert listener costs nothing, the opposite fallback direction from A1's
  message-source predicate), plus `createAssistantIngestState` /
  `applySessionAssistantChunk` / `applyAssistantStreamFrame` /
  `assistantStreamTurnStep` (frame/chunk buffering decisions).
- 10 new cases in `tests/compat.test.mjs`: 0.1.5/0.2.0 version decisions, the
  start/chunk/end tri-state, text and reasoning each landing at their own
  `block-end`, empty blocks not landing, duplicate-path and duplicate-`block-end`
  not landing twice, and turn/step carried only by `start` frames.
- `CONFIGURATION.md` / `CONFIGURATION.en.md`: new compatibility item A6 (the dual
  event surface for live assistant deltas).

## [0.4.0] - 2026-10-05

### Added

- dsh 0.2.0 settings area restored: the plugin now exports a runtime `Config`
  schema (`A2AConfigSchema`, all 9 fields `.volatile()`), from which 0.2.0's
  settings service derives the `a2a-server` settings area (namespace identical to
  0.1.5); `authToken` keeps `role('secret')` for write-only. `@deepseek-ai/schemastery`
  bumped to `^3.18.4` (the minimum version with `.volatile()` support).
- New unwrap readers: `isVolatile`/`unwrapVolatile` in `src/compat.ts` (pure,
  zero-dependency) and `readSettingValue` in `src/settings.ts`; runtime config
  reads go through `unwrapVolatile` (after exporting a volatile schema, config
  fields on both versions validate to `{ get() }` reference objects).
- New `tests/settings.test.mjs`: `Config` validation behavior (unknown keys kept /
  defaults / `role('secret')` / volatile vs plain) and an **export-contract test**
  (`lib/index.js`'s `Config` has `toJSON`; replicating 0.2.0's `volatileForm`
  collection logic collects all 9 fields).
- Browser-half settings card migrated to 0.2.0: new pure `pickClientMount` in
  `src/client/mount-strategy.ts` (0.1.5 wins, capability detection, mutually
  exclusive mounting) and a unified form backend `A2AFormSource` in
  `card-controller.ts` (0.1.5 `SettingsScope` adapted via `legacyScopeSource`,
  0.2.0 goes straight to `ConfigForm`). On 0.2.0 the card mounts into the
  `plugins.item` slot through `configForms` + `whileServed(['a2a-server'])`
  (copies the official subagent/agent-loop registration shape, `order:50`); 0.1.5
  still uses `settings.plugin.item` + `settingsScope` (unchanged).
  `dsh.client.inject` now also includes `@deepseek-ai/dsh-client-ui-settings`.
  New `tests/mount-strategy.test.mjs`.

### Fixed

- **Card render crash caught in a real browser (React #130)**: the settings card
  imported the host primitive `IconChevronDownOutline14` by a static named import,
  but that symbol was renamed in `dsh-client-ui-primitives` 0.2.0-rc.2 (size suffix
  → `…Regular`/`…Medium` variants). Under bundle externals the name resolves to
  `undefined`, so the details view crashed on render (the summary view renders no
  such symbol and stayed fine). The card now resolves candidate names at runtime
  through the pure `resolveComponent` in `src/client/primitive-symbols.ts` and
  closes the gap with local fallbacks in `src/client/primitives.tsx` (a hand-drawn
  14px SVG chevron and a local pill); host symbols still win, so both versions keep
  the host look. `Tag` is resolved the same way even though both versions ship it,
  guarding against a like rename. New `tests/primitive-symbols.test.mjs`
  (10 cases: candidate order, degradation when an export is missing, non-component
  values rejected, both versions' names required in the list).

### Changed

- The 0.2.0 no-`installSection`/`register` branch: the loud `console.warn`
  ("panel unavailable") is now an info log explaining that the settings area is
  derived from the exported `Config` schema.
- Docs: CONFIGURATION / README (both languages) add a "0.2.0 settings area"
  section, stating the two behavior differences from 0.1.5 — 0.2.0 form edits land
  in the profile's `cordis.patch.yml` (not `settings.yaml`, applied via reload);
  the derived area always reports `applies: 'live'` even though
  `port`/`host`/`contextMapPath` actually require a restart.

## [0.3.1] - 2026-10-05

### Fixed

- Fix invalid YAML in `cordis.patch.yml`: quote the package name
  (`name: '@artomyuan/dsh-a2a-server'`). In 0.3.0 the scoped name was unquoted,
  and `@` cannot start a plain scalar in YAML: on dsh 0.1.5 this caused a fatal
  boot failure (parse error), and on dsh 0.2.0 the bundle was silently skipped
  (plugin not loaded).

### Changed

- The npm package name and runtime identifiers are `@artomyuan/dsh-a2a-server`
  since 0.3.0 (documentation note).

## [0.3.0] - 2026-10-02

### Added

- dsh 0.1.5 / 0.2.0 dual-version compatibility (new `src/compat.ts`):
  - version detection: `dshRuntimeVersion()` reads the real version from
    `@deepseek-ai/dsh-agent/package.json` via `createRequire`; on failure it
    falls back to 0.1.5 behavior with a `console.warn` (never throws);
  - dual message source shapes: 0.2.0 uses the namespace-ized
    `kind: 'plugin:dsh-a2a-server'` (its `MessageSourceMap` dropped the `plugin`
    kind; the legacy shape would make tasks silently never execute), 0.1.5 keeps
    `{kind:'plugin', plugin:'dsh-a2a-server'}`;
  - dual-shape tool_result read: both v4 (`message.toolCallId` + flattened
    `content`) and v3 (`message.content[0]` wrapper block) yield the callId and
    text; wire event field names unchanged;
  - settings panel registration feature-detected into three branches:
    `installSection` (0.1.5 original path) → `register`+`watch` conservative
    replica → neither present (0.2.0 today): one loud warn, A2A service keeps
    working;
  - resume failures upgraded to a diagnostic log (`name`/`code`/`message`/first
    3 `stack` lines + explicit "falling back to a NEW session (contextId mapping
    dropped)"); the degradation behavior is unchanged.
- New `tests/compat.test.mjs` (node:test, stdlib-only, paired v3/v4 tool-result
  fixtures); `pnpm test` runs `build:host` first.

### Changed

- Version bumped to 0.3.0 (agent card `version` updated in sync).
- `package.json`: all dsh peer ranges gained `|| ^0.2.0-rc.2` (0.2.0's version
  gate no longer needs `allow-version` for fresh installs); added optional peer
  + devDependency `@deepseek-ai/dsh-agent-preset-registry@0.2.0-rc.2` (0.2.0's
  preset service provider; its 0.2.0 type chain conflicts with the 0.1.x
  schemastery augmentations, so no `import type {}` augmentation — see docs).
- Docs: new "dsh 0.1.5 / 0.2.0 dual-version compatibility" chapter in
  CONFIGURATION (both languages); a "Versions & Support" matrix and a 0.2.0
  settings-panel note added to the README (both languages); installation docs
  reordered to put npm first (recommended), with GitHub install kept for
  unreleased changes.

## [0.2.1] - 2026-09-28

### Fixed

- Sessions now auto-register to their workspace (grouped immediately after creation), and orphaned ungrouped sessions are re-attached in a startup backfill, fixing sessions created via A2A showing as "Ungrouped" in the Web UI.
- The startup backfill now waits for `workspaceRegistry` to be ready (a `ctx.inject` runtime dependency), fixing the restart race that left `attached=0`.

## [0.2.0] - 2026-09-27

### Added

- Settings panel: a new `a2a-server` settings card in the dsh Web UI under
  Settings → Plugins → Plugin configuration (official settings seam — registers the
  `a2a-server` namespace, no changes to the dsh repository, no allowlist). Read/write
  provider / model / preset / cwd / port / host / authToken / contextMapPath /
  contextMapTtlDays; layering is schema defaults < `cordis.patch.yml` <
  `$DSH_HOME/settings.yaml` user overrides, with per-field "clear override".
- Browser half and build output: new client settings card (react + locales +
  card-controller); published artifacts now include both the host half `lib/` and the
  browser half `client/`.
- New dependencies: `@deepseek-ai/schemastery` (dependencies), plus react and
  `@deepseek-ai/dsh-client-*` (devDependencies).

### Changed

- The settings card is now a collapsible card: collapsed by default, click the card
  header to expand/collapse; it auto-collapses after a successful save while rejected
  writes stay expanded; an "Unsaved" tag appears on the header when there are pending
  edits. The interaction matches the official plugin card (PluginCard): the header
  button carries `aria-expanded` and a bilingual `aria-label`, the chevron is reused
  from the module-table shared package `@deepseek-ai/dsh-client-ui-primitives`, and the
  look follows `--dsw-*` tokens. Collapse state is exposed via `data-open` on the root
  node; the `data-testid` / `data-ns` / `data-scope-status` contract is unchanged.
- The `build` / `prepare` scripts now produce both halves — host (`lib/`) and client
  (`client/`); git installs build automatically via `prepare`.

### Fixed

- `runtimeConfig` assignment changed from truthy guards to a wholesale assignment of
  resolved values (including `undefined` fallback), fixing "clearing a field /
  clearing an override has no effect".

## [0.1.0] - 2026-09-12

### Added

- Initial A2A server implementation: JSON-RPC over node:http, with the `@a2a-js/sdk`
  JsonRpcTransportHandler + AgentExecutor delivering A2A task text to a dsh agent
  session for synchronous execution.
- Agent card: public `GET /.well-known/agent-card.json` endpoint (JSONRPC binding,
  protocolVersion 1.0, capabilities.streaming).
- Bearer auth: when `authToken` is configured, `Authorization: Bearer *** is enforced.
- contextId session reuse + cross-restart resume: `message.contextId` maps to a dsh
  session; the mapping persists to `$DSH_HOME/storages/a2a-context-map.json` with TTL
  cleanup (7 days by default).
- agent-team preset mounting (`preset: agent-team`).
- Streaming intermediate events: `SendStreamingMessage` pushes thinking / tool /
  status / text intermediate events in real time (text part + private data-part
  extension).
- `SendMessage` returns the final text synchronously (artifact, lastChunk).

### Changed

- LICENSE changed from MIT to GPL-3.0.

### Security

- The project is distributed under GPL-3.0; parts of the implementation (agent session
  takeover / agentLocks / origin-map session reuse pattern) are ported from
  chushixixin/dsh-harness-mcp-server (MIT License, Copyright chushixixin). The original
  MIT notice is retained, and those parts are relicensed into this project under the
  MIT terms (see the README "License & Attribution" section).

### Docs

- Bilingual README (README.md + README.en.md).
