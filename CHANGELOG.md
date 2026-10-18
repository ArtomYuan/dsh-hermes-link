# CHANGELOG — dsh-hermes-link

> 自 0.10.0 起，本文件是**唯一账本**（双语小节）。两包内的 CHANGELOG 保留为历史
> （0.9.0 / 0.7.0 及更早），0.10.0 起变更记在这里。

## [0.10.0] - 2026-10-19

### 中文

**合并**：`hermes-a2a-bridge`（0.9.0）与 `dsh-a2a-server`（0.7.0）合成一个产品
（仓库 `dsh-hermes-link`，两树带完整历史落 `hermes/`、`dsh/`）。**两个包名与安装路径不变**，
两半仍是两个进程，A2A 缝不动。

- **协议单一来源**：`protocol/link-protocol.json`（metadata 键 / 沙箱档 / 事件类型 /
  提问作答载荷 / 卡片字段 / 终态 / 版本）→ `protocol/gen.py` 生成
  `hermes/link_protocol.py` 与 `dsh/src/link-protocol.ts`；`--check` 防漂移。两端常量改由
  协议提供，**行为零变化**（值逐字相同）。
- **共享契约测试**：`tests/contract/fixtures/` 五件，Python（20 断言）与 Node（9 断言）
  各跑一遍、对同一份期望；覆盖请求级选项（名字/路径）、提问载荷、作答报文、失败状态。
- **§2.2 首选定 + §2.3 绑定记忆落服务端**：新增 `dsh/src/link-binding.ts`——对话级绑定
  账本（`a2a-link-state.json` 独立文件）、首选定两题（工作区选项去重/重名后缀/上限 8；
  沙箱三档）、作答→绑定、**显式 > 绑定 > 缺省**。服务端在对话首投、未显式带参、且调用方
  声明问答能力时发选择卡；跳过记 `answered`、投递失败不记账、异常回落缺省（**不卡任务**）。
  新增配置 `a2a-server.firstUseSelection: off|ask`（默认 `off`＝现状）。
- **版本单号锁步**：`hermes/plugin.yaml` = `dsh/package.json` = agent-card = **0.10.0**；
  agent-card 增加链路协议扩展声明（`params.linkProtocolVersion`）。
- **安装器**：`scripts/install.sh`（版本配对 → 装服务端 → agent-card 握手门禁 → 装桥；
  幂等、`--dry-run`/`--force`/`--server-only`/`--bridge-only`）、`scripts/uninstall.sh`
  （**反序**恢复最近备份）、`scripts/verify.sh`（版本握手 + 8091 健康 + 飞书连接 + 协议
  漂移）、`scripts/test-all.sh`（一处跑全测）。脚本**只落位文件、不重启服务**。
- **文档合并**：根 `README.md` / `CONFIGURATION.md` / 本 `CHANGELOG.md`；两包内文档保留为
  细节参考。
- **Hermes 参数面**（源码树补丁）：`plugins/platforms/a2a/tools.py` 的 `a2a_call` 增加可选
  `workspace` / `sandbox`（含工具描述与 schema 断言测试），登记于
  `~/.hermes/docs/hermes/custom-patches.md`。

**验收**：桥 394/394、服务端 109/109（新增 6 例绑定/首选定）、契约 20+9、协议 `--check`
通过、安装器 dry-run 通过。**待宿主侧**：真实安装 + 重载 + 实弹三连 + 回退演练。

### English

**Merge**: `hermes-a2a-bridge` (0.9.0) and `dsh-a2a-server` (0.7.0) become one product in the
`dsh-hermes-link` repository (both trees with full history under `hermes/` and `dsh/`).
**Package names and install paths are unchanged**; the two halves remain two processes
speaking A2A.

- **Single protocol source**: `protocol/link-protocol.json` → `protocol/gen.py` generates
  `hermes/link_protocol.py` and `dsh/src/link-protocol.ts` (`--check` guards drift). Both ends
  now read their constants from it; **behaviour unchanged** (values are identical).
- **Shared contract tests**: five fixtures under `tests/contract/fixtures/`, run by Python
  (20 assertions) and Node (9 assertions) against the same expectations — request-level options
  (name/path), question payload, answer message, failure status.
- **§2.2 first-use selection and §2.3 binding memory moved to the server**: new
  `dsh/src/link-binding.ts` — per-conversation binding ledger (`a2a-link-state.json`, a separate
  file), the two first-use questions (workspace options deduped/duplicate-title-suffixed/capped
  at 8; sandbox three tiers), answer → binding, and **explicit > binding > default** precedence.
  The server asks on a conversation's first delivery when the caller declared question support
  and passed no explicit options; a skip records `answered`, a delivery failure records nothing,
  and any error falls back to the default (**never blocks the task**). New setting
  `a2a-server.firstUseSelection: off|ask` (default `off` = today's behaviour).
- **Lock-step versioning**: `hermes/plugin.yaml` = `dsh/package.json` = agent card = **0.10.0**;
  the agent card now advertises the link protocol (`params.linkProtocolVersion`).
- **Installer**: `scripts/install.sh` (version pairing → server → agent-card handshake gate →
  bridge; idempotent, with `--dry-run`/`--force`/`--server-only`/`--bridge-only`),
  `scripts/uninstall.sh` (restores the latest backups in **reverse** order), `scripts/verify.sh`
  (version handshake + 8091 health + Feishu connection + protocol drift) and
  `scripts/test-all.sh` (one-command full gate). The scripts only place files; they never
  restart services.
- **Docs merged**: root `README.md` / `CONFIGURATION.md` / this `CHANGELOG.md`; the per-package
  docs remain as detailed references.
- **Hermes parameter surface** (source-tree patch): `plugins/platforms/a2a/tools.py`'s
  `a2a_call` gains optional `workspace` / `sandbox` (with tool descriptions and a schema
  assertion test), recorded in `~/.hermes/docs/hermes/custom-patches.md`.

**Verification**: bridge 394/394, server 109/109 (+6 binding/first-use cases), contracts 20+9,
protocol `--check` clean, installer dry-run passes. **Host-side**: real install, reloads, the
live-fire triple, and the rollback drill.
