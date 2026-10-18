# 更新日志

[English](CHANGELOG.en.md)

本项目的所有重要变更都会记录在此文件中。

格式基于 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，
版本号遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

## [0.7.0] - 2026-10-18

> §2.1 **工作区选择** ＋ §2.4 **沙箱档** 的**服务端侧**：从 A2A 首投报文的
> `message.metadata` 读两个可选键（`x-dsh-workspace` / `x-dsh-sandbox`），据此解析会话
> cwd 与落沙箱档。**缺省不带＝现状**：不改服务端配置面、不改既有行为的任何一行。

### Added

- **`src/request-options.ts`**（新；纯逻辑＋依赖注入，零 dsh 运行时依赖，单独成
  `lib/request-options.js` entry 供单测）：
  - `readRequestOptions` / `parseSandboxTier` / `parseWorkspaceSpec`：metadata 解析与严格
    校验（三档精确值；工作区名字禁路径分隔符、禁 `.`/`..`、≤64 字符；路径形态禁 `..` 段）；
  - `resolveWorkspaceTarget`：名字 → 现有工作区 title / 目录名精确匹配（唯一命中即用；
    多命中报错不猜）；查无 → 服务端 cwd 下建同名目录；绝对路径形态直接采用（不存在就建）；
  - `applySandboxTier`：经 `ctx.permissionPresets.set(session, 档名)` 落成**会话级覆盖**
    （与 GUI 手切沙箱同一条写路径，幂等）；宿主缺插件 / 预设表无此档 / 写入抛错 → 响亮
    告警并保持现状。
- **请求级 cwd**：`resolveSession` 的复用键本就含 cwd（`${contextId}\0${cwd}`），故
  「同对话换工作区＝新会话、同区复用」由键本身保证；工作区名册登记沿用既有
  `ensureWorkspace + attachSession`。
- **沙箱档落地点**：会话解析之后、`followup` 之前落档（首轮即生效）；同档重复请求不写
  事件（`permissionPresets.set` 幂等）。
- 测试：`tests/request-options.test.mjs`（10 例：线上键字面量锁、解析/校验（含 C1/bidi 控制字符与 null 对称）、工作区四路解析、档位五种出口）、
  `tests/request-options-contract.test.mjs`（2 例：**线上契约**——两个 metadata 键经 SDK
  JSON-RPC 编解码后原样到达 executor；不带 metadata 时为 `undefined`）。

### Changed

- `execute()` 在发布任务事件**之前**先做**语法级**解析：形状不合法即抛 → SDK 合成 task +
  FAILED，客户端拿到明确报错（绝不静默改用默认值）。**工作区语义级错误**（名字歧义、
  mkdir 失败等）发生在解析/建目录阶段，可能已在 SUBMITTED/WORKING 之后——同样以 FAILED
  收口并带原因。
- `runDshTask` 新增 `requestOptions` 参数与 `resolveRequestCwd`；新增两行信息日志
  （工作区：请求/命中方式/cwd；沙箱档：请求/结果/session）。
- `tsdown.prepare.config.ts` 增加 `src/request-options.ts` entry；`package.json` test 脚本
  纳入两个新测试文件；agent card `version` 同步 0.7.0。

### 兼容性与圈定口径

- 不新增 / 不删除配置键；不带请求级选项的投递行为与 0.6.0 逐字一致。
- 「读」的圈定程度（核验修正）三档都**不限制读**；「只圈写」仅对 `read-only` /
  `workspace-write` 成立（`danger-full-access` 完全不圈）。`workspace-write` 的可写面除
  会话 cwd 外还包括 `/tmp` 与 `os.tmpdir()`（bwrap 下 /tmp 是私有 tmpfs）。
- **档位未落地可感**：宿主缺预设/写入失败时，除服务端告警外，**流式任务会在流里发一条
  文本告警**（同步任务不污染 artifacts）——调用方不再"以为生效"。
- 沙箱档为**会话级覆盖**：后续请求带不同档位会切换该会话档位；不带则不动。
- 已知边界：同一对话换工作区会新开会话（预期行为），旧会话与其结果回传地址不变
  （§2.5 锁会话对账在后续段落实现）。

## [0.6.0] - 2026-10-17

> §2.6 **交互问答桥接（服务端侧）**：dsh 会话中途的 `ask_user_question` 现在可以在
> A2A 上被**看到并作答**——提问挂起时任务进入 `INPUT_REQUIRED`，问题载荷随流送出；
> 作答沿**同一 `taskId` 的续投**回来解挂，首跳继续跑完，后续事件发在续投那条流上。
> **全程零超时**（已定死）；**认领需客户端显式声明**，未声明者行为与 0.5.1 逐字一致。

### Added

- **`src/questions.ts`**（新；纯逻辑、零 dsh 运行时依赖，单独成 `lib/questions.js` entry
  供单测）：提问规范化 `toQuestionItems`、载荷构造 `questionPayload`、挂起认领
  `claimQuestion`、作答解析 `readQuestionAnswer`、解挂 `resolveQuestion`（`askId` 精确
  命中优先；唯一未决时允许无 `askId` 降级并**响亮报警**；异常令牌报警且忽略）、
  收场 `abandonQuestions`。
- **题目承接缝**：以 **prepend** 注册 dsh 的 `user-questions/request`（agent 作用域
  waterfall）认领者，**只认自己名下正在跑 A2A 任务的 agent**，其余请求一律 `next()`
  放行——GUI 既有作答面零回归（线优先：A2A 名下会话的提问归发起那条线）。
- **两条可见面**：① `question` 事件（`artifactUpdate` + `data` Part，桥据此建卡）；
  ② `statusUpdate(INPUT_REQUIRED)`，其状态消息携带同一载荷 ⇒ `tasks/get` 可查「哪条任务
  在等哪道题」。
- **`question-answer` Data Part 归途**：续投报文带 `askId` + 结构化作答
  （`answers[].selected` / `custom`），`skipped=true` 表示用户跳过（以中止收口）。
- **客户端能力声明**：只认领首投报文
  `metadata["x-dsh-user-questions"]=true`（且流式）的任务。**这是缺省行为不变的保证**：
  未声明的调用方（旧桥、直接 A2A 客户端）提问照旧以 `NO_PROVIDER` 立刻失败，绝不进入
  「零超时等待」——否则提问会被挂到一个永远收不到答案的地方而无声挂死。
- **零悬挂**：提问的三个出口＝作答 / `signal` 中止 / 任务收场；`cancelTask` 亦放行未决
  提问。任务收场（含异常路径）一律 `abandonQuestions`，宁可让提问方收到中止也不悬挂。
- **误用续投明确收束**：带 `taskId` 却不带作答载荷、而该任务正等作答时，明确回
  `INPUT_REQUIRED` 收束本次流（SDK 在 input-required 处正常结束流），客户端据此知道
  「任务在等输入」；原提问仍等真正的作答，首跳不受影响。**不再有一条只见快照、
  再无声息的流**。
- 测试：`tests/questions.test.mjs`（8 例：载荷与流形状、续投三态判定、解挂严格性、降级命中、
  跳过语义、零悬挂、作答解析）、`tests/qna-continuation.test.mjs`（4 例：**A2A 侧契约回归**——
  `input-required` 收束首流、`taskId` 续投受理、续投流拿到首跳后续事件、能力声明穿透，
  外加一条刻意保留的绊线）。

### Changed

- **`execute()` 支持续投**：报文带 `taskId`（`requestContext.task` 非空）时不再重开一轮
  dsh 执行，改走 `resumeTask`。
- 新增 `resumeTask`：**先补一个 `task` 快照**再解挂——续投是**新的一条流**，而 SDK 的
  `_advanceStreamPattern` 要求新流首帧必须是 task/message，否则直接
  `UnsupportedOperationError`（"Received artifactUpdate before initial 'Message'/'Task'
  event"，运行期实证）；随后按 `askId` 解挂，并**保守地等首跳终态再返回**。作答路径不
  依赖「`INPUT_REQUIRED` 保活总线」这一 SDK 细节；而下面「误用续投以 `INPUT_REQUIRED`
  收束」那条路径**确实依赖它**（已核实：SDK `keepBusAliveStates` 默认含 `INPUT_REQUIRED`，
  故首跳总线不被清理、任务不会被误置终态）。
- `runDshTask` 登记「首跳完成信号」（所有任务）与「认领表条目」（仅声明过的任务）；
  `finally` 里先摘牌、再放行未决提问与续投等待者（顺序不能反）。
- `cancelTask` 放行该任务的未决提问。
- `tsdown.prepare.config.ts` 增加 `src/questions.ts` entry（照 settle/compat 先例）；
  `package.json` 的 test 脚本纳入两个新测试文件。
- agent card `version` 同步 0.6.0。

### 兼容性

- 不新增 / 不删除配置键；未声明问答能力的调用方（含同步 `SendMessage` 路径）
  **行为与 0.5.1 完全一致**。
- 已知边界：同一会话并发多个 A2A 任务时的提问归属有歧义（认领以 agent 为键），v1 未覆盖。

## [0.5.1] - 2026-10-12

### Changed

- **释放 Lead 前先等活跃 continuable 子代理结算（A2A「彻底消窗」）**：旧行为是
  `whenIdle()` 后立即 `handle.dispose()`，于是 Lead 派发子代理后收口、子代理晚回传时
  父已不在 `ctx.agents`，回传报 `PARENT_UNAVAILABLE`（0.2.0-rc.2 起虽已有 dsh-subagent
  队列补丁兜底，但主路仍要等下一次会话激活）。0.5.1 起改为「**已 idle 且无活跃
  continuable 子代理**」才释放：回传到场时父仍在注册表 ⇒ 当场投递、当场续跑，
  「父不在」窗口从源头不存在。等待**事件驱动**（`subagent/start|end` + 本 agent
  `agent/status`，不忙轮询），期间子代理回传引发的新回合逐段跑完再复查，该回合新派生的
  子代理由目录刷新捕获。
- **请求生命周期（明示的语义变化）**：请求收口时机由「Lead 一次 idle」后移到「子代理
  结算之后」，桥侧流跨阶段保持更久；受理语义不变（SUBMITTED/WORKING 与桥侧
  「⏳ 已受理」仍即时返回，只是最终结果更晚）。
- **新增配置 `settleCapMs`**（默认 `1800000` = 30 分钟；`0` = 关闭等待、回落旧语义）：
  子代理卡死/无限派生时不无限等待——超限**照常释放**并打印 warning（含仍活跃数量与
  「晚到回传由 dsh-subagent 队列补丁补投」）。阈值应 ≤ 桥侧 `a2a_agents.dsh.timeout`
  减去任务自身时长的余量（本机桥侧 3600s，默认值留一半余量）。
- **降级**：宿主无 `subagents` 服务（如 dsh 0.1.5）或目录查询失败 → 不等待（回落 0.5.0
  行为）并打印 warning；三种降级路径下回传兜底仍由 dsh-subagent 队列补丁承担。

### Added

- `src/settle.ts`（新，纯逻辑、零 dsh 依赖，单独成 `lib/settle.js` entry 供单测）：
  `waitForSubagentQuiescence` + 纯函数 `continuableChildIds` / `liveChildIds` /
  `applySignal`。活跃判定 = durable 子代理目录（只取 `mode === 'continuable'`）
  − 结束事件（`end` 移出、`start` 复位，冷恢复是新 epoch），基线取「进入等待时仍在
  本进程注册表内的子代理」。
- `tests/settle-window.test.mjs`（15 例）：目录解析（过滤/去重/坏行）、基线 + 事件折返、
  四种出口（`quiesced` / `cap` / `disabled` / `unavailable`）、**事件驱动**（`waitForSignal`
  调用数 == 轮数）、**不丢唤醒**（结算后又被冷恢复的子代理，其 `start` 在 `whenIdle()`
  期间到达也不得提前放行）、退出必退订、上限不无限等。
- `CONFIGURATION.md` / `CONFIGURATION.en.md` 增补 `settleCapMs` 字段与「释放前等待子代理
  结算」一节（动机、判定口径、上限兜底、请求生命周期、阈值建议、降级）。

### Notes

- 字段数由 9 → 10（`settleCapMs`）；既有字段与默认值不变，`0.1.5` / `0.2.0` 双版本兼容
  面不受影响（新行为按能力探测启用）。

## [0.5.0] - 2026-10-10

### Fixed

- **dsh 0.2.0 直播流没有 text/thinking 帧**：0.2.0-rc.2 删除了 `session/event`
  的 `assistant/chunk`，助手实时增量改由进程内 cordis 事件
  `agent/assistant-stream`（payload `{ agent, frame }`，frame 为
  `start`/`chunk`/`end`）发布。0.4.0 只认旧事件面，故 0.2.0 上直播流只剩
  turn_start / tool_call / tool_result / turn_end（真机 A2A SSE 抓包实证）。
  0.5.0 起两条路径并存：0.1.5 继续走 `session/event`，0.2.0 订阅
  `agent/assistant-stream`（按 `payload.agent === handle.agent` 过滤，任务毕随
  既有 `dispose()` 一并释放），复用同一 block index 缓冲 + `block-end` 整块落地
  语义（text → `text` 帧、reasoning → `thinking` 帧，空块不落地）。turn/step 在
  0.2.0 取最近一次 `start` 帧，0.1.5 沿用 `data.turn/step`。

### Added

- 双事件面去重门（单向）：某个任务内一旦收到过 `agent/assistant-stream` 帧，
  就忽略该任务后续的 `session/event` `assistant/chunk`，保证同一 block 不会被两
  条路径各落地一次。反向不设门——0.1.5 根本不发布进程内帧，反向门仅在两面对发
  时有意义，而进程内帧是更早、更全的那一面，始终让它生效可避免丢低延迟帧。
- `src/compat.ts` 新增纯函数（仅 node 内置依赖）：
  `supportsAssistantStreamEvents`（版本谓词，探测失败按真——漏订会让 0.2.0 静默
  丢帧，多订惰性监听器零代价，兜底方向与 A1 的消息 source 谓词刻意相反）、
  `createAssistantIngestState` / `applySessionAssistantChunk` /
  `applyAssistantStreamFrame` / `assistantStreamTurnStep`（frame/chunk 缓冲决策）。
- `tests/compat.test.mjs` 增补 10 条单测：0.1.5/0.2.0 版本判定、start/chunk/end
  三态、text 与 reasoning 各自 `block-end` 落地、空块不落地、重复路径与重复
  `block-end` 不重复落地、start 帧携带 turn/step。
- `CONFIGURATION.md` / `CONFIGURATION.en.md` 增补兼容项 A6（助手实时增量的双事件面）。

## [0.4.0] - 2026-10-05

### Added

- dsh 0.2.0 设置区恢复：插件新增运行时 `Config` schema（`A2AConfigSchema`，9 个
  字段全部 `.volatile()`），0.2.0 的 settings 服务据此派生 `a2a-server` 设置区
  （命名空间与 0.1.5 一致）；`authToken` 保持 `role('secret')` 只写不显。
  `@deepseek-ai/schemastery` 提升至 `^3.18.4`（`.volatile()` 支持的最低版本）。
- 新增解包读取器：`src/compat.ts` 的 `isVolatile`/`unwrapVolatile`（纯函数零
  依赖）与 `src/settings.ts` 的 `readSettingValue`；运行时读配置统一经
  `unwrapVolatile` 解包（导出 volatile schema 后，双版本的 config 字段都会变成
  `{ get() }` 引用对象）。
- 新增 `tests/settings.test.mjs`：`Config` 校验行为（未知键保留 / 默认值 /
  `role('secret')` / volatile vs plain）与**导出契约测试**（`lib/index.js` 的
  `Config` 有 `toJSON`，复刻 0.2.0 `volatileForm` 收集逻辑能收集到全部 9 个字段）。
- 浏览器半边设置卡片迁移到 0.2.0：新增 `src/client/mount-strategy.ts` 的纯函数
  `pickClientMount`（0.1.5 优先、能力探测、互斥挂载）与 `card-controller.ts` 的
  统一表单后端 `A2AFormSource`（0.1.5 `SettingsScope` 经 `legacyScopeSource` 适配、
  0.2.0 直接走 `ConfigForm`）。0.2.0 上卡片挂 `plugins.item` 槽 + `configForms` +
  `whileServed(['a2a-server'])`（照抄官方 subagent/agent-loop 注册形状，`order:50`），
  0.1.5 仍走 `settings.plugin.item` + `settingsScope`（行为不变）；`dsh.client.inject`
  增补 `@deepseek-ai/dsh-client-ui-settings`。新增 `tests/mount-strategy.test.mjs`。

### Fixed

- **浏览器实测的卡片渲染崩溃（React #130）**：设置卡片静态按名导入宿主原语
  `IconChevronDownOutline14`，而该符号在 `dsh-client-ui-primitives` 0.2.0-rc.2
  已改名（尺寸后缀 → `…Regular`/`…Medium` 变体），bundle external 形态下取到
  `undefined`，details 视图渲染即崩（summary 不渲染该符号故正常）。改为经
  `src/client/primitive-symbols.ts` 的纯函数 `resolveComponent` **运行时解析候选名**，
  并以 `src/client/primitives.tsx` 的**本地兜底**（自绘 14px SVG 箭头、本地胶囊）
  收口；宿主符号仍优先使用，两版观感保持。`Tag` 虽两版同名同契约，也一并走同一
  机制以防同类改名。新增 `tests/primitive-symbols.test.mjs`（10 例：候选顺序、
  缺导出降级、非组件值不误判、两版命名必须同时在列表）。

### Changed

- 0.2.0 无 `installSection`/`register` 分支：从响亮 `console.warn`（「面板不可用」）
  改为信息级日志，说明设置区由导出的 `Config` schema 派生。
- 文档：CONFIGURATION / README（中英）增补「0.2.0 设置区」小节，明确与 0.1.5 的
  两点行为差异——0.2.0 表单编辑落在 profile 的 `cordis.patch.yml`（非
  `settings.yaml`，靠 reload 生效）；派生区一律报 `applies: 'live'`，但
  `port`/`host`/`contextMapPath` 实际需重启。

## [0.3.1] - 2026-10-05

### Fixed

- 修复 `cordis.patch.yml` 的非法 YAML：包名加引号（`name: '@artomyuan/dsh-a2a-server'`）。
  此前（0.3.0）scoped 包名未加引号，而 `@` 在 YAML 中不能作为裸标量起始符：
  在 dsh 0.1.5 上导致启动失败（致命解析错误），在 dsh 0.2.0 上导致该 bundle 被静默
  跳过（插件不加载）。

### Changed

- npm 包名与运行标识自 0.3.0 起为 `@artomyuan/dsh-a2a-server`（文档补记）。

## [0.3.0] - 2026-10-02

### Added

- dsh 0.1.5 / 0.2.0 双版本兼容（新增 `src/compat.ts` 集中适配）：
  - 版本探测：`dshRuntimeVersion()` 经 `createRequire` 读
    `@deepseek-ai/dsh-agent/package.json` 的真实版本号，失败回落 0.1.5 行为并
    `console.warn`（不抛）；
  - 消息 source 双形状：0.2.0 用命名空间化 `kind: 'plugin:dsh-a2a-server'`
    （其 `MessageSourceMap` 已删除 `plugin` 种类，旧形状会让任务静默不执行），
    0.1.5 保持 `{kind:'plugin', plugin:'dsh-a2a-server'}`；
  - tool_result 双形状读取：v4（`message.toolCallId` + 展平 `content`）与 v3
    （`message.content[0]` 包装块）都能取出 callId 与文本，wire 事件字段名不变；
  - 设置面板注册改为特性探测三分支：`installSection`（0.1.5 原路径）→
    `register`+`watch` 保守复刻 → 两者皆无（0.2.0 现状）时响亮 warn 一行、
    A2A 服务照常；
  - resume 失败升级为诊断日志（`name`/`code`/`message`/`stack` 头 3 行 + 明确
    "falling back to a NEW session (contextId mapping dropped)"），降级行为不变。
- 新增 `tests/compat.test.mjs`（node:test 纯 stdlib，v3/v4 工具结果夹具对照），
  `pnpm test` 先 `build:host` 再跑测试。

### Changed

- 版本号升至 0.3.0（agent card `version` 同步）。
- `package.json`：所有 dsh peer 依赖范围追加 `|| ^0.2.0-rc.2`（0.2.0 的版本门
  新装不再需要 `allow-version` 豁免）；新增 optional peer + devDependency
  `@deepseek-ai/dsh-agent-preset-registry@0.2.0-rc.2`（0.2.0 的 preset 服务
  提供方；因其 0.2.0 类型链与 0.1.x 的 schemastery 增强冲突，未做
  `import type {}` 类型增强，详见文档）。
- 文档：CONFIGURATION（中英）新增「dsh 0.1.5 / 0.2.0 双版本兼容」章节；README
  （中英）新增「版本与支持」矩阵与 0.2.0 设置面板注记；安装说明调整为
  **npm 优先**（推荐渠道），GitHub 安装改列为尝鲜未发布改动的备选路径。

## [0.2.1] - 2026-09-28

### Fixed

- 会话自动登记到所属工作区（创建后立即归组），并在启动时对存量未分组会话批量捞回补挂，修复经 A2A 创建的会话在 Web UI 显示为「未分组」的问题。
- 启动存量捞回改为等待 `workspaceRegistry` 就绪后执行（`ctx.inject` 运行时依赖），修复重启后 `attached=0` 的竞态。

## [0.2.0] - 2026-09-27

### Added

- 设置面板：dsh Web UI「设置 → 插件 → Plugin configuration」新增 `a2a-server` 设置
  卡片（官方 settings seam，注册命名空间 `a2a-server`，无需改 dsh 仓库、无需白
  名单），可读写 provider / model / preset / cwd / port / host / authToken /
  contextMapPath / contextMapTtlDays；配置分层为 schema 默认 < `cordis.patch.yml` <
  `$DSH_HOME/settings.yaml` 用户覆盖，支持「清除覆盖」回落。
- 浏览器半边与构建产物：新增 client 设置卡（react + locales + card-controller），
  发布物同时包含 host 产物 `lib/` 与浏览器产物 `client/`。
- 新增依赖：`@deepseek-ai/schemastery`（dependencies）及 react 与
  `@deepseek-ai/dsh-client-*`（devDependencies）。

### Changed

- 设置卡改为折叠式卡片：默认收起，点击卡片头在展开/收起间切换；保存成功后
  自动收起、被拒绝的写入保持展开；有未保存改动时卡片头显示「未保存」标记。
  交互与官方插件卡（PluginCard）对齐：头按钮带 `aria-expanded` 与双语
  `aria-label`，chevron 复用模块表共享件
  `@deepseek-ai/dsh-client-ui-primitives`，观感走 `--dsw-*` token。
  折叠状态经根节点 `data-open` 暴露，`data-testid` / `data-ns` /
  `data-scope-status` 契约不变。
- 构建脚本 `build` / `prepare` 改为同时产出 host（`lib/`）与 client（`client/`）
  两半，git 安装由 `prepare` 自动构建。

### Fixed

- `runtimeConfig` 写入由「真值守卫」改为按解析值整份赋值（含 `undefined` 回落），
  修复「清空字段 / 清除覆盖后行为不变」的问题。

## [0.1.0] - 2026-09-12

### Added

- A2A server 初始实现：JSON-RPC over node:http，`@a2a-js/sdk`
  JsonRpcTransportHandler + AgentExecutor 把 A2A task 文本投给 dsh agent 会话
  同步执行。
- agent card：`GET /.well-known/agent-card.json` 公开端点（JSONRPC binding、
  protocolVersion 1.0、capabilities.streaming）。
- Bearer 认证：配置 `authToken` 后强制校验 `Authorization: Bearer ***
- contextId 会话复用 + 跨重启 resume：`message.contextId` 映射到 dsh 会话，映射
  持久化到 `$DSH_HOME/storages/a2a-context-map.json`，带 TTL 清理（默认 7 天）。
- agent-team preset 挂载（`preset: agent-team`）。
- 流式中间事件：`SendStreamingMessage` 实时推思考 / 工具 / 状态 / 文本中间事件
  （text Part + data Part 私有扩展）。
- `SendMessage` 阻塞式返回最终文本（artifact，lastChunk）。

### Changed

- LICENSE 由 MIT 改为 GPL-3.0。

### Security

- 项目以 GPL-3.0 分发；部分实现（agent 会话接管 / agentLocks / origin-map 会话
  复用模式）移植自 chushixixin/dsh-harness-mcp-server（MIT License，Copyright
  chushixixin），原 MIT 版权声明保留，按 MIT 条款再许可纳入本项目（见 README
  「License & Attribution」）。

### Docs

- 双语 README（README.md + README.en.md）。
