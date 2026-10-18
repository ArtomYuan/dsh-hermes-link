# Changelog

> **Since 0.10.0 the ledger lives at the repository root `CHANGELOG.md`** (merged into
> `dsh-hermes-link`, lock-step versioning). This file keeps the history up to 0.9.0.

[简体中文](CHANGELOG.md)

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/).

## [0.9.0] - 2026-10-18

> The **client-side surface** of §2.1 **workspace selection** and §2.4 **sandbox tier**:
> `a2a_call` accepts two optional arguments, `workspace` (a workspace name or an absolute
> path) and `sandbox` (three-tier enum), carried to the server in the initial message's
> `message.metadata` (`x-dsh-workspace` / `x-dsh-sandbox`).
> **Without them nothing changes**: no config key is added or removed, and generic-workspace
> delivery messages stay byte-for-byte identical apart from the existing capability declaration.

### Added

- **Request-level option passthrough on `a2a_call`**: `workspace` / `sandbox` are validated
  by `_extract_request_meta` and placed in the initial `message.metadata`
  (`consumer._streaming_message_body(extra_metadata=)`). They share the §2.6 capability
  declaration channel. **Note**: an older server (<0.7.0) ignores both keys (its own behaviour
  is unaffected) while the caller believes the options applied — deployment must therefore
  install the **server first, then the bridge** (see the version requirement in CONFIGURATION).
- **Refusal discipline**: an invalid tier (not one of `read-only` / `workspace-write` /
  `danger-full-access`) or an invalid workspace (non-string / empty / blank-only) is
  **blocked immediately** with the accepted values; carrying the options while the streaming
  path is not taken (`collector.enabled=false`, non-dsh target, unresolvable origin, empty
  message) is also **blocked with the reason** — never silently downgraded to defaults, which
  would let the caller believe the options applied.
- **Visible receipt**: the acceptance receipt appends a `(workspace=…, sandbox=…)` summary of
  the **requested values** (whether they actually landed is verified by server logs/results;
  the server additionally emits a text warning in the stream when a tier cannot be applied).
- **Failure reasons are relayed (added after review)**: the bridge used to read only
  `statusUpdate.status.state` and discard the server's `FAILED` status message (which carries
  `Agent execution error: …`), so the line only saw "no text output". Now `normalize_events`
  extracts the status-message text, `consume_stream` records it in `stats["failure_reason"]`,
  and `_stream_dsh_call` uses it as the body when there is none — failure causes (invalid
  arguments and the like) actually reach the line.
- Tests: `tests/test_request_options.py` (14 cases: wire-literal lock plus cross-module
  consistency, message shape and unchanged default, extraction/validation, hook passthrough plus
  the non-dsh / collector-off refusals, the delegated-shape two-layer design, `consume_stream`
  passthrough) and `tests/test_failure_reason.py` (4 cases: extracting and relaying the server's
  FAILED reason).

### Companion

- Requires `dsh-a2a-server` **≥0.7.0** (parses the request-level options from metadata:
  workspace resolution/creation/registration; sandbox tier applied as a session-level override
  through permission-presets).
- Server-side resolution rules, read/write scoping and usage examples live in
  [CONFIGURATION.en.md](CONFIGURATION.en.md) "Request-level options: workspace and sandbox tier".

## [0.8.0] - 2026-10-17

> §2.6 **Interactive Q&A bridge**: a mid-task dsh `ask_user_question` is no longer
> left unanswered — the question is delivered to **the line that started the task**
> as a Feishu **Card JSON 2.0** (option buttons + free-text input + submit/skip),
> the click goes back to the bridge **in-process** (no spooling, no polling), and the
> answer is written back through the **native A2A `input-required` + `taskId`
> continuation**, so the task resumes.
> **No timeout anywhere** (fixed requirement); no config key is added or removed;
> with `collector.enabled=false` the whole path stays dormant (default = today's behaviour).

### Added

- **New module `qna.py`** (stdlib only, no gateway dependency, unit-testable): three
  responsibilities — (1) **question card** `build_question_card` (Card JSON 2.0: body,
  option buttons, input, submit/skip; option buttons carry the formal namespace fields
  `hermes_ask_action` + `ask_id` + `qid` + `choice` + `label`; one card per question);
  (2) **answer registry** `AskSlot` / `register_ask` / `handle_card_action` (the adapter
  patch's handler); (3) **continuation body** `answer_stream_body` (`taskId` +
  `question-answer` data part as a JSON-RPC envelope) and `ResumableStream` (splices the
  continuation stream back into the same consumption loop).
- **Card budget and hard rules guarded in one place**: ≤30 KB per card, ≤200 components,
  ≤100-character button copy, input `max_length` ≤1000; acknowledgement cards are always
  2.0 (a cross-version card update fails with client error 200830).
- **`consumer.py` wiring**: `question` event → send card → wait with **no timeout** →
  continuation → the first hop's post-answer artifacts/completion are drained by the
  **same** loop. Question handling deliberately runs **before every gate**: in quiet mode
  (`collector.events=false`) intermediate events are skipped, but a question must still be
  handled or the task hangs forever.
- **Pre-send gates**: (1) wait for the platform websocket to be up (`_wait_ws_ready` →
  the adapter's `is_ws_ready()`; appendix A measured caveat: clicks inside the restart
  window report "target callback service not online"); (2) only wait for an answer once the
  card was **really delivered** (`sender` falling back to a text row means nothing to
  click, so the ask is closed as skipped).
- **No-dangling discipline**: only three exits — answered / skipped / slot closed. A send
  failure, a closed slot or an internal error all continue with `skipped` (the server
  closes that question as aborted); a task is never left waiting without an exit.
- **Bounded retry when opening the continuation stream** (`_open_continuation`): the
  continuation is the **only** way an answer travels back; if the request cannot be opened
  the answer never lands and, with no timeout on the dsh side, that turn hangs forever. So
  the stream is opened by explicitly pulling its first frame (calling a generator does not
  issue the request) and a failure is retried 3 times (retrying is safe: the server's
  release is idempotent per `askId`, a duplicate continuation is merely logged as "no
  pending question matched"). If all three attempts fail it warns loudly and states that
  the turn must be aborted from the GUI.
- **Capability declaration**: the initial message carries
  `metadata["x-dsh-user-questions"]=true`. The server claims questions **only** for callers
  that declared it, otherwise a question would be parked on a client that cannot answer it
  and, with no timeout, hang silently. Older servers ignore the key.
- **Visible suspension (panel mode only)**: with `collector.card=panel`, one
  `⏳ waiting for an answer (N question(s)) — resumes automatically` status row is emitted;
  `card=off` lines gain **no** extra noise (the question card itself is the visible surface
  and flips to "answered" in place on click).
- Tests: `tests/test_qna.py` (29 cases), `tests/test_qna_flow.py` (12 cases: scripted-stream
  end-to-end incl. quiet mode, card-send failure, websocket not ready, stale token,
  exhausted continuation retries, panel suspension marker vs. no-noise off mode),
  `tests/test_qna_wiring.py` (4 cases: bridge → adapter registry wiring and degraded warns).

### Changed

- **Single-instance discipline + process-shared registry**: `qna` is obtained only through
  `consumer._import_qna()` and pinned under the alias `hermes_a2a_bridge.qna`; the **answer
  registry container lives in the fixed `sys.modules` entry
  `hermes_a2a_bridge_qna_registry`** — even if `qna` ends up loaded twice (an external alias
  cleanup), there is still exactly one `ask_id -> slot` map and a click can never miss. Not
  pedantry: a split registry manifests as "clicked but nothing happens, task hangs", which
  cannot self-heal with no timeout.
- **Invalid options are rejected loudly**: when an option button click cannot be resolved to
  an option (out-of-range index, unknown label) the bridge returns a red "unrecognised
  option" card and does **not** record an answer — it never degrades silently into an "empty
  submit" (which would record an invalid click as the user choosing nothing).
- **Counting**: `stats["events_seen"]` now includes `question` events (previously counted
  after the `continue`, so one short).
- `_streaming_message_body` now carries the capability declaration (harmless to old servers).
- `make_sender` exposes a `ws_ready(platform)` probe (undecidable → pass through; the probe
  itself never blocks Q&A).

### Companion

- Must land together: `dsh-a2a-server` **0.6.0** (`question` event + `user-questions`
  claim + `input-required`/continuation release) and the Feishu adapter **formal patch**
  (`hermes_ask_action` namespace, handler registry, 2.0 ack card, `is_ws_ready()`; see
  `docs/hermes/custom-patches.md`) — it supersedes the trial hook
  `hermes_qa_card_action`.
- The adapter patch lives in the platform plugin; when no bridge handler is registered its
  click branch only logs loudly and acknowledges truthfully, never faking success.

## [0.7.3] - 2026-10-12

> **Warning: the change applies only to `collector.card=panel` (`off` is still the
> default)**: **all** dsh output is now carried by cards — process groups keep their
> collapsible cards unchanged, and **narrative cards**, **close cards** and
> **result cards** are new. With `off` (the default) all three paths fall back to the
> v0.7.0 plain-text form and the **text sequence is unchanged word for word**
> (locked by tests). No configuration key is added / removed / changed; Hermes' own
> messages do not pass through this plugin and are unaffected.

### Added

- **Narrative card** (`render_plain_card`, family `n`): low-signal narrative text
  (the content of `Throttler._flush_text`) is now carried, under `panel`, by a 2.0
  simple card with **no panel and no title** (a single markdown element without
  `text_size` = the default body font size, distinct from the `notation` used by
  process-group member rows). **The truncation rule is unchanged** (still 120
  characters for standard/detailed, no truncation for verbose) — noise reduction is
  not relaxed.
- **Live-stream final-text card** (family `f`): the final text produced by
  `render_line` is likewise carried by a simple card under `panel`, instead of being
  sent directly as an ordinary post/text message.
- **Close card** (family `t`): the close row from `render_turn_close`
  (`▸ 已完成，用时 N 秒`) is carried by a simple card under `panel`. Status and
  elapsed time are also folded into the `📬` head row of the result card — the **two
  chains read their own data and are not coupled** (the live-stream chain is unaware
  of the final-result delivery chain).
- **Result card** (`split_result_cards`): under `panel`, `_deliver_final_result`
  splits "`📬` head row + body" into a 2.0 card whose **first element is the head row
  and second element is the body**; an over-budget body is split into continuation
  cards on line boundaries, and continuation cards do not repeat the head row. The
  head-row wording has a **single implementation** in the new
  `_format_result_parts`, shared by `_format_result_message` (the text fallback
  layer) and the card ⇒ the card form and the text form are **identical word for
  word**.
- **Simple-card chunking** (`split_plain_card_chunks` / `_take_plain_prefix`):
  splitting happens on **line boundaries**, and a single over-budget line is
  hard-split by character binary search; every decision goes through `_card_bytes`
  (real UTF-8 byte count), each card is ≤30 KB / ≤200 elements, and every non-final
  card gets `⏩ 续` appended (same source as text chunking, via the
  `_PLAIN_CONT_MARK` constant).

### Changed

- The meaning of `resolve_card_mode` / `collector.card=panel` is extended from
  "process groups become cards" to **"all dsh content becomes cards"**; the `card`
  documentation of `consume_stream` and the `Throttler` description are updated
  accordingly.
- `_deliver_final_result` gains an optional `card=` (passed in by `_stream_dsh_call`
  after reading it once at task start); **defaulting to `None` = the plain-text path,
  with behaviour exactly as in v0.7.2** (the existing six-argument call signature
  stays compatible).

### Tests

- New `tests/test_card_content.py` (22 cases): C1 simple-card structure (2.0 / no
  panel / no header / only directly-proven fields / `element_id` unique and bounded),
  C2 chunking budget and no information loss in the fallback layer (including a
  60 KB single-line hard split and a result-card head row only on the first card),
  C3 live-stream wiring (under `panel` the narrative / final / close rows are all
  cards; under `off` and `panel` the text sequences are **identical word for word**),
  C4 result delivery (result card / empty body / over-long chunking / `card=None`
  compatibility / one retry after failure).
- `tests/test_card_budget.py`: 3 new cases (`panel` cards everything, the result card
  goes through the card path, the result card falls back to text on failure) plus an
  updated assertion for "a process group sends one collapsible card" (the close row
  is a card now too).
- Full suite **331 cases green** (306 in v0.7.2 + 25 new).
- Along the way, stale measured single-card capacities in `CONFIGURATION.md` /
  `CONFIGURATION.en.md` were corrected (`standard` 197→196, `detailed` 181→180; the
  new values come from this re-measurement and are not a behaviour change).

### Notes

- This release is **pure development**: **no deployment, no gateway restart, no real
  Feishu test message**; the running copy is still v0.7.2 and `collector.card` is
  `panel` in `~/.hermes/config.yaml`, so **the new form only appears after the host
  restarts the gateway** (the restart is performed host-side).
- Process-group card behaviour is unchanged (`render_process_group_card` was not
  touched; the four tiers are still identical word for word to the text version).

## [0.7.2] - 2026-10-12

> **Warning: two changes (both off by default / neither changes the default
> appearance)**: ① **group boundaries** now match dsh — assistant narrative text
> breaks the group, so "tool → narrative → tool → narrative" yields **2 groups + 2
> narrations** instead of "1 group + 1 narration"; ② `collector.card` is new
> (**default `off`**), and setting it to `panel` makes process groups send a
> **Feishu card JSON 2.0 collapsible panel** (one group, one block, collapsed by
> default). **No `enabled` / `events` / `content` / `live_detail` key is added,
> removed or changed**; text rows remain the fallback layer.

### Fixed

- **Group boundaries (plan §4.1)**: when non-final narrative text arrives and a
  process group **really is** waiting to be closed, `Throttler.feed` now **closes
  that group first and then outputs the narration**; `turn_end` / terminal status
  only do "close the residual group + close row" (residual narration is flushed as a
  fallback, losing nothing). With no group waiting, narration still accumulates
  (consecutive narration is not split into separate messages). Along the way one
  **ordering inversion** was fixed: the old implementation put later-arriving final
  text before earlier buffered narration, whereas output now follows event arrival
  order (group → narration → final → close row). Two existing assertions were
  updated with the contract.

### Added

- **`collector.card` (default `off` / `panel`)**: process groups become cards. New
  `render_process_group_card(members, level) -> dict` (a 2.0 collapsible card) and
  `_split_card_chunks` (splits on step-row boundaries, each card ≤30 KB / ≤200
  elements, continuation cards marked "(续)"). The four tiers are **completely
  identical** to the text version (reusing the same wording chain
  `_member_row_blocks` → `group_title` / `dsh_tool_title` / `dsh_tool_summary` /
  `render_turn_close`); `verbose` uses no panel and `detailed` uses
  `expanded:true`. Only directly-proven fields are used; the panel header's
  right-hand chevron icon `down-small-ccm_outlined` (`icon_position="right"`) was
  enabled after passing the T1/T2 on-device tests.
- **The sending path can send cards**: `make_sender`'s `send(...)` gains an optional
  `card=` parameter, and `consume_stream` gains `card=` and reports `message_ids` in
  its stats. **A successful send dict now carries `message_id`**
  (`_finalize_send_result` already filled it but it used to be discarded) — the only
  prerequisite for update-style designs.
- **Degradation chain**: card send failure / a raised exception / an adapter without
  `send_card` → always **falls back to a text row with the same content** (no
  information loss, one warning logged).
- The adapter gains a general
  `send_card(chat_id, card, metadata=None) -> SendResult`
  (`msg_type="interactive"`, reusing `_feishu_send_with_retry`); the
  existing `_send_interactive_card` (approval chain) and connection modes are
  **unchanged**.

### Tests

- New `tests/test_card_render.py` (16 cases): V1 structural assertions
  (`schema="2.0"`, hierarchy, `element_id` globally unique and ≤20 characters, a
  per-level field whitelist = only directly-proven fields); V3 cross-checking the
  four tiers **word for word** against the text version (including the golden
  reference shared with `E2E-OUTPUT.txt`).
- New `tests/test_card_budget.py` (19 cases): V2 budget stress (≤30 KB / ≤200
  elements, no member row lost from the text fallback layer after chunking, single
  card capacity compact≥600 / standard 197 / detailed 181 / verbose 183); V5
  degradation chain (failure/exception/no `send_card` all fall back to text without
  losing content); `collector.card` config normalisation and end-to-end wiring.
- New `tests/test_group_boundary.py` (8 cases): V4 group boundaries (2 groups + 2
  narrations, group before narration, boundary-triggered send, consecutive narration
  not split, residual fallback without information loss, unchanged wire sequence
  output).
- Full suite **306 cases green** (263 in v0.7.1 + 43 new).

### Notes

- This release is **Phase 1 pure development**: **not deployed**, `collector.card`
  defaults to `off`, so when it is not enabled the appearance matches v0.7.1 (apart
  from the group-boundary fix above). **T1/T2 (icon token availability, panel
  chevron) have passed the on-device tests and are enabled (`87e2f2b`)**; T3–T5
  (`notation` font-size rendering, mobile/PC collapse appearance, 30 KB card
  performance) are **one-off tests still awaiting case-by-case administrator
  approval**.
- The adapter change is in
  `~/.hermes/hermes-agent/plugins/platforms/feishu/adapter.py` (+24 lines, purely
  additive); the diff is in the task directory's `adapter-send_card.diff`.

## [0.7.1] - 2026-10-10

> **Warning: behaviour fix (must read before upgrading)**: fixes the phantom promise
> where, when `context_id` could not be parsed into a delivery target, **the live
> stream went silent, the result was not delivered, and yet the receipt still
> promised "过程直播中"**. The **root cause** was that `context_id` was only routed
> back through `split("/")`: the **persisted conversation name shown by `a2a_list`
> is in concatenated form** (`feishuoc_Xomt_Y`), which agents readily use as
> `context_id`, so `chat_id` parsed as empty and `make_sender` degraded to a noop —
> not one process event was sent, the final result was not delivered either, and
> nothing warned. **Now**: the concatenated form is first normalised back to
> `feishu/oc_X/omt_Y` (live streaming as usual, correct routing); when no target can
> be derived, `logger.warning` warns loudly and the receipt becomes an explicit
> warning "`⚠️` 会话标识无法解析……本次不直播、结果仅落工作区". **No configuration key is
> added / removed**, and the standard slash form behaves exactly as before.

### Fixed

- **Normalisation of the concatenated `context_id`** (new
  `_normalize_origin_token`): accepts the `[<platform>]oc_<id>[omt_<id>]` form —
  `feishuoc_Xomt_Y`, `feishuoc_X`, `oc_Xomt_Y` are all restored to
  `platform/chat_id[/thread_id]` (`feishu` is prepended when there is no `platform`
  prefix); the standard slash form passes through. Normalisation is idempotent and
  leaves one `info` trace when it happens.
- **Parse failures are no longer silent**: `_on_pre_tool_call` logs one
  `logger.warning` for an unparsable explicit `context_id` and one for the messaging
  surface origin (both including the **raw string** and the **failure reason**);
  `_stream_dsh_call` logs one more when it cannot derive `platform+chat_id` (the
  original blast point), and the log-level `live=` field now states whether this task
  will really be streamed.
- **Conditional acceptance receipt wording**: `⏳ 已受理……过程直播中；完成后结果会自动
  送达本对话` is given **only when the target parsed successfully**; on failure it
  becomes `⚠️ 会话标识无法解析（未能得出 platform/chat_id：<原因>），本次不直播、结果
  仅落工作区。`
- **Defence in depth**: `_stream_dsh_call` normalises its own argument too — even if
  another call site passes a concatenated string directly, routing stays correct
  (landing on the same `platform/chat_id/thread_id` as `_on_pre_tool_call` after
  normalisation).
- The "explicit wins, caller intent is never overwritten" semantics are
  **unchanged**: on a parse failure the raw string is still adopted as the origin, it
  is just no longer falsely claimed to be streamed and delivered.

### Tests

- New `tests/test_origin_normalize.py` (14 cases): table-driven
  `_normalize_origin_token` (standard slash passthrough / concatenated normalisation
  / garbage failure with a reason / idempotence); the incident string end to end
  (`feishuoc_adb23012c64433f9c10d16ccbe61ee8aomt_19d3188651cf5bef` →
  `feishu/oc_adb23012c64433f9c10d16ccbe61ee8a/omt_19d3188651cf5bef`, with
  `platform=feishu` `chat_id=oc_adb…` `thread_id=omt_…`, and `make_sender` being
  called, i.e. really sending); three assertions for a parse failure (the receipt
  must **not** contain "过程直播中", must contain `⚠️` and the consequence, and
  `assertLogs` must capture the WARNING with the raw string in the log), plus a
  regression for the noop sender + warning in `_stream_dsh_call`.
- Full suite **263 cases green** (249 existing + 14 new).

### Notes

- Incident reference: the `hook stream dsh` lines in `~/.hermes/logs/agent.log` —
  the `03:55:32` line with `context_id='feishuoc_adb…omt_19d3188651cf5bef'` and
  `platform=feishuoc_adb…omt_19d3188651cf5bef chat_id=` (empty) is the incident
  itself; the `00:52:30` / `03:34:26` / `04:18:22` / `04:43:04` / `05:04:09` lines
  in the same file are in the standard slash form with
  `platform=feishu chat_id=oc_adb…` and are normal. After the fix, the `05:12:00`
  line (`omt_19d3188651cf5bef`, the same thread) also carries the correct
  `chat_id`.
- **Not deployed**: this release only changes the worktree; version `0.7.1` is
  published after host-side acceptance.

## [0.7.0] - 2026-10-10

> **Warning: rendering overhaul (appearance change, must read before upgrading)**:
> the live-stream process and replies **drop code blocks / fences entirely** and
> instead replicate the row forms of the dsh client's "work step display" line by
> line — one message = one process group (group header
> `⌄ <processTitle>` + step rows `▸ <tool title> · <summary>` + thinking rows
> `✦ 思考 · <first line>` + a result body indented by 2 spaces), with one close row
> per turn: `▸ 已完成` / `▸ 已完成，用时 <n>秒` / `▸ 处理失败` / `▸ 已停止`; the
> `turn_start` `🚀 第 N 轮` row and the terminal `status` rows `✅ 完成` / `❌ 失败` /
> `⚠️ 已取消` are **removed**; "`📬` result delivered" becomes a head row + blank line
> + the **raw result text** (plain markdown, untruncated). **No configuration key is
> added / removed**.

### Changed

- **The live-stream process moves to the dsh row forms (no code blocks)**: the tool
  steps and thinking of one turn are closed into **one** process-group message
  (`consumer.render_process_group`), with the row structure aligned to dsh line by
  line:
  - group header row `⌄ <processTitle>`: `⌄` = the text equivalent of dsh's
    `IconChevronDown`;
  - step row `▸ <tool title> · <summary>`: the title = dsh `tool.title.*`, the
    summary = dsh `deriveSummary` (`SUMMARY_KEYS` key order / the `queries` array of
    the `search` variant / the tool name appended when the title falls back to
    `工具调用`); for non-`verbose` tiers the summary is truncated at 160 with `…`
    appended;
  - thinking row `✦ 思考 · <first line>`: `compact` emits only `✦ 思考`,
    `verbose` emits the full text (continuation lines indented by 2 spaces);
  - result body: `detailed` shows the first result line, `verbose` the full result,
    both indented by 2 spaces after the step row.
- **Tier density rearranged**: `compact` = group header + `✦ 思考`; `standard` =
  group header + step rows + thinking first line; `detailed` = standard + result
  bodies; `verbose` = **no group header** + step rows (summaries untruncated) + full
  thinking + full result.
- **The step-row rule returns to the dsh tool-row summary**: v0.6.0's
  `describe_tool_call` "<activity phrase>（<liveToolDetail argument detail>）" rule is
  **deleted wholesale**, together with the related activity-phrase / argument-detail
  constants.
- **Group-header category string (`group_title` / dsh `processTitle`)**: categories
  are taken in **descending order of deduplicated occurrence count**; one category
  uses its done wording, two use `A并B` (when both start with "已", the second drops
  the "已"), three are joined with `，`, more than three take the first 3 + `等`, and
  an empty set (no tool steps) = `已完成分析`; thinking does not count towards the
  group-header category string.
- **Close row (`render_turn_close`, word-for-word aligned with dsh
  `TurnProcessNodeView`)**: `▸ 已完成` / `▸ 已完成，用时 <n>秒` / `▸ 处理失败` /
  `▸ 已停止`, one per turn (`turn_end` takes priority, terminal `status` is the
  fallback); the duration floor is 1 second and the wording matches dsh
  `formatRunDuration` (`12秒` / `1分5秒` / `1小时2分3秒`).
- **Narrative / final text no longer has a `📖` prefix and no longer wraps any
  block**: it is raw markdown; `verbose` does not truncate, the other tiers truncate
  non-final text at 120.
- **"`📬` result delivered" loses its frame**: `_format_result_message` becomes a
  `📬 **…**（用时 …）` head row + blank line + the raw result (plain markdown,
  untruncated); over-long content (>8000) goes through **plain-text chunking on line
  boundaries** (`_split_plain_chunks`, with `⏩ 续` between chunks).
- The four bilingual documents (README / CONFIGURATION) are synced to the new
  baseline (dsh row forms, four-tier density table, real samples, layout freeze
  table); `plugin.yaml` and `dashboard/manifest.json` are version-bumped to `0.7.0`.

### Removed

- The `turn_start` `🚀 第 N 轮` row; the terminal `status` rows `✅ 完成` /
  `❌ 失败` / `⚠️ 已取消` (their information is carried by the close row).
- Code-block / fence rendering and fence-aware chunking (the old
  `render_process_box` etc.) — chunking is unified on plain-text line boundaries.
- v0.6.0's `describe_tool_call` step-row rule and its activity-phrase /
  argument-detail constants.

### Fixed

- **At the `compact` tier, a process group (including its header) was dropped
  wholesale when the group had tool steps but no thinking**: member rows are
  collapsed at `compact`, but the group header row must remain visible (matching dsh
  `stepGrouping=collapsed`), and the tools still count towards the group-header
  category string. Before the fix that turn showed only the close row and the tool
  process was not displayed at all.

### Breaking

- **Message shape and count change**: a live stream of one turn with two tool calls
  goes from "`🚀 第 1 轮` + code block + final text + `✅ 完成`" to "process group +
  final text + `▸ 已完成`"; downstream consumers that depend on the old code block /
  `🚀` / `✅` row text must adapt to the new row forms.

### Unchanged

- The three configuration keys (`collector.enabled` / `events` / `live_detail`) and
  the legacy `content` mapping, the historical legacy alias `collector.code_blocks`
  (**deprecated**, always ignored), `follow-dsh` and the priority chain, and the
  Dashboard's three switches and write-back validation are all unchanged; **no
  configuration key is added / removed**.
- Group-send rules (one group per turn, close timing, no group when there is neither
  tool nor thinking), process group before its trigger row, the `redact` flow, stats
  completeness, and forced close-out on terminal states are unchanged.

### Tests

- Test assertions are synced to the v0.7.0 form: dsh row rendering (group header /
  step row / thinking row / result body / close row, four-tier density, plain-text
  chunking), frame-free result delivery, and `turn_start` and terminal status no
  longer producing old rows; new contract cases for "deleted-API regression guard"
  and "panel tier value domain ≡ `consumer.LIVE_DETAIL_MODES`"; the `compact`
  tool-steps-only case now asserts that the group header row is still sent.

## [0.6.0] - 2026-10-10

> **Warning: wording change (form unchanged)**: the per-step summary at the
> `standard` tier changes from the bridge-side "raw command / plain-language phrase"
> heuristic rule table to **word-for-word dsh activity descriptions** —
> `<dsh activity phrase>（<dsh argument detail>）`, e.g. `执行命令（df -h）`,
> `读取文件（config.yaml）`, `搜索代码（TODO）`. **The out-of-frame form is exactly as
> in v0.5.x**: the tool steps and thinking of one turn are still closed into **one**
> language-tag-free code block (one frame per group), while narration / final text /
> terminal rows are still each sent on their own; **no configuration key is added**.
>
> **Withdrawn (item B cancelled)**: a B form ("one code block for the whole task,
> zero pushes during the process") was implemented per an early plan and briefly
> entered this file's version history; the administrator judged it **cancelled** —
> the correct form is **one group of tool calls = one frame** (one frame per group,
> process pushed in real time) plus **one reply = one frame** (the `📬` result
> delivery: head row + bare-fenced body), each in its own frame and never merged.
> This version ultimately contains only item A; the complete B form is preserved for
> reference in tag `backup-b-before-revert-1010` (`5553b54`) and did **not** enter
> the release form.

### Changed

- **Step rows aligned with dsh (item A)**: at the `standard` tier the per-step row
  changes from "`tool name · <raw command summary>`" to
  "`tool name · <dsh activity description>`". The activity description = the dsh
  activity phrase + the dsh `liveToolDetail` argument detail:
  - the activity phrase comes from the zh stem of dsh
    `message.stepProcess.<kind>` (读取文件 / 读取图片 / 写入文件 / 搜索代码 / 修改文件 /
    执行命令 / 运行代码 / 搜索网页 / 访问网页 / 协调子智能体 / 更新计划 / 提问 /
    调用工具), and the tool name → kind mapping keeps dsh's original `activity()`
    table (`tool_activity_kind` unchanged);
  - the argument detail takes the first non-empty value in dsh
    `LIVE_TOOL_DETAIL_KEYS` key order
    (`title > description > objective > task > … > command > … > query > path … >
    status`; `questions` takes the first question), with whitespace collapsed and
    truncation at 160 characters with `…` appended;
  - when no argument detail can be taken, it **falls back to the tool name itself**
    (dsh `normalizeLiveToolDetail(name)`'s fallback), so a plain string argument
    (e.g. `"ls -la"`, not an argument object) renders as `执行命令（bash）` rather
    than a bare phrase;
  - no tool name and no detail → an empty string (the caller degrades to a
    placeholder row).
  - **The bridge-side heuristic rule table is deleted wholesale**:
    `summarize_tool_call` / `_tool_argument_text` / `_first_command_word` /
    `_summary_positional` and the `_SUMMARY_*` constants (fixed phrases such as
    "检查磁盘使用" "列出目录" "查看 git 提交记录" and the first-command-line truncation
    fallback) are all removed, and summaries no longer depend on the raw command;
    new pure functions `dsh_activity_phrase` / `dsh_activity_detail` (with
    `_arguments_object` / `_normalize_activity_detail` / `_question_detail`) and
    `describe_tool_call` are added.
- The `detailed` / `verbose` tiers still show the raw arguments (`{"path": …}`) and
  the `↳` result row; only `standard` changes. `compact` still has only the group
  header + thinking label.
- The documents (README / CONFIGURATION, both languages) and the samples are synced
  to the "dsh activity description" rule; `plugin.yaml` and
  `dashboard/manifest.json` are version-bumped to `0.6.0`.

### Unchanged

- **Out-of-frame form**: the tool steps / thinking of one turn are closed into
  **one** language-tag-free code block (one frame per group); the close timing
  (`turn_end` / terminal / final / a new `turn_start`), the empty-frame rule,
  thinking folded into the frame, the group-header category string
  (`工作步骤 · N 步 · <类别串>`) and dsh `processTitle`'s word-for-word algorithm,
  `_split_fenced_chunks` fence-aware chunking, and the `redact` flow are all
  unchanged;
- narration / final text / terminal rows are still each their own message (**not**
  "one frame for the whole task");
- the three configuration keys (`collector.enabled` / `collector.events` /
  `collector.live_detail`), `follow-dsh` and the priority chain, and the Dashboard's
  three switches and write-back validation are all unchanged.

### Tests

- Measured **227 passed, 119 subtests passed**.
- Existing assertions updated: the `standard` per-step row changes from the
  "plain-language summary" to the dsh activity description (word-for-word assertions
  on in-frame step rows in `test_consumer` / `test_group_push` / `test_real_stream`,
  including the case where the real frame's `description` takes priority over
  `command`).
- New: every entry of the activity-phrase table plus coverage of all dsh
  `message.stepProcess` kinds (asserting the "正在/准备/已/了" aspect markers have been
  stripped), key order with `description` first, `questions` taking the first
  question, merging of all-string arrays, truncation at 160 characters, non-JSON
  arguments falling back to the tool name (`执行命令（bash）`), and an empty
  name/detail returning an empty string.

## [0.5.3] - 2026-10-10

> **Warning: style change (behaviour unchanged)**: the "`📬` result delivered" body for
> a completed task changes from a **plain message** to a **bare-fenced code block**,
> for a form consistent with the live-stream process frame. The delivery timing, the
> completeness of the body (**untruncated**), the redact flow, the "`📬`" head row and
> the failure retry are all unchanged; **no configuration key is added** —
> `code_blocks` has been an internal style parameter since v0.3.0 (neither the
> v0.5.0 nor the v0.5.2 form change added a key either). To return to the v0.5.2
> plain-text appearance: change `_deliver_final_result`'s
> `make_sender(_CTX, code_blocks=True)` back to `code_blocks=False` and make
> `_format_result_message` return `final_text` directly (without calling
> `_box_result_body`).

### Changed

- **Result delivery becomes a code block**: `_format_result_message` uses
  `consumer._fence` (**the same source** as the live-stream frame) to wrap the result
  body in a **bare fence** (empty info string, no language tag). The head row
  `📬 **dsh 任务完成，结果如下**（用时 …）` stays **in front of** the frame — matching
  the live stream's "`📖 输出完成` row + frame" arrangement; status / elapsed time is
  metadata and does not go inside the monospace frame.
- **Chunking becomes fence-aware**: `_deliver_final_result`'s sender changes from
  `code_blocks=False` to `True`, so long results (>8000) go through the existing
  `_split_fenced_chunks` — chunks are joined with `⏩ 续` and **each chunk's fence is
  closed**, so a broken frame can no longer be cut out.
- **The body stays complete**: untruncated (only trailing newlines are stripped);
  inner triple backticks in the body are escaped (a zero-width space U+200B is
  inserted between two backticks) so the outer fence cannot be closed early; with no
  text output there is still only the head row and **no empty frame is sent**.
- The four bilingual documents (README / CONFIGURATION) are synced to the result
  delivery rule, stating the reason for **not adding a configuration key** and the
  one-line rollback; the `code_blocks` / `_split_plain_chunks` comments in
  `consumer.py` are synced too (both production paths use fence-aware chunking).
- `plugin.yaml` and `dashboard/manifest.json` are version-bumped to `0.5.3`.

### Unchanged

- The delivery timing (sent as soon as the task completes), the three states of the
  `📬` head row, the redact flow, and "retry once then only log a warning";
- the four live-stream densities, the code-block group layout, `follow-dsh` and the
  priority chain, and the Dashboard's three switches (`enabled` / `events` /
  `live_detail`) and write-back validation are all unchanged.

### Tests

- Measured **229 passed, 83 subtests passed** (227 passed in v0.5.2).
- Existing assertions updated: the live-stream and result-delivery senders both use
  `code_blocks=True`; result-message assertions change from "head row + full text" to
  "head row + full text inside a bare-fenced frame" (`test_override` /
  `test_hot_read`).
- New: the result is delivered as a **bare-fenced code block** (no language tag,
  inner fences escaped, only one fence pair left in the whole text); a long result is
  untruncated and, after fence-aware chunking, every chunk's fence is closed in pairs
  (the frame does not break).

## [0.5.2] - 2026-10-09

> **Note: cosmetic tweak (behaviour unchanged)**: two appearance adjustments — the
> code-block group's **group header** and its **fence language tag**. Live content,
> tier density, close timing and message counts are all unchanged.

### Changed

- **Group-header wording**: `工具 · <N> 步 · <类别串>`
  → **`工作步骤 · <N> 步 · <类别串>`** (for example:
  `工作步骤 · 8 步 · 执行了命令`). "工具" only covers tool
  calls whereas the frame also contains thinking sections, and the live tiers are
  aligned with the Chinese wording of the dsh setting "工作步骤展示（Work details）"
  (`settings.transcript.title`) anyway, so the same term is now used to match the dsh
  UI users see.
- **The fence drops its language tag**: the code-block group changes from
  ```` ```text ```` to a **bare triple-backtick fence**. Feishu code blocks display
  the fence info string as a language name in the top-left corner, so `text` would
  expose a meaningless "text" label; with no language specified the client shows no
  language name, and the form matches the operation-output frame (`📖` goes through
  `_fence`'s default language-free fence). On the Feishu side the fence info slot is
  a "programming language parsing" slot that cannot carry free-form copy, so a custom
  word such as "工作步骤" was **not** used (also: if it matched the group header, the
  frame corner and the first line would repeat).
- The four bilingual documents (README / CONFIGURATION) and the samples in
  `SAMPLES.md` are synced: group-header wording, bare-fence explanation, four-tier
  example rendering.
- `plugin.yaml` and `dashboard/manifest.json` are version-bumped to `0.5.2`.

### Unchanged

- The four densities (`compact` / `standard` / `detailed` / `verbose`), the close
  timing, the empty-frame rule, chunking and fence closure, terminal / error /
  `final_text` delivery, and `follow-dsh` and the priority chain.

## [0.5.1] - 2026-10-08

> **Warning: behaviour fix (must read before upgrading)**: fixes the case where
> **live streaming did not start at all (zero messages)** when the caller **carried
> an explicit `context_id`**. The root cause was that `pre_tool_call` **returned
> early** upon seeing an explicit `context_id` / `contextId` (neither intercepting
> nor injecting), cutting the whole live-stream chain; v0.5.1 instead uses that value
> as the **live-stream origin** and intercepts as usual. **Trade-off**: such calls go
> from **synchronous** to **asynchronous** (an instant "⏳ 已受理" receipt → background
> execution + process live streaming → the result delivered to this conversation when
> done); the caller's `context_id` is **adopted verbatim and never overwritten**, so
> messages still land in the same conversation. Note also: **v0.5.0's "code-block
> group" form itself is fine** and this release does not change rendering.

### Fixed

- Fixes live streaming producing zero messages with an explicit `context_id`: the
  early `return None` in `pre_tool_call` on seeing an explicit `context_id` /
  `contextId` is removed. **The interception condition is unchanged** —
  `tool_name == "a2a_call"` + `collector.enabled` true + the target is dsh + a
  non-empty `message`; **the origin becomes "the caller's explicit `context_id`"
  first, otherwise the current messaging-surface origin**
  (`{platform}/{chat_id}[/{thread_id}]`); only when both are empty is the call not
  intercepted and passed through unchanged. The explicit value is **adopted verbatim
  and never overwritten**, and the dsh-side session reuse key is unchanged.

### Changed

- dsh calls carrying an explicit `context_id` go from **synchronous** to
  **asynchronous** (v0.5.1 behaviour), matching calls without an explicit
  `context_id`: an instant "⏳ 已受理" receipt, background streaming execution with
  process live streaming, and the "`📬` dsh 任务完成，结果如下" result delivered to this
  conversation when done. This is required for live streaming and is the trade-off of
  this fix (previously an explicit `context_id` went through the original synchronous
  `SendMessage` with no live stream).
- The four bilingual CONFIGURATION / README documents are synced with the behaviour
  and trade-off of "an explicit `context_id` as the live-stream origin", the
  interception condition, and a troubleshooting subsection for "why does a
  conversation have no live-stream messages" (intercepted → the "⏳ 已受理" receipt
  and `Tool a2a_call returned error {"error":"[dsh · context …`; not intercepted →
  `tool a2a_call completed (…s, … chars)`).
- `plugin.yaml` and `dashboard/manifest.json` are version-bumped to `0.5.1`.

### Unchanged

- **v0.5.0's "code-block group" rendering form is unaffected**: this release does not
  touch rendering — the four forms, frame-send rules, forced close-out on terminal
  states and stats rules are all unchanged; the v0.5.0 form itself passed triple
  verification (a local real-frame reproduction of 10 events → 5 messages; production
  run `events_seen=10`, `messages_sent=4`, matching).
- Calls without an explicit `context_id` are unchanged; `collector.enabled` off, a
  non-dsh target, and a non-messaging surface still do not intercept (only the
  original origin injection applies).
- The instant acceptance receipt and the "`📬` completion message + full result
  text" delivery are unchanged; `collector.events: false` still **takes priority over
  the tier**.

## [0.5.0] - 2026-10-08

> **Warning: behaviour change (must read before upgrading)**: all four tiers change
> to **"one code-block group per turn"** — the tool steps and **settled thinking are
> folded into the same code block** (group header `工具 · N 步 · <类别串>` + step rows
> + a trailing `思考 · …` section), as **one group of one message**. v0.4.1's
> `standard` heartbeat / close rows are **gone**, and `detailed` / `verbose` **no
> longer** send tool rows one by one; **use a higher tier if you want finer in-frame
> density** (`detailed` with arguments + the first result line, `verbose` with
> arguments / results and full thinking, untruncated). A turn with neither tool steps
> nor thinking **sends no frame**; thinking-only with no tools sends a frame
> containing only the thinking row.

### Changed

- **All four tiers unify on the "code-block group" rendering form**: one turn = one
  frame = one message (the tool steps and thinking accumulated between `turn_start`
  and that turn's close). Group-header row `工具 · <N> 步 · <类别串>` (`N` = the
  number of tool steps in the turn; **no turn number**, because a separate
  `🚀 第 N 轮` marker already appears above; the category string keeps dsh
  `processTitle`'s word-for-word algorithm: one category as-is / two joined with
  "并" and dropping the second "已" when both start with "已" / three with "，" /
  more than three with "等" appended); the separator is a fixed 30 `─` (only present
  when there are step rows); step rows
  `<i>. <tool name> · <that tier's arguments/summary>`; result rows `↳ <result>`
  (indented 3 spaces, `detailed` / `verbose` only); the trailing section
  `思考 · <preview or full text>` (`compact` shows only "思考", no preview, and no
  step rows).
- **Four-tier density** (keeping each tier's existing definition): `compact` is only
  the group header + a "思考" label; `standard` is the group header + plain-language
  step summaries (no result rows); `detailed` is the group header + step arguments
  (truncated) + the first result line (truncated); `verbose` is the same as
  `detailed` but with **arguments and results untruncated** and full thinking.
- **Frame-send rules**: one frame per turn; **no frame when there is neither a tool
  step nor thinking** (avoiding an empty frame — this is how "a tier would be empty
  in this form" is handled); **thinking-only with no tools sends a frame containing
  only the thinking row**; the frame is sent **before** the narrative `text` /
  terminal row that triggers it; an over-long frame is chunked by the existing
  mechanism (`_split_fenced_chunks`, limit 8000) and **the fence stays closed**; the
  frame buffer is force-closed at `turn_end` / a terminal state.
- **Corresponding to dsh's grouping semantics**: thinking is a **member of the
  group** (dsh `groupPart: "reasoning"`), hence it shares the frame with the tool
  steps (an explicit trade-off: one collapse reveals the whole process, at the cost
  of expanding a frame even to read only thinking); the group-header category string
  keeps dsh `processTitle`'s word-for-word algorithm (`thinking` does not enter the
  category string; its presence is shown by the trailing "思考" section).
- **Compatibility rule**: the four tiers' existing definition in terms of **content
  density** is unchanged (`detailed` still corresponds to the old `content: true`
  information amount, `compact` is still stricter than the old `content: false`), but
  **v0.5.0 changes the rendering form** — `detailed` / `verbose` **no longer** send
  messages one by one and are **no longer** byte-equivalent to v0.3.3's
  `content: true`; the difference is only in-frame density.
- `plugin.yaml` and `dashboard/manifest.json` are version-bumped to `0.5.0`.

### Unchanged

- **Terminal states and errors are unaffected at any tier**: the task terminal state
  (`✅` / `❌` / `⚠️`), error messages, `final_text` delivery and stats completeness
  (`events_seen` / `messages_sent` etc.) are unchanged.
- **`follow-dsh` and the priority chain are unchanged** (explicit tier >
  `follow-dsh` > legacy `content` > default); the legacy `content` mapping is
  unchanged (`true` → `detailed`, `false` → `standard`).
- `collector.events: false` (quiet mode) still **takes priority over the tier**.
- The instant acceptance receipt and the "`📬` completion message + full result
  text" delivery are unchanged.

### Tested

- The existing baseline does not regress; the affected existing assertions were
  updated, and new ones added for the four-tier frame layout line by line, the
  empty-frame rule, thinking-only without tools, fence closure after chunking,
  forced close-out on terminal states, and in-frame density differences (`compact`
  with no step rows / `standard` with no result rows / `detailed` with result rows /
  `verbose` untruncated). Four-tier samples and a comparison against the v0.4.1 form
  are in `SAMPLES.md` (replaced by the implementation track with real run output).

## [0.4.1] - 2026-10-07

> **Warning: behaviour change (must read before upgrading)**: the `standard` tier
> **no longer pushes tool steps one by one** and switches to **step-group pushing** —
> each turn closes into **one** settled-state row (such as
> `🔧 已读取文件并搜索代码`), and long tasks append one heartbeat row every **6
> steps**: `🔧 正在执行 · 第 N 步 · <最近一步摘要>`; `thinking` is **folded into the
> step group and no longer pushed separately** (the `🧠 思考中…` row no longer
> appears; its presence is shown by the close-out title "已完成分析"). The default is
> `follow-dsh` and the dsh in production today is `standard`, so **after upgrading
> the default appearance is group pushing** (less screen spam than v0.4.0).
> **Use `detailed` / `verbose` if you want per-step rows**: set
> `plugins.entries.hermes-a2a-bridge.settings.collector.live_detail` to `detailed`
> (with arguments / output code blocks) or `verbose` (additionally untruncated
> non-final narration) to restore per-step output.

### Changed

- **The `standard` tier switches to group pushing**: the grouping unit = one turn
  (`turn`); `tool_call` / `tool_result` are no longer sent one by one and only enter
  the group buffer; **`thinking` is folded into the group** (not its own row, not
  counted in heartbeat steps), and a turn with only thinking closes with the title
  "已完成分析". **Heartbeat**: every full 6 accumulated steps inside the group send
  one open-state row `🔧 正在执行 · 第 N 步 · <最近一步摘要>`; **close-out**: at
  `turn_end`, a terminal `status`, final `text` (defensively) or a turn switch, the
  turn's group is closed into one settled-state row `🔧 <activity-kind title>`; if the
  same turn keeps producing tool steps after a close, a new segment starts.
  **Order**: the group row is sent before the narrative `text` / terminal row / new
  turn's `turn_start` that triggers it. **The close-out title is word-for-word
  aligned with dsh `processTitle`**: take the top-3 categories — one as-is, two with
  "并" (dropping the second "已" when both start with "已", e.g.
  `已读取文件并搜索代码`), three joined with `，`, more than three with "等" appended
  (without a count). The activity-kind mapping switches to dsh's `activity()`
  **original table** (`read` / `read_image` / `grep`·`glob`·`*_inspect` / `write` /
  `edit`·`apply_patch` / command tools such as `bash` / `run_code` / `web_search` /
  `web_fetch` / `subagent*` / plan types / question types; unknown tools fall back to
  `tools` → "已调用工具"); bridge-side extensions `spawn_teammate` /
  `send_message` / `wait_agent` / `list_agents` / `interrupt_agent` / `team_task_*`
  map to `subagents`. The full mapping table is in CONFIGURATION's "activity kind
  vocabulary" and "group pushing rules".
- **Tiers whose content is unchanged are unaffected**: `compact` (no tool rows),
  `detailed` (per-step + arguments / result code blocks), `verbose` (same as
  `detailed` with non-final narration untruncated) are unchanged word for word;
  `follow-dsh` and the priority chain (explicit tier > `follow-dsh` > legacy
  `content` > default) are unchanged.
- **The legacy `content` mapping is unchanged, but the appearance follows the tier**:
  `true` → `detailed` (appearance unchanged), `false` → `standard` (which also
  becomes group pushing after the upgrade). For per-step output, set
  `collector.live_detail: detailed` explicitly.
- **Small summary improvement (`standard` tier)**: when a tool's `arguments` is an
  object with no command key, the summary prefers the `key=value` of identifying keys
  (`job_id` → `id` → `name` → `path` / `file_path` → `query` → `url`), and still
  falls back to truncated single-line JSON when there is none; `detailed` /
  `verbose` use the raw text and are unaffected.
- The four bilingual CONFIGURATION / README documents are synced with a new
  "intermediate event push density" section, the "close-out title composition
  rules", and the "activity kind vocabulary", stating the difference from dsh (dsh's
  group header can be updated in place whereas the bridge can only append and never
  update, so the equivalent is implemented as "one close row per turn + one heartbeat
  every 6 steps" — a design trade-off, not a defect).

### Unchanged

- **Terminal states and errors are unaffected at any tier**: the task terminal state
  (`✅` / `❌` / `⚠️`), error messages, `final_text` delivery and stats completeness
  (`events_seen` / `messages_sent` etc.) are unchanged.
- **The group buffer is always force-closed on a terminal state**; step information
  that already happened is never dropped.
- `collector.events: false` (quiet mode) still **takes priority over the tier**.
- The instant acceptance receipt and the "`📬` completion message + full result
  text" delivery are unchanged.

### Tested

- The existing baseline (v0.4.0's 177 items) does not regress; new `standard`
  group-pushing cases were added (per-event assertions that `thinking` is folded into
  the group and is not its own row, heartbeats, close-out, and the ordering with
  `text` / `turn_end` / terminal states), plus activity-kind mapping and close-out
  title composition (1 / 2 / 3 / >3 categories), forced group-buffer close-out on
  terminal states, no regression for `compact` / `detailed` / `verbose`, and the small
  summary improvement (see CONFIGURATION's "unit tests").

## [0.4.0] - 2026-10-07

> **Warning: behaviour change (must read before upgrading)**: live-stream progress
> display gains four tiers, with **`follow-dsh` as the default** (following dsh's
> "工作步骤展示 / Work details"). The dsh in production today uses `standard` for Work
> details, so **after upgrading the live stream is terser than v0.3.3 by default** —
> tool rows keep only "tool name + plain-language summary" and tool output keeps only
> a completion marker, with no more argument / output code blocks.
> **One-line rollback**: set
> `plugins.entries.hermes-a2a-bridge.settings.collector.live_detail` to `detailed` to
> restore the v0.3.3 appearance.

### Added

- The live tier `collector.live_detail` (default `follow-dsh`): `follow-dsh` /
  `compact` / `standard` / `detailed` / `verbose` (follow dsh / terse / standard /
  detailed / fully expanded), **one-to-one** with dsh's four "工作步骤展示（Work
  details）" tiers. Four-tier rendering (per event): `compact` sends no tool rows and
  no thinking rows; `standard` keeps only "tool name + summary" on tool rows and only
  a completion marker for results (≡ the old `content: false`); `detailed` carries
  argument / output code blocks, untruncated (≡ the old `content: true`); `verbose`
  differs from `detailed` only in that **non-final narrative text is untruncated**.
  See CONFIGURATION's "live tiers" section.
- `follow-dsh` resolution: reads the `- id: ui-chat` entry of
  `<dsh_home>/profiles/<dsh_profile>/cordis.patch.yml` → `config.transcriptView` (a
  **YAML entry array**, not a dotted path); dsh's old values `normal` / `expanded`
  are both read as `detailed`. Any failure (missing file / broken YAML / no `ui-chat`
  entry / no such key / invalid value) **falls back to `detailed`** and logs once,
  without raising or blocking the task. New optional keys `collector.dsh_home`
  (default `/home/artom/.dsh`) and `collector.dsh_profile` (default `web`).
- The third row of the Dashboard's "A2A live switches" changes from a boolean switch
  to a **live-tier dropdown** (5 options, with paired Chinese/English copy);
  `GET /collector` echoes the current value and, for `follow-dsh`, the **tier
  actually in effect**; POST validation accepts that string enum and rejects invalid
  values.

### Changed

- **Default live-stream granularity changes**: when neither `live_detail` nor the
  legacy `content` is set, the default is `follow-dsh` (v0.3.3's appearance
  corresponds to `detailed`). The dsh in production today = `standard`, so after
  upgrading the default is terser; see the note above for the rollback.
- Backward compatibility: the legacy `collector.content` keeps working (`true` →
  `detailed`, `false` → `standard`, exactly preserving v0.3.3 behaviour); **when
  `live_detail` is unset but `content` is set explicitly, the `content` mapping is
  kept**, so existing deployments behave unchanged — only when both are unset does it
  follow dsh automatically.
- `collector.events: false` (quiet mode) still **takes priority over the tier**;
  `compact` is stricter than the old `content: false` (it sends neither tool rows nor
  thinking rows). Stats completeness, the instant acceptance receipt and the `📬` final
  result delivery are all unaffected by the tier.
- The four bilingual CONFIGURATION / README documents are rewritten in sync: the
  "content switch (boolean)" section becomes "live tiers (four tiers)", and the
  Dashboard description becomes three switches (`enabled` / `events` /
  `live_detail`).

### Deprecated

- The configuration key `collector.content` (boolean) is removed from the Dashboard
  UI (the third row becomes the `live_detail` dropdown) but **stays compatible at the
  configuration layer**: `true` → `detailed`, `false` → `standard`, and the mapping
  is preferred when `live_detail` is unset. Migrating to `collector.live_detail` is
  recommended; keeping the key raises no error and has no side effect.

### Tested

- The existing **147-item** baseline (see 0.3.3) does not regress; on top of it this
  release adds four-tier rendering (per-event assertions), the legacy `content`
  mapping, `follow-dsh` resolution and **all fallback branches** (missing file /
  broken YAML / no `ui-chat` entry / no key / invalid value / old values
  `normal`·`expanded` normalised), and cases for "terminal states and errors are
  never lost at any tier".

## [0.3.3] - 2026-09-30

### Changed

- The content switch's `tool_call` becomes a "short summary" (the administrator's
  final trade-off): with `content=false` the command is no longer hidden completely;
  instead `🔧 \`name\` · <summary>` is rendered — a rule-table hit gives a fixed
  plain-language phrase (git log / file read / grep / df / free / du / systemctl /
  ls / ps), and a miss truncates the command's first line to about 50 characters as a
  fallback; `content=true` (the default) still shows the full command / argument code
  block. `tool_result` is still a completion marker and text/thinking are still the
  operation stream (unaffected).
- Content-switch boundary corrected (the administrator's final clarification):
  `content=false` only disables **detail inside an operation** (a tool call's
  arguments / command body, a tool output's body) and **no longer disables the
  operation stream** — `text` (narration / explanation, including final) and
  `thinking` are rendered again, the same as with `content=true`; the narrowing of
  `tool_call` to just the tool name and `tool_result` to just a completion marker
  stays. The acceptance receipt, `📬` final result delivery, start/end markers and
  stats completeness are all unchanged.

### Fixed

- Content-switch rule corrected (the administrator's clarification): with
  `content=false` a tool call **shows only the tool name** (`🔧 \`name\``) and **no
  longer carries arguments / a command body** (hence no argument code block); when
  the tool name is missing, the copy falls back to `🔧 调用工具`. Completion markers
  (`📋 \`name\` 完成`), start/end markers (`turn_start` / terminal `status`), stats
  completeness, the instant acceptance receipt and `📬` final result delivery are all
  unaffected; `content=true` (the default) keeps its appearance.

### Tested

- **147 unit tests**: `test_consumer` 78, `test_origin_injection` 12,
  `test_override` 19, `test_hot_read` 10, `test_dashboard_api` 28.

## [0.3.0] - 2026-09-29

### Added

- Dashboard extension surface: an "A2A 直播开关 / A2A live switches" card at the top
  of the plugins page (`dashboard/manifest.json` + a hand-written IIFE front end +
  a `dashboard/api.py` back end), with three switches (live master switch /
  intermediate event push / content display) that can be clicked; the back end's
  `GET/POST /api/plugins/hermes-a2a-bridge/collector` validates strictly (booleans
  only, extra keys rejected) before writing back to
  `plugins.entries.hermes-a2a-bridge.settings.collector.*`, preserving the entry's
  top-level `allow_tool_override` and all other keys; the panel also registers the
  hidden route `/hermes-a2a-bridge` as a fallback, and the bilingual copy follows the
  page language.
- Hot reading of the three switches: the read point becomes `ctx.get_config` on every
  call (Hermes' config reader caches by file mtime signature), so a Dashboard
  selection or a config.yaml edit takes **effect immediately, with no gateway
  restart**; the module-level global is kept as the default / unit-test fallback
  value.
- The content switch `collector.content` (default true): when off, the intermediate
  live stream **shows only tool calls** — `text` (including final) and `thinking` are
  not pushed, `tool_result` keeps only the `📋 \`name\` 完成` completion marker
  (without the output body), and start/end markers such as `turn_start` / terminal
  `status` are kept; stats (`final_text` / `events_seen` / `states`) are still
  counted completely, and `📬` final result delivery is unchanged. It is hot-read at
  the same level as `events` (read once when a streaming task starts).

### Changed

- The "code-block rendering" switch is replaced by a "content switch": the panel's
  third row becomes "content display"; code-block rendering is demoted to an
  **internal style** of content display (`render_line`'s `code_blocks` parameter,
  fence-aware chunking and plain-text chunking are kept, and the live path is fixed
  at `code_blocks=True`), no longer configurable.
- The collector switch set becomes `enabled` / `events` / `content`; the dashboard
  GET/POST and the front-end panel are updated in sync.
- The "live consumer" section of CONFIGURATION / README is updated to "editable in
  the Dashboard, effective immediately after the change (hot read)", with added notes
  on Dashboard panel deployment (one dashboard process restart is needed after an
  upgrade) and on content-switch semantics (including ignoring the old key and the
  unchanged `📬` delivery).

### Deprecated

- The configuration key `collector.code_blocks` is deprecated and **always ignored**
  (not read, no error, no migration, not used as a fallback — the old false semantics
  were plain text rows, and using it as a fallback would silently disable all
  content, which would be a wrong migration); a leftover key in a config file has no
  side effect. POST `/collector` tolerates it as a deprecated alias of `content` (so
  an old panel already open during the upgrade window does not error), and GET never
  returns the key.

### Tested

- 135 unit tests: `test_consumer` 69 (including content-switch rendering and
  orchestration), `test_origin_injection` 12, `test_override` 17, `test_hot_read` 10
  (hot reading, including content and ignoring the leftover old key),
  `test_dashboard_api` 27 (back-end validation and write-back, including the old
  key's deprecated alias).

## [0.1.1] - 2026-09-15

### Changed

- Single execution becomes asynchronous: the pre_tool_call callback immediately
  starts a background thread that streams and returns an instant "已受理" receipt
  instead of waiting synchronously for the task; when the task ends, the final result
  is pushed proactively to the messaging surface as a plain message (a head row with
  status and elapsed time + the full result text, chunked as plain text), and there
  is no more silence after "completion".

### Fixed

- Fixes the cascading failure of long tasks (exceeding the framework's 30-second hook
  callback limit): the synchronous wait failed closed after the 30-second timeout,
  which ① left the final result with no receiver so it was lost (requiring manual
  recovery afterwards every time) and ② while the callback worker had not exited,
  hook checks of other tool calls were skipped in a cascade (all tools on the site
  were rejected for over ten minutes). After making it asynchronous the callback
  returns instantly and both classes of problem disappear.

## [0.1.0] - 2026-09-12

### Added

- origin→contextId injection: inside the `pre_tool_call` hook, a stable session token
  `{platform}/{chat_id}[/{thread_id}]` is shallow-merged into `message.contextId`,
  giving "one Hermes conversation session ↔ one dsh session" context continuity.
- pre_tool_call single execution: for an `a2a_call` targeting dsh only one
  `SendStreamingMessage` is sent, consuming the SSE while live streaming, and the
  final text is returned with block semantics, eliminating double execution; the
  unreliable `register_tool(override=True)` approach is dropped.
- Live consumer: line-by-line SSE parsing, event normalisation, T0 row language
  rendering, throttling (high-signal per event / low-signal text aggregation),
  sensitive-information redaction, and adapter sending scheduled through the gateway
  main loop.
- Code-block rendering: tool commands / execution results / long final text are
  output as code blocks, while short text stays a plain row.
- Long text chunked on code-block boundaries: content above the gateway's single
  message limit is split on code-fence boundaries, with `⏩ 续` between chunks, so a
  code block never breaks across chunks.
- Live-send gating `collector.enabled` (off by default).
- Configurable code-block rendering: `collector.code_blocks` (default true) — when
  false, live content falls back to plain text rows (no fence, no fence escaping)
  and long text goes through ordinary line-boundary chunking (still with the `⏩ 续`
  marker).
- The event-stream switch `collector.events` (default true) — false is quiet mode:
  only the final result / completion card is pushed, intermediate events are not; it
  is orthogonal to `code_blocks`.
- A bilingual README (README.md + README.en.md), including a results showcase
  section.

### Changed

- The streaming timeout now reads the peer config `a2a_agents.dsh.timeout` (falling
  back to 300 seconds when absent).
- README streamlined and restructured: the README keeps only the introduction /
  results showcase / flow diagram / installation instructions / links, and the
  configuration and mechanism details move into a separate CONFIGURATION.md (and
  CONFIGURATION.en.md).

### Fixed

- Fixes the early P2c double-execution problem: no second streaming message is sent
  from a separate background thread, and the task runs only once.

### Security

- The project is distributed under GPL-3.0 (LICENSE added); this project is an
  independent, self-developed plugin.

### Tested

- 84 unit tests: `test_consumer` 58, `test_origin_injection` 12, `test_override` 14.
