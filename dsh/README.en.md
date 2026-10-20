# dsh-hermes-link

**English** | [简体中文](README.md)

A server plugin library that exposes dsh agent sessions through the A2A
(Agent2Agent) protocol to remote agents (such as Hermes), enabling the
"Hermes = brain, dsh = arms" interoperability.

## Preview

The following effects are driven by this library's A2A server and streaming
events; client-side rendering is done by
[dsh-hermes-link](https://github.com/ArtomYuan/dsh-hermes-link) (code-block
rendering of tool commands / execution results / final text, and progress pushed
to Feishu / QQ).

### Live stream

When a dsh task is submitted, the client consumes the SSE stream and pushes
intermediate progress back to the messaging surface in real time. The live
sequence a user sees in Feishu / QQ looks like this (commands and results are
rendered as code blocks):

```
🚀 开始执行
🧠 思考中…
🔧 `bash`                    <- tool call, command in a code block
    ┌─ ```bash
    │  ls -la /tmp
    └─ ```
📋 `bash` 完成               <- tool result, output in a code block
    ┌─ ```
    │  total 4
    │  drwxrwxrwt  2 root root 40 Sep 11 14:00 .
    └─ ```
📖 输出完成                  <- long result rendered as a code block
✅ 完成
```

Long text exceeding the gateway's per-message limit is split at code-block
boundaries; continuation chunks are joined with a `⏩ 续` marker, so code blocks
never break across chunks.

### Code blocks

Operation content — tool commands, execution results, and final text — is
automatically rendered as code blocks:

- **Feishu**: fenced content triggers post rich text; code blocks are scrollable;
- **QQ / other mainstream gateways**: markdown code blocks render as code blocks;
- **plain-text platforms**: automatically degraded to plain text (no garbling).

Sample code-block content (an `ls -la` output block):

```text
total 4
drwxrwxrwt  2 root root 40 Sep 11 14:00 .
drwxrwxrwt  2 root root 40 Sep 11 14:00 ..
-rw-r--r--  1 root root  0 Sep 11 14:00 demo.txt
```

> Actual rendering depends on each gateway's client.

### Event stream

The streaming event form produced by this library (under
`SendStreamingMessage`: text Part + data Part private extension; fields taken from
the source `StreamEventDescriptor`):

```
artifactUpdate  artifactId: "stream-text"  append: true         <- text chunk, text Part
artifactUpdate  artifactId: <uuid>  mediaType: application/json  <- intermediate event, data Part
  kind: "tool_call"    { turn, step, name, arguments }
  kind: "tool_result"  { turn, step, name, text }
  kind: "thinking"     { turn, step, text }
  kind: "turn_start"   { turn, step }
  kind: "turn_end"     { turn, step, reason? }
statusUpdate   submitted → working → completed
```

See [CONFIGURATION.en.md](CONFIGURATION.en.md) for full fields and mechanics.

## Architecture

![Architecture](assets/architecture-en.png)

## Interactive Q&A bridge (since 0.6.0, §2.6)

When dsh calls `ask_user_question` mid-task, this server **catches and publishes** the
question onto the A2A stream: first a `question` event (`artifactUpdate` + `data` part with
`askId` and the question/options), then `statusUpdate(INPUT_REQUIRED)` (whose status message
carries the same payload so `tasks/get` shows the suspension). **The first stream ends
there** — the wait holds no long connection.

The answer returns through a **native A2A continuation**: the client sends another message
for the **same `taskId`** carrying a `question-answer` data part (`askId` + structured
answers; `skipped=true` means skipped). The server releases the ask, the first hop finishes,
and its remaining events flow on **the continuation stream**. **No timeout anywhere.**

**Client capability declaration (what keeps the default unchanged)**: only tasks whose first
message carries `metadata: {"x-dsh-user-questions": true}` (and streams) are claimed;
undeclared callers still see the question fail immediately with `NO_PROVIDER` instead of
entering a no-timeout wait.

```jsonc
// initial message (declares the capability)
{"jsonrpc":"2.0","id":"1","method":"SendStreamingMessage","params":{"message":{
  "role":"ROLE_USER","messageId":"...","contextId":"feishu/oc_x/omt_y",
  "metadata":{"x-dsh-user-questions":true},
  "parts":[{"text":"start","mediaType":"text/plain"}]}}}

// continuation answer (same taskId; the data part is the machine-readable one)
{"jsonrpc":"2.0","id":"2","method":"SendStreamingMessage","params":{"message":{
  "role":"ROLE_USER","messageId":"...","taskId":"<task id from the initial call>",
  "parts":[{"data":{"kind":"question-answer","askId":"<askId from the question event>",
                    "answers":[{"id":"q1","selected":["A"],"custom":"note"}]},
            "mediaType":"application/json"}]}}}
```

- No config key is added or removed; **initial** messages behave exactly as before this
  release — undeclared callers (including the synchronous `SendMessage` path) still see the
  question fail immediately with `NO_PROVIDER`, never a no-timeout wait.
- **A continuation carrying `taskId`** is the only new request semantic: (1) with an answer
  payload (`question-answer`) it releases the ask; (2) without a payload and with **no**
  pending question it is passed through as an ordinary continuation and waits for the first
  hop's terminal state; (3) without a payload while the task **is** awaiting an answer, the
  server answers with `INPUT_REQUIRED` and **ends that stream** (the client learns the task
  awaits input), while the original question keeps waiting for a real answer — no stream is
  ever left open without events.
- Three exits for a question — answered / caller aborted / task ended (`cancelTask` releases
  too); nothing is ever left dangling.
- Known limitation: with several concurrent A2A tasks on one session, question attribution is
  ambiguous (claims are keyed by agent); not covered yet.

## Request-level options: workspace and sandbox tier (since 0.7.0, §2.1/§2.4)

A client may put two optional keys in the initial message's `message.metadata` (both omitted =
today's behaviour, byte-for-byte unchanged):

```jsonc
{"x-dsh-workspace": "my-book",              // workspace name, or an absolute path "/srv/books/my-book"
 "x-dsh-sandbox": "workspace-write"}        // read-only | workspace-write | danger-full-access
```

- **Workspace**: a name is matched exactly against existing workspaces by title / directory
  name (unique hit wins; several hits → error, never a guess); no hit → a same-named directory
  is created under the server cwd and registered; an absolute path is realpath-normalised and
  used (created if missing). The resolved path becomes the session cwd. The session-reuse key already contains
  the cwd ⇒ **switching workspace in one conversation opens a new session**, the same workspace
  reuses it.
- **Sandbox tier**: applied to that **session** through dsh's `permissionPresets` (the same
  write path as the GUI sandbox switch: `permission/preset` + `sandbox/mode` +
  `approval/policy`, idempotent). In this deployment `read-only`/`workspace-write` pair with
  `approval=ask`, `danger-full-access` with `never`.
- **Read scoping (corrected after review, 2026-10-18)**: none of the three tiers restricts
  reads (bwrap always `--ro-bind / /`); however "confines writes only" holds for `read-only`
  and `workspace-write` — `danger-full-access` **confines nothing**. The `workspace-write`
  writable set is **more than the session cwd**: it also includes `/tmp` (a private tmpfs under
  bwrap, the real `/tmp` under Landlock/Seatbelt) and `os.tmpdir()`.
- **An absolute path is an explicit escape hatch**: the server keeps no allowlist; pointing
  `workspace` at `/` with `workspace-write` makes the whole disk writable — use with care.
- **To verify live**: this deployment pairs `read-only`/`workspace-write` with `approval=ask`,
  and the A2A path has no approval answerer; whether ordinary writes under `workspace-write`
  become "unavailable" (rather than a sandbox denial) must be measured after the host reload
  (§3.4).
- **Invalid values** (unknown tier, empty workspace, a name containing path separators, a path
  containing `..` segments, …) close the task as FAILED with a clear reason — **never silently
  replaced by defaults**.
- No config key is added or removed; when the host lacks `permissionPresets` the server warns
  and leaves the tier unchanged.
- **"with workspace" and "without workspace" count as two different workspaces in one
  conversation**: omitting it means the generic workspace (pre-upgrade behaviour), so the two
  land in **two sessions** (the reuse key contains the cwd). Remembering the choice across
  calls is §2.2 (first-use selection / binding, not implemented this round); until then callers
  should pass `workspace` on every call.

## Relationship with dsh-hermes-link

This library exposes a standard A2A interface and does not depend on any specific
client — other A2A clients can call it directly. Hermes users who want the full
experience (live progress / session continuity / single execution) can pair it with
[dsh-hermes-link](https://github.com/ArtomYuan/dsh-hermes-link). The two libraries
are not hard-bound; combine them as needed:

| Combination | What you get |
| --- | --- |
| This library only | A standard A2A interface callable by any A2A client |
| With dsh-hermes-link | Full experience: task submission + live progress + session continuity + single execution |

## Versions & Support

| Plugin version | Supported dsh |
| --- | --- |
| **0.5.x** (current) | **0.1.5-rc.2 ∥ 0.2.0-rc.2** — both runtimes in parallel; settings area (Settings) and live stream (text/thinking frames) both available on 0.2.0 |
| 0.4.x | 0.1.5-rc.2 ∥ 0.2.0-rc.2 — both runtimes in parallel; settings area available on 0.2.0, but the live stream lacks text/thinking frames |
| 0.3.x | 0.1.5-rc.2 ∥ 0.2.0-rc.2 — both runtimes in parallel; no plugin change needed |
| 0.2.x | 0.1.x |

Since 0.3.0, moving between dsh 0.1.5 and 0.2.0 (in either direction) requires no
plugin change; since 0.4.0 the settings area (GUI) is available on dsh 0.2.0; since
0.5.0 the live stream (text/thinking frames) is restored on dsh 0.2.0; since
0.5.1 the lead release waits for active subagents to settle (`settleCapMs`). See
[CONFIGURATION.en.md](CONFIGURATION.en.md) for mechanics.

## Installation

This library is an independent public bundle package (not a package inside the dsh
workspace), distributed as a standalone bundle.

1. Install it into a dsh profile (choose one):

   - **From npm (recommended)**:

     ```sh
     dsh plugin --profile <name> add @artomyuan/dsh-hermes-link
     ```

     Pin a version when needed: `dsh plugin --profile <name> add @artomyuan/dsh-hermes-link@0.5.1`.

   - **From the GitHub source** (to try unreleased changes; **the commit must be pinned**):

     ```sh
     dsh plugin --profile <name> add github:ArtomYuan/dsh-hermes-link#<commit>
     ```

     The first `add` fails because pnpm >=10 refuses to run a git dependency's
     `prepare` script; add the package key to the profile's `pnpm-workspace.yaml`
     as prompted, then rerun:

     ```yaml
     allowBuilds:
       @artomyuan/dsh-hermes-link: true
     ```

2. Fill the minimal A2A server plugin config (`port` / `authToken` / `preset`) in
   the profile's cordis config:

   ```yaml
   - id: a2a-server
     config:
       port: 8092
       authToken: <token>
       preset: standard
   ```

   The `token` must match Hermes-side `a2a_agents.dsh.auth.token`.

3. Restart dsh to load the new plugin (how depends on your dsh deployment):

   ```bash
   # Example: user-level systemd service
   systemctl --user restart dsh
   ```

## Settings panel

The dsh Web UI "Settings → Plugins → Plugin configuration" automatically shows an
`a2a-server` settings card as soon as the plugin is included in the profile — no
changes to the dsh repository and no whitelist are required. It is implemented on
the official dsh settings seam: the host side registers the `a2a-server` settings
namespace (schema defined by schemastery), and the browser side provides a settings
card.

> **On dsh 0.2.0**: 0.2.0 has no `installSection`/`register` seam; the settings
> area is instead derived from the plugin's exported runtime `Config` schema
> (namespace still `a2a-server`). Differences from 0.1.5: form edits land in the
> profile's **`cordis.patch.yml`** (not `settings.yaml`), and the derived area
> always reports `applies: 'live'` even though `port`/`host`/`contextMapPath`
> actually require a restart. See [CONFIGURATION.en.md](CONFIGURATION.en.md).

### Configuration layering

- The plugin `config` in `cordis.patch.yml` remains the composition (base) layer and
  source of truth;
- Edits made in the panel are written to the dsh user settings document
  `$DSH_HOME/settings.yaml`, as the **user override layer**;
- Resolution order: schema defaults < `cordis.patch.yml` < user overrides.

The panel marks which fields are overridden by the user layer and offers "Clear
override" to fall back to the value in `cordis.patch.yml`.

### Fields and effective timing

| Field | Effective timing |
| --- | --- |
| `provider` / `model` / `preset` / `cwd` / `authToken` / `contextMapTtlDays` | Takes effect on the next A2A request after saving (no restart) |
| `port` / `host` / `contextMapPath` | Requires a dsh restart (or profile reload); the running instance keeps listening on the startup address |

- Empty `model` (empty string) = follow the dsh current default model; empty `cwd` =
  `process.cwd()`; empty `port` = auto-probe a free port at startup.

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
`cordis.patch.yml` configuration.

No extra install steps: `link:` or a normal install followed by a dsh restart is
enough. The published artifact ships both the host output `lib/` and the browser
output `client/`; git installs build both halves automatically via the `prepare`
script.

## Links

- Detailed configuration and mechanics: [CONFIGURATION.en.md](CONFIGURATION.en.md)
- Changelog: [CHANGELOG.md](CHANGELOG.md)
- License: [License & Attribution](#license--attribution)

## License & Attribution

This project is distributed under the GNU General Public License v3.0 (GPL-3.0);
see `LICENSE` for the full text. Parts of the implementation (the agent session
takeover / agentLocks / origin-map session-reuse pattern) are ported from
[chushixixin/dsh-harness-mcp-server](https://github.com/chushixixin/dsh-harness-mcp-server)
(MIT License, Copyright chushixixin); the original MIT copyright notice is
retained, and the code is re-licensed into this project under the MIT terms.
