# dsh-a2a-server Configuration & Mechanics

> Status: **P2a streaming intermediate events + context map cleanup**. The A2A
> server business logic is in place (node:http + Bearer auth +
> `@a2a-js/sdk` JsonRpcTransportHandler + AgentExecutor → synchronous dsh session
> execution); `message.contextId` maps to a dsh session (reuse + resume across
> restart); `preset` is configurable (including agent-team); `SendStreamingMessage`
> pushes thinking / tool / status / text intermediate events in real time; the
> contextMap performs TTL cleanup. Since 0.3.0 it is **compatible with both dsh
> 0.1.5 and 0.2.0** (see "dsh 0.1.5 / 0.2.0 dual-version compatibility").

## Installation (full methods)

This library is an independent public bundle package (not a package inside the
dsh workspace), distributed as a standalone bundle. Choose one of three methods.

### Method A: npm (recommended)

```sh
dsh plugin --profile <name> add @artomyuan/dsh-a2a-server
```

The official default channel (`dsh plugin add` without a prefix installs from the
npm registry); published to npm with a prebuilt `lib/`, so no build authorization
is required. Pin a version when needed: `@artomyuan/dsh-a2a-server@0.3.0`.

### Method B: GitHub install (for unreleased changes)

```sh
dsh plugin --profile <name> add github:ArtomYuan/dsh-a2a-server#<commit>
```

- **The commit must be pinned** (`#<sha>`): git installs pull source code rather
  than build artifacts, and pinning the commit prevents later pushes from
  silently changing the code executed at install time.
- **allowBuilds authorization**: pnpm >=10 refuses to run the `prepare` script of
  a git dependency by default. The first `add` fails and tells you to add the
  package key to the profile's `pnpm-workspace.yaml`:

  ```yaml
  allowBuilds:
    @artomyuan/dsh-a2a-server: true
  ```

  Then rerun `add`. This authorization equals **allowing this package's code to
  run on your machine at install time** (outside the agent sandbox); only grant
  it to trusted sources with a pinned commit.

### Method C: tarball

```sh
pnpm pack                 # produces artomyuan-dsh-a2a-server-<version>.tgz
dsh plugin --profile <name> add ./artomyuan-dsh-a2a-server-<version>.tgz
```

### Uninstall

```sh
dsh plugin --profile <name> remove @artomyuan/dsh-a2a-server
```

## Package structure (bundle)

- `package.json`: the `dsh.bundle.patch` declaration plus `@deepseek-ai/cordis`
  peer/dev mirror.
- `cordis.patch.yml`: an array of patch entries that `insert` one A2A server
  plugin line. It does **not** `insert` an `agent-presets` line (the full
  profile's web-app bundle already provides it; inserting it again fails to load
  with a duplicate entry id); a dsh-base-only profile must add the
  `agent-presets` line itself.
- `src/index.ts`: the plugin entry (`name` / `inject` / `apply`).
- `tsdown.prepare.config.ts`: the self-contained transpile config for `prepare`
  on git installs (transpiles `src/` → `lib/`, no project references, no type
  checking).

## Service API

The A2A server exposes two endpoints (JSON-RPC binding, protocol version `1.0`):

- `GET /.well-known/agent-card.json`: the agent card (JSON; the auth check runs
  before any routing, so once `authToken` is set this endpoint also requires a
  Bearer token). Contains
  `supportedInterfaces[].protocolBinding = "JSONRPC"`, `protocolVersion = "1.0"`,
  `capabilities.streaming = true`.
- `POST /`: JSON-RPC. `method: "SendMessage"` (blocking) carries the user text
  message; the server's `AgentExecutor` submits the text to a dsh agent session
  for synchronous execution, and the final output is returned as an artifact
  (`lastChunk: true`). The task status flow is `submitted → working → completed`.
  `method: "SendStreamingMessage"` (streaming) takes the same parameters but
  pushes intermediate events progressively over SSE (see "Streaming intermediate
  events" below).

Auth: once `authToken` is configured, every request must carry
`Authorization: Bearer <token>`, otherwise `401`.

### contextId session mapping

`params.message.contextId` (derived by Hermes from origin) maps to a dsh session —
the same contextId reuses the same dsh session (continuous context), different
contextIds are isolated. The mapping is persisted to
`$DSH_HOME/storages/a2a-context-map.json` (format
`contextId\0cwd → {sessionId, lastUsedAt}`); after a server restart the same
contextId resumes via `ctx.agents.resume`; entries are TTL-cleaned by
`lastUsedAt` (default 7 days). When contextId is absent the server generates a
random contextId (equivalent to creating a new session each time, no reuse).

### Streaming intermediate events

Under `SendStreamingMessage`, DshAgentExecutor subscribes to the dsh agent's
streaming event surfaces (0.1.5's `session/event`; on 0.2.0 assistant deltas
additionally arrive over the process-local `agent/assistant-stream`, see A6) and
pushes high-signal intermediate events as A2A streaming events in real time —

- text chunks → `artifactUpdate` (text Part, `artifactId: "stream-text"`,
  `append: true`);
- reasoning, tool calls/results, turn boundaries → `artifactUpdate` (**data Part
  private extension**, `mediaType: application/json`, value is a JSON descriptor).

The data Part descriptor `kind` values: `thinking` (`{text}`), `tool_call`
(`{name, arguments}`), `tool_result` (`{name, text}`), `turn_start` /
`turn_end` (`{turn, step, reason?}`). During the test phase reasoning is passed
through verbatim for verification.

## Events

A synchronous task (`SendMessage`) returns task → statusUpdate → artifact →
statusUpdate. A streaming task (`SendStreamingMessage`) additionally pushes
thinking / tool / status / text intermediate events in real time (see "Streaming
intermediate events"), then the final artifact completes.

## Extension points / configuration (full field list)

`Config` fields (cordis.yml plugin `config`; the token can also be read from the
environment variable `A2A_SERVER_TOKEN`):

- `port`: listen port (defaults to probing 8092/8093/8094 for the first free port).
- `host`: listen address (default `127.0.0.1`, local only).
- `authToken`: Bearer token (enforced once set).
- `provider`: backend provider (default `deepseek-official`).
- `model`: execution model (default `deepseek-v4-flash`; empty string = follow the
  dsh user/default setting).
- `preset`: the agent preset to mount (default `standard`; can be `agent-team`
  etc., see below).
- `cwd`: task working directory (default process cwd).
- `contextMapPath`: persistent file path for the contextId→session mapping
  (default `$DSH_HOME/storages/a2a-context-map.json`).
- `contextMapTtlDays`: mapping entry TTL in days (default 7; expired entries are
  cleaned on load/write).
- `settleCapMs`: **upper bound, in milliseconds, on waiting for this Lead's live
  continuable subagents to settle before the handle is released** (default
  `1800000` = 30 min; `0` disables the wait and restores the old semantics). On
  timeout the handle is released anyway (queue fallback) with a warning — see
  "Waiting for subagents before release" below.

Injected dependencies: `agents`, `agentPresets`, `sessions` (the `settleCapMs`
wait additionally needs the host's `subagents` service — see "Degradation" below).

## Settings panel

The dsh Web UI "Settings → Plugins → Plugin configuration" automatically shows an
`a2a-server` settings card as soon as the plugin is included in the profile — no
changes to the dsh repository and no whitelist are required. It is implemented on
the official dsh settings seam: the host side registers the `a2a-server` settings
namespace (schema defined by schemastery), and the browser side provides a settings
card.

The card is collapsible, matching the official dsh plugin cards: it starts
collapsed, and clicking its header expands or collapses it. While edits are
unsaved the header carries an "Unsaved" marker, and a successful save collapses
the card again. Collapsing never discards drafts.

### Configuration layering

- The plugin `config` in `cordis.patch.yml` remains the composition (base) layer and
  source of truth;
- Edits made in the panel are written to the dsh user settings document
  `$DSH_HOME/settings.yaml`, as the **user override layer**;
- Resolution order: schema defaults < `cordis.patch.yml` < user overrides.

The panel marks which fields are overridden by the user layer and offers "Clear
override" to fall back to the value in `cordis.patch.yml`.

### Fields and effective timing

| Field | Default / empty-value semantics | Effective timing |
| --- | --- | --- |
| `port` | Empty = auto-probe a free port at startup | Requires a dsh restart (or profile reload) |
| `host` | Non-empty (validated) | Requires a dsh restart (or profile reload) |
| `authToken` | Secret field, write-only | Next A2A request (no restart) |
| `provider` | Default `deepseek-official` | Next A2A request (no restart) |
| `model` | Default `deepseek-v4-flash`; empty string = follow the dsh current default model | Next A2A request (no restart) |
| `preset` | Default `standard` | Next A2A request (no restart) |
| `cwd` | Empty string = `process.cwd()` | Next A2A request (no restart) |
| `contextMapPath` | Empty = `$DSH_HOME/storages/a2a-context-map.json` | Requires a dsh restart (or profile reload) |
| `contextMapTtlDays` | Default 7 | Next flush cleanup (no restart) |
| `settleCapMs` | Default `1800000` (30 min); `0` disables the wait | Next A2A request (no restart) |

After saving `port` / `host` / `contextMapPath`, the running instance keeps listening
on the startup address until dsh is restarted (or the profile reloaded).

### Waiting for subagents before release (settleCapMs, since v0.5.1)

**Why**: an A2A request used to call `handle.dispose()` immediately after
`whenIdle()`. If the Lead settled right after delegating (`spawn_teammate` /
`subagent`), a late child return found the parent absent from `ctx.agents`, and
dsh-subagent reported `PARENT_UNAVAILABLE` (rc.2+ has a queue patch as a fallback,
but the main path still waited for the next session activation).

**New behaviour**: the handle is released only once the Lead is **idle _and_ has no
live continuable subagent**. The wait is **event-driven** (`subagent/start|end`
plus this agent's `agent/status`; no busy polling): turns started by a child return
run to completion before the next check, and children spawned by those turns are
picked up from a refreshed catalog. A return that arrives while the parent is still
registered is therefore delivered and continues the chain immediately.

**Liveness rule**: rows with `mode === 'continuable'` in
`ctx.subagents.listChildren(leadId)` (the durable subagent catalog) are the
children that return (one-shot children are not awaited). The catalog is durable
and full, so the baseline is "children still present in this process's agent
registry when the wait starts", and liveness is then maintained incrementally from
`subagent/start|end` events (`end` removes, `start` re-adds — a cold resume is a new
epoch).

**Cap**: when `settleCapMs` expires the handle **is released** (never waits
forever), with a warning naming the live count and stating that late returns fall
back to the dsh-subagent queue patch.

**Request lifecycle (explicit semantic change)**: finalization moves from "the Lead
went idle once" to "after the subagents settled", so the bridge stream stays open
across stages. Acceptance is unchanged: SUBMITTED / WORKING and the bridge's
"⏳ accepted" receipt still return immediately; only the final result is later.

**Threshold advice**: keep `settleCapMs` ≤ the bridge's `a2a_agents.dsh.timeout`
(3600 s on this host) **minus** the task's own expected duration; raise the bridge
timeout for very long pipelines, or align both (1800000 = 30 min is the recommended
default here).

**Degradation**: if the host has no `subagents` service (e.g. dsh 0.1.5) or the
catalog query fails, the plugin **does not wait** (0.5.0 behaviour) and warns;
`settleCapMs=0` disables the wait as well. In all three cases the dsh-subagent queue
patch remains the fallback for late returns.

### Credentials (authToken)

- The panel is write-only for `authToken` (always shows "Set / Not set", input starts
  empty; a blank input = no change).
- "Clear override" only removes the user-layer override and falls back to the existing
  token in `cordis.patch.yml`; it never silently disables auth.
- When the final resolved value is empty, the panel explicitly warns "Not set = no
  auth (dangerous)".
- The `A2A_SERVER_TOKEN` environment variable takes precedence over configuration; in
  that case the panel shows "managed by environment variable" and is not editable.

### Degradation

When the settings service is absent the plugin keeps working, using only the
`cordis.patch.yml` configuration; the settings card does not appear in that profile.

### Installation & build

No extra install steps: `link:` or a normal install followed by a dsh restart is
enough. The published artifact ships both the host output `lib/` and the browser
output `client/`; git installs build both halves automatically via the `prepare`
script.

## agent-team mount (deployment notes)

The `agent-team` preset depends on the tool-subagent `modelSelectionSettings`
(web-app-only host service `subagent-model-selection-settings`) and nine Team
tools (from the `@deepseek-ai/dsh-experimental-agent-team-profile` bundle). A
dsh-base-only standalone profile lacks these host lines, so they must be added to
the profile's cordis tree (equivalent to the agent-team-profile bundle's
`cordis.patch.yml` + the web-app host lines). dsh-base also does not provide the
`agent-presets` line, so it must be inserted as well (the full profile's web-app
already provides it; duplicating it creates a duplicate entry id):

```yaml
- insert:
    - id: agent-presets
      name: '@deepseek-ai/dsh-agent-presets'
      config:
        default: minimal
- id: tool-subagent-control
  disabled: true
- id: tool-subagent-list-agents
  disabled: true
- id: tool-subagent
  config:
    provider: spawn
    toolName: subagent
    backgroundMode: one-shot
- id: tool-subagent-fork
  config:
    provider: fork
    toolName: subagent_fork
    backgroundMode: one-shot
- insert:
    - id: subagent-model-selection-settings
      name: '@deepseek-ai/dsh-tool-subagent/model-selection-settings'
    - id: agent-team
      name: '@deepseek-ai/dsh-experimental-agent-team'
      config:
        maxMembers: 8
        maxTasks: 256
        maxPendingMessagesPerMember: 64
        maxMessageBytes: 65536
        disposalTimeoutMs: 5000
    - id: tool-agent-team
      name: '@deepseek-ai/dsh-experimental-tool-agent-team'
      config:
        freshProvider: spawn
        forkProvider: fork
- id: a2a-server
  config:
    preset: agent-team
```

Where `@deepseek-ai/dsh-experimental-agent-team` / `-tool-agent-team` must be
resolvable (the full profile ships them; a standalone profile mounts them via
`dsh plugin add link:<source-tree-path>`). The `agent-team` preset itself comes
from the user root (`$DSH_HOME/.agent-presets/agent-team`, `includeUserRoot`
includes it by default).

## dsh 0.1.5 / 0.2.0 dual-version compatibility

Since 0.3.0 this plugin supports both the dsh 0.1.5-rc.2 and 0.2.0-rc.2
runtimes (the `package.json` peer range covers both), as the prerequisite for a
future switch/rollback. The compatibility logic lives in `src/compat.ts` and
follows "feature detection + loud degradation".

### Version detection mechanism

`dshRuntimeVersion()` resolves `@deepseek-ai/dsh-agent/package.json` via
`createRequire(import.meta.url)` (both 0.1.x and 0.2.0 export that subpath,
verified in the sandbox) and reads its `version` field. On failure it returns
`undefined` (never throws); everything then falls back to 0.1.5 behavior with a
single explicit `console.warn` line (production today is 0.1.5 — keep the status
quo rather than silently change behavior).

### Two message source shapes (A1)

0.1.5's `MessageSourceMap` has a `plugin` kind (`{kind:'plugin', plugin:…}`);
0.2.0 removed that kind (only model/tool/system-prompt remain) and namespace-izes
plugin messages as `kind: 'plugin:<name>'`. `pluginMessageSource()` returns,
per the detection above:

- 0.2.x: `{ kind: 'plugin:dsh-a2a-server' }`
- 0.1.x or detection failure: `{ kind: 'plugin', plugin: 'dsh-a2a-server' }`

Sending the legacy shape on 0.2.0 makes the message **never enter the agent
loop — the task silently does not execute** (looks COMPLETED but yields
`(no text output)`), so this is the hard gate of the dual-version adaptation.

### Dual-shape tool_result (A2)

The `tool/result` session event differs between the v3 and v4 session formats;
`readToolResult()` reads `{ callId, text }` with precedence v4 → v3 →
`data.callId`:

- v4 (0.2.0, measured): `toolCallId` on the message level, `content` already
  flattened into text blocks;
- v3 (0.1.5): `message.content[0].toolCallId` +
  `message.content[0].content[0].text`.

Wire event field names are unchanged (`kind/turn/step/name/text`); the tool name
keeps the existing `callId→name` lookup recorded at `tool/call`. When no shape
matches it returns both fields as `undefined` — no throw, no event-stream change.

### Dual event surface for live assistant deltas (A6)

Assistant deltas (text / reasoning) travel over **two mutually exclusive event
surfaces** across the runtimes:

| Runtime | Event surface | Carrier |
| --- | --- | --- |
| 0.1.5 | `session/event`'s `assistant/chunk` | session event; `data.chunk` is a `StreamChunk` |
| 0.2.0 | process-local cordis event `agent/assistant-stream` | payload `{ agent, frame }`; frame is a `start`/`chunk`/`end` tri-state and `frame.chunk` is the same `StreamChunk` union |

0.2.0-rc.2 removed `assistant/chunk`, so an implementation that only knew the old
surface (0.4.0) delivered nothing but turn/tool/status frames on 0.2.0 — **neither
text frames nor thinking frames** (confirmed by a real-machine A2A SSE capture).
Since 0.5.0 both paths coexist:

- 0.1.5: `session/event` → `applySessionAssistantChunk`;
- 0.2.0: `agent/assistant-stream` → `applyAssistantStreamFrame`, filtered first by
  `payload.agent === handle.agent` (the plugin ctx is not agent-scoped and would
  otherwise receive frames from every agent in the same host);
- both surfaces share one block-index buffering plus `block-end` whole-block landing
  state machine (text block → `text` frame, reasoning block → `thinking` frame;
  empty blocks never land); on 0.2.0 turn/step come from the most recent `start`
  frame, on 0.1.5 from `data.turn/step` as before.

**One-way dedup gate**: once a task has seen any `agent/assistant-stream` frame,
later `session/event` `assistant/chunk` chunks for that task are ignored, so one
block can never land twice. The reverse gate is deliberately absent — 0.1.5 never
publishes the process-local frames, so a reverse gate would only matter if both
surfaces fired at once, and the process-local surface is the earlier and more
complete one; letting it always win avoids losing low-latency frames. The
subscription shares one lifecycle with `session/event` and is released in the same
`finally`.

Whether to subscribe to the process-local surface is the OR of two signals:
`supportsAssistantStreamEvents(dshRuntimeVersion())` (unknown versions count as
**true** — missing the subscription would silently drop every 0.2.0 frame while an
extra inert listener costs nothing; deliberately the opposite fallback direction
from A1's message-source predicate) or a live session in v4 format. Both the
version predicate and the buffering state machine are pure functions in
`src/compat.ts`; unit tests live in `tests/compat.test.mjs`.

### Settings panel on 0.2.0 — derived from the exported Config schema (A3)

The panel registration goes through the official settings seam, feature-detected
into three branches:

1. `settings.installSection` exists (0.1.5 today): the original path, panel works;
2. only `settings.register`: replicate equivalent semantics with register +
   `scope.watch` (conservative; no published version hits this branch);
3. neither exists (**0.2.0 today**: its npm release has no `installSection` /
   `register` / `SettingsScope` at all): this branch no longer warns "panel
   unavailable" — it logs an info line describing where the settings area comes
   from instead.

On 0.2.0 the settings area no longer depends on a register seam; it is derived
from the plugin's exported runtime `Config` schema (`A2AConfigSchema`, i.e.
`export const Config` in `src/index.ts`): `dsh-settings`' `schema(entry)` reads
`entry.fiber.runtime.Config` (which must have `toJSON`), and `volatileForm()`
only collects fields marked `meta.volatile` into the derived form. So this plugin
marks all 9 config fields `.volatile()`, with the namespace = the cordis row id
`a2a-server` (same as 0.1.5), and the settings area appears.

#### Behavior differences from 0.1.5 (important)

- **Different write target**: on 0.1.5 the panel writes
  `$DSH_HOME/settings.yaml` (the user override layer); on 0.2.0 form edits are
  **over Cordis profile patches**, landing in the profile's
  **`cordis.patch.yml`**, and take effect via cordis `_reload()`
  (`patchReload: live`). Do not assume 0.2.0 still writes `settings.yaml`.
- **`applies: 'live'` vs real timing**: 0.2.0's derived area always reports
  `applies: 'live'`, but this plugin's `port` / `host` / `contextMapPath`
  actually need a **restart** (or profile reload) to take effect (the plugin
  cannot override the service's `applies` field). The remaining fields
  (provider/model/preset/cwd/authToken/contextMapTtlDays) take effect on the
  next A2A request.

`authToken` keeps `role('secret')`, which 0.2.0's `redactSecrets` uses for
write-only (no echo). Runtime config reads must go through `unwrapVolatile` on
both versions, since `.volatile()` fields validate to `{ get() }` reference
objects.

#### Browser half: card mount (0.2.0 `plugins.item` / 0.1.5 `settings.plugin.item`)

The settings **card** (browser half) uses two mutually-exclusive slot/service
contracts on 0.1.5 vs 0.2.0, chosen by the pure `pickClientMount` function
(`src/client/mount-strategy.ts`) via capability detection — **0.1.5 wins to avoid
regression**:

| Axis | 0.1.5 (legacy) | 0.2.0 (modern) |
| --- | --- | --- |
| Service | `ctx.settingsScope` (`SettingsScopeBinder`) | `ctx.configForms` (`ConfigForms`) |
| Data plane | `settingsScope.bind({ namespace })` → `SettingsScope`; `settingsScope.describe()` | `configForms.get('a2a-server')` → `ConfigForm`; `configForms.describe()` |
| Slot | `settings.plugin.item` (`kind:'keyed'`, key = namespace) | `plugins.item` (`kind:'list'`, declared by `dsh-client-ui-plugin-manager`) |
| Mount guard | nested `ctx.inject(['settingsScope'], …)` | `configForms.whileServed(['a2a-server'], …)` (card mounts only while the Host serves the namespace) |

On 0.2.0 the registration block copies the official
`dsh-client-ui-settings-{subagent,agent-loop,web-search,shell}` shape:
`{ name:'plugins.item', id:'a2a-server', order:50, label:()=>t('a2aTitle'),
locale:NS, inject:()=>controller.inject() }`; the card component switches between
`view:'summary'` (the official list's one-liner) and `view:'page'` (the full form).
The 0.1.5 registration block stays unchanged.

Both data planes (`SettingsScope` and `ConfigForm`) expose identical snapshot
fields (`status/value/base/user/revision/writable/mode`), so the controller
consumes one local minimal contract `A2AFormSource` (`card-controller.ts`): 0.2.0
passes `configForms.get` directly, 0.1.5 goes through `legacyScopeSource` (wrapping
`Promise<void>` into `Promise<boolean>`). Writes carry `revision` (OCC/conflict
semantics); 0.2.0's `mutate` returns whether the Host accepted (`false` after a
recovery read), 0.1.5 re-reads `userLayer` after saving, and on conflict the
snapshot is re-read per contract.

#### Host primitive symbols: runtime resolution plus a local fallback

The card never imports a host primitive through a static named import. The browser
half and the host packages are related through bundle externals: the build
references the host module as a namespace property access (shaped like
`_primitives.Tag`), so statically importing a name the host does not export fails
neither the build nor the module link — it only yields `undefined` at runtime, and
rendering it as a component is React #130 (element type is invalid).

The measured differences between the two versions of
`@deepseek-ai/dsh-client-ui-primitives` (export surfaces counted from the packages):

| Symbol | 0.1.5-rc.2 | 0.2.0-rc.2 | Handling |
| --- | --- | --- | --- |
| `IconChevronDownOutline14` | yes | no (renamed) | first candidate |
| `IconChevronDownOutlineRegular` / `…Medium` | no | yes | second and third candidates |
| `Tag` | yes | yes (identical `TagTone` union) | resolved the same way, guarding against a like rename |

The card resolves candidates through the pure `resolveComponent` in
`src/client/primitive-symbols.ts` (no React or JSX, unit-testable under node) and
falls back to local implementations in `src/client/primitives.tsx` (a hand-drawn
14px SVG chevron and a local pill) when every candidate is missing, so **no version
ever renders `undefined`**. Host-provided symbols always win, keeping the look
consistent with the host. Regression coverage lives in
`tests/primitive-symbols.test.mjs`.

### 0.2.0's version gate and exemption (A4)

0.2.0 added a runtime compatibility gate: a plugin whose peer range does not
cover the installed dsh version is refused with `Plugin … is incompatible with
dsh 0.2.0-rc.2`. Since 0.3.0 the peer range is widened (`… || ^0.2.0-rc.2`), so
**fresh installs no longer need the exemption**; deployments still running an
old version (≤0.2.1) on 0.2.0 do:

```sh
dsh plugin --profile <p> allow-version @artomyuan/dsh-a2a-server@<old-version> --dsh-version 0.2.0-rc.2 --accept-risk
```

### Session resume diagnostics (A9)

Resuming a v3 session with an old contextId on 0.2.0 fails and falls back to a
new session (the v3→v4 open fails). The plugin keeps the existing degradation
unchanged (no throw, drop the mapping, create new) but now logs a diagnostic:
the error `name`/`code`/`message` and the first 3 `stack` lines, explicitly
stating `falling back to a NEW session (contextId mapping dropped)`.

## Design notes

- Conversation semantics: A2A `message.contextId` ↔ dsh session. The same
  contextId reuses the same dsh session (continuous context), different
  contextIds are isolated; two-level takeover (persisted mapping hit → resume,
  miss → create + write mapping); the mapping persists across restart and
  resumes, with TTL cleanup (default 7 days). On task completion, flush + release
  the handle.
- Streaming granularity: the blocking `SendMessage` returns the final result;
  `SendStreamingMessage` pushes thinking / tool / status / text intermediate
  events in real time (text Part + data Part private extension).
- Transport choice: JSON-RPC over node:http (self-built listener, not express);
  the agent card is served from the `/.well-known/agent-card.json`
  endpoint (also protected by Bearer auth).

## Naming

- Package name: `@artomyuan/dsh-a2a-server` (the `name` referenced by the bundle patch for
  Node resolution).
- Patch line logical id: `a2a-server`.
- Plugin role: `Executor` (corresponds to the A2A `AgentExecutor` mapping, which
  submits the A2A task text to a dsh agent session for execution).

## Development

```sh
pnpm install      # independent workspace (isolated by pnpm-workspace.yaml, does not touch the main repo lockfile)
pnpm run build    # tsdown transpiles src/ → lib/ (standalone, no project references)
pnpm run typecheck # tsc --noEmit
```

`lib/index.js` is transpiled directly by tsdown (ESM); `@deepseek-ai/*` and
`@a2a-js/sdk` are external dependencies and are not bundled into the artifact;
they are resolved inside the profile at runtime.
