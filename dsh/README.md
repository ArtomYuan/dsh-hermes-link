# dsh-a2a-server

[English](README.en.md) | **简体中文**

dsh 侧的 A2A (Agent2Agent) server 插件库：把 dsh agent 会话以 A2A 协议暴露给远端
agent（如 Hermes），实现「Hermes = brain，dsh = arms」的互操作。

## 效果

以下效果由本库的 A2A 服务端与流式事件驱动，客户端侧渲染由
[hermes-a2a-bridge](https://github.com/ArtomYuan/hermes-a2a-bridge) 完成（工具命令 /
执行结果 / 最终文本的代码框渲染、进度推送到飞书 / QQ）。

### 直播流样式

投递一个 dsh 任务后，客户端边消费 SSE 流边把中间进度实时推回消息面，用户在
飞书 / QQ 里看到的完整直播序列大致如下（命令与结果以代码框呈现）：

```
🚀 开始执行
🧠 思考中…
🔧 `bash`                    ← 工具调用，命令进代码框
    ┌─ ```bash
    │  ls -la /tmp
    └─ ```
📋 `bash` 完成               ← 工具结果，输出进代码框
    ┌─ ```
    │  total 4
    │  drwxrwxrwt  2 root root 40 Sep 11 14:00 .
    └─ ```
📖 输出完成                  ← 长结果以代码框输出
✅ 完成
```

长文本超过网关单条上限时按代码块边界分块，块间以 `⏩ 续` 提示衔接，代码框不会
跨块断裂。

### 代码框效果

操作内容——工具命令、执行结果、最终文本——会自动以代码框渲染：

- **飞书**：含代码围栏的内容触发 post 富文本，代码框可滚动查看；
- **QQ / 其它主流网关**：markdown 代码块渲染为代码框；
- **纯文本平台**：自动降级为普通文本（不产生乱码）。

代码框内效果示意（`ls -la` 输出块）：

```text
total 4
drwxrwxrwt  2 root root 40 Sep 11 14:00 .
drwxrwxrwt  2 root root 40 Sep 11 14:00 ..
-rw-r--r--  1 root root  0 Sep 11 14:00 demo.txt
```

> 实际效果以各网关客户端渲染为准。

### 事件流侧面

本库产出的流式事件形态示意（`SendStreamingMessage` 下，text Part + data Part
私有扩展，字段取自源码 `StreamEventDescriptor`）：

```
artifactUpdate  artifactId: "stream-text"  append: true         ← 文本块，text Part
artifactUpdate  artifactId: <uuid>  mediaType: application/json  ← 中间事件，data Part
  kind: "tool_call"    { turn, step, name, arguments }
  kind: "tool_result"  { turn, step, name, text }
  kind: "thinking"     { turn, step, text }
  kind: "turn_start"   { turn, step }
  kind: "turn_end"     { turn, step, reason? }
statusUpdate   submitted → working → completed
```

完整字段与机制见 [CONFIGURATION.md](CONFIGURATION.md)。

## 流程图

![架构图](assets/architecture-zh.png)

## 交互问答桥接（0.6.0 起，§2.6）

dsh 在任务中途调用 `ask_user_question` 时，本服务端把该提问**接住并发布**到 A2A 流上：
先发一个 `question` 事件（`artifactUpdate` + `data` Part，含 `askId` 与题目/选项），
再发 `statusUpdate(INPUT_REQUIRED)`（状态消息里带同一载荷，便于 `tasks/get` 查挂起），
**首条流在此收束**——等待期不占长连接。

作答沿 **A2A 原生续投**回来：客户端对**同一 `taskId`** 再发一条消息（报文带
`question-answer` Data Part，含 `askId` + 结构化答案；`skipped=true` 表示跳过），
服务端按 `askId` 解挂，首跳继续跑完，后续事件发在**续投那条流**上。**全程零超时**。

**客户端能力声明（缺省行为不变的保证）**：只有首投报文带
`metadata: {"x-dsh-user-questions": true}`（且走流式）的任务才会被认领；未声明的调用方
提问照旧立刻以 `NO_PROVIDER` 失败，不会进入零超时等待。

```jsonc
// 首投（声明能力）
{"jsonrpc":"2.0","id":"1","method":"SendStreamingMessage","params":{"message":{
  "role":"ROLE_USER","messageId":"...","contextId":"feishu/oc_x/omt_y",
  "metadata":{"x-dsh-user-questions":true},
  "parts":[{"text":"开工","mediaType":"text/plain"}]}}}

// 续投作答（同一 taskId；data part 是机器可读那一段）
{"jsonrpc":"2.0","id":"2","method":"SendStreamingMessage","params":{"message":{
  "role":"ROLE_USER","messageId":"...","taskId":"<首投任务 id>",
  "parts":[{"data":{"kind":"question-answer","askId":"<question 事件的 askId>",
                    "answers":[{"id":"q1","selected":["甲路"],"custom":"备注"}]},
            "mediaType":"application/json"}]}}}
```

- 不新增 / 不删除任何配置键；**首投**报文的行为与「本版之前」完全一致——未声明能力的
  调用方（含同步 `SendMessage` 路径）提问照旧立刻以 `NO_PROVIDER` 失败，绝不进入零超时
  等待。
- **带 `taskId` 的续投**是唯一新增的请求语义：① 带作答载荷（`question-answer`）→ 解挂；
  ② 不带载荷且该任务**没有**未决提问 → 视作普通续投放行并等首跳终态；③ 不带载荷而该
  任务**正等作答** → 明确回 `INPUT_REQUIRED` **收束该次流**（客户端据此知道「任务在等
  输入」），原提问仍等真正的作答——不会留一条永远没有事件的流。
- 提问的三个出口＝作答 / 调用方中止 / 任务收场（`cancelTask` 亦放行），绝不悬挂。
- 已知边界：同一会话并发多个 A2A 任务时提问归属有歧义（认领以 agent 为键），暂未覆盖。

## 请求级选项：工作区与沙箱档（0.7.0 起，§2.1/§2.4）

客户端可在首投报文的 `message.metadata` 里带两个可选键（缺省＝现状，行为与升级前逐字一致）：

```jsonc
{"x-dsh-workspace": "我的书",            // 工作区名字，或绝对路径 "/srv/books/我的书"
 "x-dsh-sandbox": "workspace-write"}    // read-only | workspace-write | danger-full-access
```

- **工作区**：名字先在现有工作区里按 title / 目录名精确匹配（唯一命中即用；多命中→
  报错不猜）；查无 → 在服务端 cwd 下建同名目录并登记；绝对路径经 realpath 规范化后采用（不存在就建）。
  解析出的路径＝会话 cwd。会话复用键本就含 cwd ⇒ **同一对话换工作区＝新会话**，同区复用。
  同名标题但不同 path 的多个工作区→**报错不猜**；**同一 path 的多条记录按 path 去重**，不算歧义。
- **沙箱档**：经 dsh 的 `permissionPresets` 把该**会话**切到同档（与 GUI 手切沙箱同一条
  写路径：`permission/preset` + `sandbox/mode` + `approval/policy`，幂等）。本机部署下
  `read-only`/`workspace-write` 配 `approval=ask`，`danger-full-access` 配 `never`。
- **「读」的圈定程度（2026-10-18 核验修正）**：三档都**不限制读**（bwrap 统一 `--ro-bind / /`）；
  但「只圈写」只对 `read-only` / `workspace-write` 成立——`danger-full-access` **完全不圈**。
  `workspace-write` 的可写面**不止会话 cwd**：还有 `/tmp`（bwrap 下是私有 tmpfs，
  Landlock/Seatbelt 下是真实 `/tmp`）与 `os.tmpdir()`。
- **绝对路径是显式逃生门**：服务端不做 allowlist；若把 workspace 指到 `/` 再配
  `workspace-write`，写边界就是整盘——慎用。
- **待实弹核对**：本机部署 `read-only`/`workspace-write` 配 `approval=ask`，而 A2A 路径没有
  审批回答者；`workspace-write` 下的常见写入是否会被审批拦成「不可用」（而非沙箱拒绝），
  需宿主重载后实测（§3.4 项）。
- **非法值**（未知档位、空工作区、名字含路径分隔符、路径含 `..` 段等）→ 任务以 FAILED
  收口并给出明确原因；**绝不静默改用默认值**。
- 不新增 / 不删除任何配置键；宿主未挂 `permissionPresets` 时告警并保持现状（不改档）。
- **同一对话里「带 workspace」与「不带 workspace」算两个工作区**：不带＝通用区（升级前行为），
  因此两者会落到**两个会话**（复用键含 cwd）。跨调用「记住这次选的工作区」属于 §2.2
  首选定/绑定（本轮未实现）；在那之前，调用方应每次把 `workspace` 带上。

## 与 hermes-a2a-bridge 的关系

本库暴露标准 A2A 接口，不依赖任何特定客户端——其他 A2A 客户端可直接调用。
Hermes 用户如需完整体验（过程直播 / 会话连续性 / 单执行），可搭配
[hermes-a2a-bridge](https://github.com/ArtomYuan/hermes-a2a-bridge)。两库非强绑定，按需组合：

| 组合 | 能实现 |
| --- | --- |
| 只用本库 | 标准 A2A 接口，任意 A2A 客户端可直接调用 |
| 搭配 hermes-a2a-bridge | 完整体验：任务投递 + 过程直播 + 会话连续性 + 单执行 |

## 版本与支持

| 插件版本 | 支持的 dsh |
| --- | --- |
| **0.5.x**（当前） | **0.1.5-rc.2 ∥ 0.2.0-rc.2** —— 双版本并行；0.2.0 上设置区（Settings）与直播流（text/thinking 帧）均可用 |
| 0.4.x | 0.1.5-rc.2 ∥ 0.2.0-rc.2 —— 双版本并行；0.2.0 上设置区可用，但直播流缺 text/thinking 帧 |
| 0.3.x | 0.1.5-rc.2 ∥ 0.2.0-rc.2 —— 双版本并行，同一插件无需切换 |
| 0.2.x | 0.1.x |

0.3.0 起，本插件在 dsh 0.1.5 与 0.2.0 之间升级或回退**无需更换插件**；0.4.0 起 dsh 0.2.0 的设置区（GUI 配置）可用；0.5.0 起 dsh 0.2.0 的直播流（text/thinking 帧）恢复；0.5.1 起释放前等待子代理结算（settleCapMs）。机制细节见
[CONFIGURATION.md](CONFIGURATION.md)。

## 安装说明

本库是独立公开 bundle 包（非 dsh workspace 内包），以 standalone bundle 形态分发。

1. 装进 dsh profile（二选一）：

   - **从 npm 安装（推荐）**：

     ```sh
     dsh plugin --profile <name> add @artomyuan/dsh-a2a-server
     ```

     需要锁定版本时带上版本号：`dsh plugin --profile <name> add @artomyuan/dsh-a2a-server@0.5.1`。

   - **从 GitHub 源码安装**（用于尝鲜尚未发布的改动；**必须固定 commit**）：

     ```sh
     dsh plugin --profile <name> add github:ArtomYuan/dsh-a2a-server#<commit>
     ```

     首次 `add` 会因 pnpm ≥10 默认拒绝 git 依赖的 `prepare` 脚本而失败，按提示把包键
     加入 profile 的 `pnpm-workspace.yaml` 后重跑：

     ```yaml
     allowBuilds:
       @artomyuan/dsh-a2a-server: true
     ```

2. 在 profile 的 cordis 配置里给 A2A server 插件填最小配置（`port` / `authToken` /
   `preset`）：

   ```yaml
   - id: a2a-server
     config:
       port: 8092
       authToken: <token>
       preset: standard
   ```

   `token` 需与 Hermes 侧 `a2a_agents.dsh.auth.token` 一致。

3. 重启 dsh 以加载新插件（方式取决于你的 dsh 部署）：

   ```bash
   # 示例：systemd 用户级服务
   systemctl --user restart dsh
   ```

## 设置面板

dsh Web UI「设置 → 插件 → Plugin configuration」会自动出现 `a2a-server` 设置卡片，
只要该插件被 profile 组合即可，无需改 dsh 仓库、无需白名单。实现走 dsh 官方
settings 能力：host 侧注册 settings 命名空间 `a2a-server`（schema 由 schemastery
定义），浏览器侧提供一张设置卡。

> **dsh 0.2.0 现状**：0.2.0 无 `installSection`/`register` 注册缝，设置区改由插件
> 导出的运行时 `Config` schema 派生（命名空间仍为 `a2a-server`）。与 0.1.5 的差异：
> 表单编辑落在 **profile 的 `cordis.patch.yml`**（非 `settings.yaml`），且派生区一律报
> `applies: 'live'`，但 `port`/`host`/`contextMapPath` 实际需重启。详见
> [CONFIGURATION.md](CONFIGURATION.md)。

### 配置分层

- `cordis.patch.yml` 里的插件 `config` 仍是 composition（base）层与事实源；
- 面板上的修改写入 dsh 用户设置文档 `$DSH_HOME/settings.yaml`，作为**用户覆盖层**；
- 解析顺序：schema 默认值 < `cordis.patch.yml` < 用户覆盖。

面板会标出哪些字段被用户层覆盖，并提供「清除覆盖」回落到 `cordis.patch.yml` 的值。

### 字段与生效时机

| 字段 | 生效时机 |
| --- | --- |
| `provider` / `model` / `preset` / `cwd` / `authToken` / `contextMapTtlDays` | 保存后下一次 A2A 请求即生效（无需重启） |
| `port` / `host` / `contextMapPath` | 保存后需重启 dsh（或重新加载 profile）才生效；当前运行实例仍监听启动时的地址 |

- `model` 留空（空串）= 跟随 dsh 当前默认模型；`cwd` 留空 = `process.cwd()`；
  `port` 留空 = 启动时自动探测可用端口。

### 凭据（authToken）

- 面板上只写不回显（永远显示「已设置 / 未设置」，输入框空起始；空白输入 =
  不修改）。
- 「清除覆盖」只删除用户层覆盖并回落到 `cordis.patch.yml` 的既有令牌，绝不
  静默关闭鉴权。
- 最终解析值为空时面板显性警示「未设置 = 无鉴权（危险）」。
- 环境变量 `A2A_SERVER_TOKEN` 优先级高于配置，此时面板显示「由环境变量接管」
  而不可编辑。

### 降级

settings 服务不存在时插件照常工作，只使用 `cordis.patch.yml` 的配置。

安装无需额外步骤：`link:` 或正常安装后重启 dsh 即可；发布物同时包含 host 产物
`lib/` 与浏览器产物 `client/`，从 git 安装由 `prepare` 脚本自动构建两半。

## 链接

- 详细配置与机制说明：[CONFIGURATION.md](CONFIGURATION.md)
- 变更记录：[CHANGELOG.md](CHANGELOG.md)
- 许可证：[License & Attribution](#license--attribution)

## License & Attribution

本项目以 GNU General Public License v3.0（GPL-3.0）分发，全文见 `LICENSE`。部分实现
（agent 会话接管 / agentLocks / origin-map 会话复用模式）移植自
[chushixixin/dsh-harness-mcp-server](https://github.com/chushixixin/dsh-harness-mcp-server)
（MIT License，Copyright chushixixin），原 MIT 版权声明保留，按 MIT 条款再许可纳入本项目。
