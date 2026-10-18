# 配置说明（双语小节）

> 本文件是**产品级入口**；各半的完整配置仍在其包内文档：
> `hermes/CONFIGURATION.md`（桥：collector / 直播渲染 / 卡片 / 提问 / 请求级选项）、
> `dsh/README.md`（服务端：端口 / token / preset / cwd / contextMap / settleCap / 首选定）。

## 中文

### 1. 版本与安装（单号锁步）

- 版本唯一来源：`hermes/plugin.yaml` 与 `dsh/package.json` **必须同号**；`scripts/install.sh`
  在不等时拒装（退出码 2）。
- 顺序：服务端先、桥后；回滚反序。安装器按 agent-card 的 `version` 做门禁。
- 链路协议版本在 `protocol/link-protocol.json` 的 `protocolVersion`，并经 agent-card
  `capabilities.extensions[0].params.linkProtocolVersion` 对外声明。

### 2. 请求级选项（每次调用可带，缺省即现状）

| 参数 | 取值 | 语义 |
| --- | --- | --- |
| `workspace` | 工作区名字 / 绝对路径 | 解析成会话 cwd；名字查无则在服务端 cwd 下新建并登记 |
| `sandbox` | `read-only` / `workspace-write` / `danger-full-access` | 会话级权限预设（与 GUI 手切同一写路径）。**只圈写、不限制读**；`workspace-write` 可写面＝会话 cwd ＋ `/tmp` ＋ `os.tmpdir()`；`danger-full-access` 不圈 |

非法值：桥先挡（非法档位/空名字），更细形状由服务端校验并以 `FAILED` 收口且**原因回送本线**。

### 3. 首选定与绑定（§2.2/§2.3，服务端唯一权威）

- `dsh` 侧配置 `a2a-server.firstUseSelection`：`off`（缺省＝现状）/ `ask`（对话首次投递发
  「选工作区 + 选沙箱档」卡）。
- 绑定账本：`~/.dsh/storages/a2a-link-state.json`（`{version, bindings: {contextId: …}}`，独立
  文件，不动既有 `a2a-context-map.json` 格式）。
- 优先级：**显式参数 > 绑定 > 缺省**；选空＝记 `answered` 但不改缺省；跳过记 `answered`
  （不再打扰），投递失败不记账（可重试）；任何异常都回落缺省，**不卡任务**。
- 同一对话「带 / 不带 workspace」＝两个工作区＝两个会话（复用键含 cwd）；要固定就用绑定。

### 4. 提问/作答（§2.6）

桥侧 `collector.enabled=true` 且目标为 dsh 时生效；服务端在流里发提问（`question` Data
Part + `input-required`），桥渲染交互卡，点击作答经 `taskId` 续投回写。**零超时**。

## English

### 1. Versions and install (lock-step)

`hermes/plugin.yaml` and `dsh/package.json` must carry the same version (the installer refuses
otherwise, exit 2). Install the server first, then the bridge; uninstall in reverse. The
installer gates on the agent-card `version`; the link-protocol version lives in
`protocol/link-protocol.json` and is advertised through
`capabilities.extensions[0].params.linkProtocolVersion`.

### 2. Request-level options (per call; omitted = unchanged)

`workspace` (name or absolute path → session cwd, created/registered when missing) and
`sandbox` (`read-only` / `workspace-write` / `danger-full-access`, a session-level permission
preset through the same write path as the GUI switch). All tiers confine **writes only, never
reads**; `workspace-write` also allows `/tmp` and `os.tmpdir()`; `danger-full-access` confines
nothing. Invalid values are blocked by the bridge (tier/empty) or closed as FAILED by the
server with the reason relayed back to the line.

### 3. First-use selection and binding (§2.2/§2.3, server-authoritative)

`a2a-server.firstUseSelection`: `off` (default = today's behaviour) or `ask` (ask for workspace
and sandbox tier on the first call of a conversation). Bindings are stored in
`~/.dsh/storages/a2a-link-state.json` (separate file; the existing context-map format is
untouched). Precedence: explicit > binding > default; an empty answer records `answered`
without changing the default; a skip records `answered` (no more asking); a delivery failure
records nothing (retryable); any error falls back to the default and never blocks the task.

### 4. Questions and answers (§2.6)

Active when the bridge has `collector.enabled=true` and the target is dsh. The server emits a
question Data Part plus `input-required`, the bridge renders an interactive card, and the click
is written back as a `taskId` continuation. No timeouts.
