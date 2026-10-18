# dsh-a2a-server 配置与机制说明

> 状态：**P2a 流式中间事件 + 映射清理**。A2A server 业务逻辑已落地
> （node:http + Bearer 认证 + `@a2a-js/sdk` JsonRpcTransportHandler + AgentExecutor
> → dsh 会话同步执行）；`message.contextId` 映射到 dsh 会话（复用 + 跨重启 resume）；
> `preset` 可配置（含 agent-team）；`SendStreamingMessage` 实时推思考/工具/状态/文本
> 中间事件；contextMap 带 TTL 清理。0.3.0 起**同时兼容 dsh 0.1.5 与 0.2.0**
> （见「dsh 0.1.5 / 0.2.0 双版本兼容」）。

## 安装（完整途径）

本库是独立公开 bundle 包（非 dsh workspace 内包），以 standalone bundle 形态
分发，三种途径任选。

### 方式 A：npm（推荐）

```sh
dsh plugin --profile <name> add @artomyuan/dsh-a2a-server
```

官方默认渠道（`dsh plugin add` 不带前缀即从 npm registry 安装）；发布到 npm 时
自带预构建的 `lib/`，无需 build 授权。需要锁定版本时：`@artomyuan/dsh-a2a-server@0.3.0`。

### 方式 B：GitHub 安装（尝鲜尚未发布的改动）

```sh
dsh plugin --profile <name> add github:ArtomYuan/dsh-a2a-server#<commit>
```

- **必须固定 commit**（`#<sha>`）：git 安装拉取的是源码而非构建产物，固定
  commit 可防止后续 push 静默改变安装时执行的代码。
- **allowBuilds 授权**：pnpm ≥10 默认拒绝运行 git 依赖的 `prepare` 脚本。首次
  `add` 会失败并提示把包键加入 profile 的 `pnpm-workspace.yaml`：

  ```yaml
  allowBuilds:
    @artomyuan/dsh-a2a-server: true
  ```

  然后重跑 `add`。该授权等于**允许在安装时于你的机器上执行本包代码**（在
  agent 沙箱之外）；只对信任来源、且已固定 commit 的包授权。

### 方式 C：tarball

```sh
pnpm pack                 # 生成 artomyuan-dsh-a2a-server-<version>.tgz
dsh plugin --profile <name> add ./artomyuan-dsh-a2a-server-<version>.tgz
```

### 卸载

```sh
dsh plugin --profile <name> remove @artomyuan/dsh-a2a-server
```

## 包结构（bundle）

- `package.json`：`dsh.bundle.patch` 声明 + `@deepseek-ai/cordis` peer/dev 镜像。
- `cordis.patch.yml`：patch 条目数组，`insert` 一条 A2A server 插件行。**不**
  `insert` `agent-presets` 行（完整 profile 的 web-app bundle 已提供，重复插入会
  duplicate entry id 加载失败）；dsh-base-only profile 需自行补 `agent-presets` 行。
- `src/index.ts`：插件入口（`name` / `inject` / `apply`）。
- `tsdown.prepare.config.ts`：git 安装时 `prepare` 的自包含转译配置（转译
  `src/` → `lib/`，不做项目引用、不做类型检查）。

## 服务 API

A2A server 暴露两个端点（JSON-RPC binding，协议版本 `1.0`）：

- `GET /.well-known/agent-card.json`：agent card（JSON；认证检查在所有路由之前，
  配置 `authToken` 后此端点同样需要 Bearer 令牌）。含
  `supportedInterfaces[].protocolBinding = "JSONRPC"`、`protocolVersion = "1.0"`、
  `capabilities.streaming = true`。
- `POST /`：JSON-RPC。`method: "SendMessage"`（阻塞）携带用户文本消息，服务端
  `AgentExecutor` 把文本投给 dsh agent 会话同步执行，最终输出作为 artifact
  （`lastChunk: true`）返回，任务状态流为 `submitted → working → completed`。
  `method: "SendStreamingMessage"`（流式）同参数，但以 SSE 逐步推送中间事件
  （见下「流式中间事件」）。

认证：配置 `authToken` 后，所有请求必须带 `Authorization: Bearer <token>`，
否则 `401`。

### contextId 会话映射

`params.message.contextId`（Hermes 由 origin 派生）映射到 dsh 会话——同 contextId
复用同一 dsh 会话（上下文连续），异 contextId 隔离；映射持久化到
`$DSH_HOME/storages/a2a-context-map.json`（格式 `contextId\0cwd → {sessionId,
lastUsedAt}`），server 重启后同 contextId 经 `ctx.agents.resume` 续接；条目按
`lastUsedAt` 做 TTL 清理（默认 7 天）。缺 contextId 时 server 生成随机 contextId
（等于每次新建，不复用）。

### 流式中间事件

`SendStreamingMessage` 下，DshAgentExecutor 订阅 dsh agent 的流式事件面（0.1.5 的
`session/event`；0.2.0 的助手增量另走进程内 `agent/assistant-stream`，见 A6），把
高信号中间事件实时推为 A2A 流式事件——

- 文本块 → `artifactUpdate`（text Part，`artifactId: "stream-text"`、`append: true`）；
- 思考（reasoning）、工具调用/结果、turn 边界 → `artifactUpdate`（**data Part
  私有扩展**，`mediaType: application/json`，值为 JSON 描述符）。

data Part 描述符 `kind` 取值：`thinking`（`{text}`）、`tool_call`
（`{name, arguments}`）、`tool_result`（`{name, text}`）、`turn_start` /
`turn_end`（`{turn, step, reason?}`）。测试期思考原样透传以便验证。

## 事件

同步任务（`SendMessage`）返回 task → statusUpdate → artifact → statusUpdate。
流式任务（`SendStreamingMessage`）额外实时推送思考 / 工具 / 状态 / 文本中间事件
（见「流式中间事件」），最终 artifact 完成。

## 扩展点 / 配置（字段全集）

`Config` 字段（cordis.yml 插件 `config`，也可从环境 `A2A_SERVER_TOKEN` 读 token）：

- `port`：监听端口（缺省探测 8092/8093/8094 首个空闲端口）。
- `host`：监听地址（默认 `127.0.0.1`，仅本机）。
- `authToken`：Bearer token（设置后强制校验）。
- `provider`：后端 provider（默认 `deepseek-official`）。
- `model`：执行模型（默认 `deepseek-v4-flash`；空串 = 跟随 dsh 用户/默认设置）。
- `preset`：挂载的 agent preset（默认 `standard`；可设 `agent-team` 等，见下）。
- `cwd`：任务工作目录（默认进程 cwd）。
- `contextMapPath`：contextId→session 映射持久文件路径（默认
  `$DSH_HOME/storages/a2a-context-map.json`）。
- `contextMapTtlDays`：映射条目 TTL 天数（默认 7；超期条目在加载/写入时清理）。
- `settleCapMs`：**释放 Lead 之前等待其活跃 continuable 子代理结算的上限**（毫秒，
  默认 `1800000` = 30 分钟；`0` = 关闭该等待、回落旧语义）。超限回落「释放 + 队列兜底」
  并打印 warning，详见下节「释放前等待子代理结算」。

注入依赖：`agents`、`agentPresets`、`sessions`（`settleCapMs` 生效还需要宿主提供
`subagents` 服务，见下节「降级」）。

## 设置面板

dsh Web UI「设置 → 插件 → Plugin configuration」会自动出现 `a2a-server` 设置卡片，
只要该插件被 profile 组合即可，无需改 dsh 仓库、无需白名单。实现走 dsh 官方
settings 能力：host 侧注册 settings 命名空间 `a2a-server`（schema 由 schemastery
定义），浏览器侧提供一张设置卡。

卡片是折叠式的（与 dsh 官方插件卡一致）：默认收起，点击卡片头展开或收起；
有未保存改动时卡片头显示「未保存」标记，保存成功后自动收起。折叠不会丢弃
尚未保存的改稿。

### 配置分层

- `cordis.patch.yml` 里的插件 `config` 仍是 composition（base）层与事实源；
- 面板上的修改写入 dsh 用户设置文档 `$DSH_HOME/settings.yaml`，作为**用户覆盖层**；
- 解析顺序：schema 默认值 < `cordis.patch.yml` < 用户覆盖。

面板会标出哪些字段被用户层覆盖，并提供「清除覆盖」回落到 `cordis.patch.yml` 的值。

### 字段与生效时机

| 字段 | 默认 / 空值语义 | 生效时机 |
| --- | --- | --- |
| `port` | 留空 = 启动时自动探测可用端口 | 需重启 dsh（或重新加载 profile） |
| `host` | 非空（受校验） | 需重启 dsh（或重新加载 profile） |
| `authToken` | secret 字段，只写不回显 | 下一次 A2A 请求（无需重启） |
| `provider` | 默认 `deepseek-official` | 下一次 A2A 请求（无需重启） |
| `model` | 默认 `deepseek-v4-flash`；空串 = 跟随 dsh 当前默认模型 | 下一次 A2A 请求（无需重启） |
| `preset` | 默认 `standard` | 下一次 A2A 请求（无需重启） |
| `cwd` | 空串 = `process.cwd()` | 下一次 A2A 请求（无需重启） |
| `contextMapPath` | 留空 = `$DSH_HOME/storages/a2a-context-map.json` | 需重启 dsh（或重新加载 profile） |
| `contextMapTtlDays` | 默认 7 | 下一次落盘清理（无需重启） |
| `settleCapMs` | 默认 `1800000`（30 分钟）；`0` = 关闭等待 | 下一次 A2A 请求（无需重启） |

`port` / `host` / `contextMapPath` 保存后，当前运行实例仍监听启动时的地址，直到重启
dsh（或重新加载 profile）才生效。

### 释放前等待子代理结算（settleCapMs，v0.5.1 起）

**动机**：A2A 请求原先在 `whenIdle()` 后立即 `handle.dispose()` 释放 Lead。若 Lead 在
派发（`spawn_teammate` / `subagent`）子代理后收口，子代理完成回传时父已不在
`ctx.agents`，dsh-subagent 会报 `PARENT_UNAVAILABLE`（0.2.0-rc.2 起已有队列补丁兜底，
但主路仍要等下一次会话激活才续跑）。

**新行为**：释放前必须满足「**Lead 已 idle 且无活跃 continuable 子代理**」。等待是
**事件驱动**（`subagent/start|end` + 本 agent 的 `agent/status`；不做忙轮询），期间
子代理回传引发的新回合会逐段跑完再复查，该回合新派生的子代理也会被目录刷新捕获。
回传到场时父仍在注册表 ⇒ **当场投递、当场续跑**。

**判定口径**：`ctx.subagents.listChildren(leadId)`（durable 子代理目录）中
`mode === 'continuable'` 的行 = 会回传的子代理（one-shot 不等）；目录是全量的，故用
「进入等待时仍在本进程注册表内的子代理」作基线，再按 `subagent/start|end` 事件增量
维护活跃集合（`end` 移出、`start` 复位——冷恢复是新 epoch）。

**上限兜底**：`settleCapMs` 到点即**释放**（不无限等待），打印 warning 含仍活跃数量，
并明确「晚到回传由 dsh-subagent 队列补丁入队、下次激活补投」。

**请求生命周期（明示的语义变化）**：请求收口时机由「Lead 一次 idle」后移到「子代理
结算之后」，因此桥侧流会跨阶段保持更久。受理语义不变：SUBMITTED / WORKING 与桥侧
「⏳ 已受理」仍然即时返回，只是最终结果更晚。

**阈值建议**：`settleCapMs` ≤ 桥侧 `a2a_agents.dsh.timeout`（本机 3600s）**减去任务自身
承诺时长**的余量；超长流水线请同步上调桥侧 timeout，或把 `settleCapMs` 调到与之一致
（本机建议保持 1800000 = 30 分钟，留出任务本身的时间）。

**降级**：宿主没有 `subagents` 服务（如 dsh 0.1.5）或目录查询失败 → **不等待**（回落
0.5.0 行为）并打印 warning；`settleCapMs=0` 同样关闭等待。三种情形下回传兜底仍由
dsh-subagent 队列补丁承担。

### 凭据（authToken）

- 面板上只写不回显（永远显示「已设置 / 未设置」，输入框空起始；空白输入 =
  不修改）。
- 「清除覆盖」只删除用户层覆盖并回落到 `cordis.patch.yml` 的既有令牌，绝不
  静默关闭鉴权。
- 最终解析值为空时面板显性警示「未设置 = 无鉴权（危险）」。
- 环境变量 `A2A_SERVER_TOKEN` 优先级高于配置，此时面板显示「由环境变量接管」
  而不可编辑。

### 降级

settings 服务不存在时插件照常工作，只使用 `cordis.patch.yml` 的配置；该 profile
中不出现设置卡片。

### 安装与构建

无需额外安装步骤：`link:` 或正常安装后重启 dsh 即可。发布物同时包含 host 产物
`lib/` 与浏览器产物 `client/`；从 git 安装由 `prepare` 脚本自动构建两半。

## agent-team 挂载（部署说明）

`agent-team` 预设依赖 tool-subagent 的 `modelSelectionSettings`（web-app 独有
host 服务 `subagent-model-selection-settings`）与九个 Team 工具（来自
`@deepseek-ai/dsh-experimental-agent-team-profile` bundle）。dsh-base-only 的
独立 profile 缺这些 host 行，须在 profile 的 cordis 树补上（等价于
agent-team-profile bundle 的 `cordis.patch.yml` + web-app 的 host 行）。dsh-base
也不提供 `agent-presets` 行，须一并 insert（完整 profile 的 web-app 已提供，
重复会 duplicate entry id）：

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

其中 `@deepseek-ai/dsh-experimental-agent-team` / `-tool-agent-team` 须可解析
（完整 profile 自带；独立 profile 用 `dsh plugin add link:<源码树路径>` 挂接）。
`agent-team` 预设本体来自 user root（`$DSH_HOME/.agent-presets/agent-team`，
`includeUserRoot` 默认纳入）。

## dsh 0.1.5 / 0.2.0 双版本兼容

本插件自 0.3.0 起同时支持 dsh 0.1.5-rc.2 与 0.2.0-rc.2 两个运行时
（`package.json` peer 范围已同时覆盖两版），是将来切换/回退的前提。兼容逻辑
集中在 `src/compat.ts`，按「特性探测 + 响亮降级」实现。

### 版本探测机制

`dshRuntimeVersion()` 用 `createRequire(import.meta.url)` 解析
`@deepseek-ai/dsh-agent/package.json`（0.1.x 与 0.2.0 的 `exports` 都导出该
子路径，沙盒实测），读其 `version` 字段得到真实运行时版本。探测失败返回
`undefined`（不抛），此后一律回落 0.1.5 行为并 `console.warn` 一行明确警告
（当前生产是 0.1.5，宁可保住现状也不静默改行为）。

### 消息 source 两种形状（A1）

0.1.5 的 `MessageSourceMap` 有 `plugin` 种类（`{kind:'plugin', plugin:…}`）；
0.2.0 删除了该种类（只剩 model/tool/system-prompt），插件消息改为命名空间化
`kind: 'plugin:<name>'`。`pluginMessageSource()` 按上述探测判定返回：

- 0.2.x：`{ kind: 'plugin:dsh-a2a-server' }`
- 0.1.x 或探测失败：`{ kind: 'plugin', plugin: 'dsh-a2a-server' }`

0.2.0 上若仍发旧形状，消息会**进不了 agent loop、任务静默不执行**（表面
COMPLETED 但 `(no text output)`），因此这是双版本适配的硬门禁项。

### tool_result 双形状（A2）

`tool/result` 会话事件在 v3/v4 两种会话格式下形状不同，`readToolResult()`
按 v4 → v3 → `data.callId` 的优先级读取 `{ callId, text }`：

- v4（0.2.0，实测）：`toolCallId` 在 message 层，`content` 已展平为文本块数组；
- v3（0.1.5）：`message.content[0].toolCallId` +
  `message.content[0].content[0].text`。

对外 wire 事件字段名不变（仍是 `kind/turn/step/name/text`），工具名沿用
`tool/call` 记下的 `callId→name` 反查。取不到任何形状时返回双 `undefined`，
不抛、不改变事件流。

### 助手实时增量的双事件面（A6）

助手增量（text / reasoning）在两个运行时里走**两套互斥的事件面**：

| 运行时 | 事件面 | 载体 |
| --- | --- | --- |
| 0.1.5 | `session/event` 的 `assistant/chunk` | 会话事件，`data.chunk` 是 `StreamChunk` |
| 0.2.0 | 进程内 cordis 事件 `agent/assistant-stream` | payload `{ agent, frame }`；frame 为 `start`/`chunk`/`end` 三态，`frame.chunk` 是同一 `StreamChunk` 联合类型 |

0.2.0-rc.2 删除了 `assistant/chunk`，因此 0.4.0 只认旧事件面的实现在 0.2.0 上
直播流只剩 turn/tool/status 帧，**既没有 text 帧也没有 thinking 帧**（真机 A2A
SSE 抓包实证）。0.5.0 起两条路径并存：

- 0.1.5：`session/event` → `applySessionAssistantChunk`；
- 0.2.0：`agent/assistant-stream` → `applyAssistantStreamFrame`，先按
  `payload.agent === handle.agent` 过滤（插件 ctx 非 agent-scoped，会收到同一
  宿主内所有 agent 的帧）；
- 两面共用同一 block index 缓冲 + `block-end` 整块落地状态机（text 块 → `text`
  帧、reasoning 块 → `thinking` 帧；空块不落地）；turn/step 在 0.2.0 取最近一次
  `start` 帧，0.1.5 沿用 `data.turn/step`。

**去重门（单向）**：某个任务内一旦收到过 `agent/assistant-stream` 帧，就忽略该
任务后续的 `session/event` `assistant/chunk`，保证同一 block 不会被两条路径各落地
一次。反向不设门：0.1.5 根本不发布进程内帧，反向门只在两面同时对发时有意义，而
进程内帧是更早、更全的那一面，始终让它生效可避免丢低延迟帧。订阅与
`session/event` 同生命周期，任务毕在同一个 `finally` 里一并释放。

是否订阅进程内事件面用两路信号取或：`supportsAssistantStreamEvents(dshRuntimeVersion())`
（探测失败按**真**——漏订会让 0.2.0 静默丢帧，多订一个惰性监听器零代价；方向与
A1 的消息 source 谓词刻意相反）或活会话格式为 v4。版本谓词与缓冲状态机都是
`src/compat.ts` 里的纯函数，单测见 `tests/compat.test.mjs`。

### 设置面板在 0.2.0：由导出的 Config schema 派生（A3）

设置面板注册走官方 settings seam，按运行时特性探测分三支：

1. `settings.installSection` 存在（0.1.5 现状）：走原路径，面板可用；
2. 只有 `settings.register`：用 register + `scope.watch` 复刻同等语义
   （保守实现；无任何已发布版本命中此分支）；
3. 两者皆无（**0.2.0 现状**，其 npm 发行版里 `installSection`/`register`/
   `SettingsScope` 全部不存在）：本分支不再告警「面板不可用」，改为信息级
   日志说明去向。

0.2.0 的设置区**不再依赖 register seam**，而是由插件导出的运行时 `Config`
schema（`A2AConfigSchema`，即 `src/index.ts` 的 `export const Config`）派生：
`dsh-settings` 的 `schema(entry)` 取 `entry.fiber.runtime.Config`（要求有
`toJSON`），`volatileForm()` 只收集带 `meta.volatile` 的字段进派生表单。因此本
插件把 9 个配置字段全部 `.volatile()` 化，命名空间 = cordis 行 id `a2a-server`
（与 0.1.5 一致），设置区即可出现。

#### 与 0.1.5 的行为差异（重要）

- **写入落点不同**：0.1.5 的面板写入 `$DSH_HOME/settings.yaml`（用户覆盖层）；
  0.2.0 的表单编辑是 **over Cordis profile patches**，落到 **profile 的
  `cordis.patch.yml`**，靠 cordis `_reload()`（`patchReload: live`）生效。不要
  误以为 0.2.0 仍写 `settings.yaml`。
- **`applies: 'live'` 与真实生效时机不一致**：0.2.0 的派生区一律报
  `applies: 'live'`，但本插件的 `port` / `host` / `contextMapPath` 实际需
  **重启**（或重新加载 profile）才生效（插件无法改写服务的 `applies` 字段）。
  其余字段（provider/model/preset/cwd/authToken/contextMapTtlDays）下一次 A2A
  请求即生效。

`authToken` 保持 `role('secret')`，0.2.0 的 `redactSecrets` 据此只写不显。
运行时读配置在双版本都必须经 `unwrapVolatile` 解包（`.volatile()` 字段的校验
输出是 `{ get() }` 引用对象）。

#### 浏览器半边：卡片挂载（0.2.0 `plugins.item` / 0.1.5 `settings.plugin.item`）

设置**卡片**（浏览器半边）在 0.1.5 与 0.2.0 走两套互斥的槽/服务契约，由纯函数
`pickClientMount`（`src/client/mount-strategy.ts`）按能力探测决策，**0.1.5 优先
保证不回归**：

| 维度 | 0.1.5（legacy） | 0.2.0（modern） |
| --- | --- | --- |
| 服务 | `ctx.settingsScope`（`SettingsScopeBinder`） | `ctx.configForms`（`ConfigForms`） |
| 数据面 | `settingsScope.bind({ namespace })` → `SettingsScope`；`settingsScope.describe()` | `configForms.get('a2a-server')` → `ConfigForm`；`configForms.describe()` |
| 槽 | `settings.plugin.item`（`kind:'keyed'`，key=命名空间） | `plugins.item`（`kind:'list'`，由 `dsh-client-ui-plugin-manager` 声明） |
| 挂载守卫 | 嵌套 `ctx.inject(['settingsScope'], …)` | `configForms.whileServed(['a2a-server'], …)`（Host 确实提供该命名空间时才挂卡） |

0.2.0 的注册块照抄官方 `dsh-client-ui-settings-{subagent,agent-loop,web-search,shell}`
的形状：`{ name:'plugins.item', id:'a2a-server', order:50, label:()=>t('a2aTitle'),
locale:NS, inject:()=>controller.inject() }`；卡片组件在 `view:'summary'`（官方列表
的一行简介）与 `view:'page'`（整页表单）间切换。0.1.5 的注册块保持原样不变。

两套数据面（`SettingsScope` 与 `ConfigForm`）的快照字段完全一致
（`status/value/base/user/revision/writable/mode`），控制器消费一个统一的本地最小
契约 `A2AFormSource`（`card-controller.ts`）：0.2.0 直接传 `configForms.get` 的结果，
0.1.5 经 `legacyScopeSource` 适配（`Promise<void>` 包成 `Promise<boolean>`）。写操作
都带 `revision`（OCC/冲突语义），0.2.0 的 `mutate` 返回 Host 是否接受（`false` 时已
recover 重读），0.1.5 靠保存后回读 `userLayer` 判定，冲突时按契约重读快照。

#### 宿主原语符号：运行时解析 + 本地兜底

卡片**不静态按名导入宿主原语**。浏览器半边与宿主包是 bundle external 关系，编译
产物以「命名空间属性访问」形态引用宿主模块（形如 `_primitives.Tag`），因此静态按名
导入一个宿主没有的导出**不会构建失败、也不会链接失败**，只会在运行时得到
`undefined`；把它当组件渲染即 React #130（element type is invalid）。

`@deepseek-ai/dsh-client-ui-primitives` 的两版差异实测（导出面按包实测统计）：

| 符号 | 0.1.5-rc.2 | 0.2.0-rc.2 | 处置 |
| --- | --- | --- | --- |
| `IconChevronDownOutline14` | ✓ | ✗（改名） | 进候选列表第 1 位 |
| `IconChevronDownOutlineRegular` / `…Medium` | ✗ | ✓ | 进候选列表第 2/3 位 |
| `Tag` | ✓ | ✓（`TagTone` 取值集合逐字相同） | 仍走同一套解析，防同类改名 |

卡片经 `src/client/primitive-symbols.ts` 的纯函数 `resolveComponent`（无 React/JSX，
可在 node 单测）按候选名解析，全缺失时用 `src/client/primitives.tsx` 的本地兜底
（自绘 14px SVG 箭头、本地胶囊样式），**任一版本上都不会渲染 `undefined`**。
宿主提供的符号始终优先，观感与宿主保持一致。回归测试见
`tests/primitive-symbols.test.mjs`（候选顺序、缺导出降级、非组件值不误判、两版命名
必须同时在列表）。

### 0.2.0 的版本门与豁免（A4）

0.2.0 新增了运行时兼容门：peer 范围不含已装 dsh 版本的插件会被拒绝加载，报
`Plugin … is incompatible with dsh 0.2.0-rc.2`。本插件 0.3.0 起 peer 范围已扩
（`… || ^0.2.0-rc.2`），**新装不再需要豁免**；0.2.0 上还装着旧版（≤0.2.1）
插件的部署仍需：

```sh
dsh plugin --profile <p> allow-version @artomyuan/dsh-a2a-server@<旧版本> --dsh-version 0.2.0-rc.2 --accept-risk
```

### 会话续聊（resume）诊断（A9）

0.2.0 用旧 contextId 续聊 v3 会话会失败并回落新建（v3→v4 打开失败）。插件
保留既有降级行为不变（不抛、删映射、新建），但失败时打印诊断日志：错误
`name`/`code`/`message` 与 `stack` 头 3 行，并明确注明
`falling back to a NEW session (contextId mapping dropped)`，供定位用。

## 设计说明

- 会话语义：A2A `message.contextId` ↔ dsh 会话。同 contextId 复用同一 dsh 会话
  （上下文连续），异 contextId 隔离；两级接管（持久映射命中 → resume，未命中 →
  新建 + 写映射），映射持久化跨重启 resume，带 TTL 清理（默认 7 天）。任务毕
  flush + 释放句柄。
- 流式粒度：阻塞式 `SendMessage` 返回最终结果；`SendStreamingMessage` 实时推
  思考/工具/状态/文本中间事件（text Part + data Part 私有扩展）。
- 传输选型：JSON-RPC over node:http（自建 listener，非 express）；agent card
  走 `/.well-known/agent-card.json` 端点（同样受 Bearer 认证保护）。

## 命名

- 包名：`@artomyuan/dsh-a2a-server`（bundle 补丁中 `name` 引用此名做 Node 解析）。
- 补丁行逻辑 id：`a2a-server`。
- 插件 role：`Executor`（对应 A2A `AgentExecutor` 映射，把 A2A task 文本投给
  dsh agent 会话执行）。

## 开发

```sh
pnpm install      # 独立 workspace（pnpm-workspace.yaml 隔离，不碰主仓库 lockfile）
pnpm run build    # tsdown 转译 src/ → lib/（standalone，无项目引用）
pnpm run typecheck # tsc --noEmit
```

`lib/index.js` 由 tsdown 直接转译（ESM），`@deepseek-ai/*` 与 `@a2a-js/sdk`
均为外部依赖，不打包进产物；运行时在 profile 内解析。
