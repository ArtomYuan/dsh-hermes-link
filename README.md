# dsh-hermes-link

> **Hermes ⇄ DeepSeek Harness 连接层：一个产品、一个仓库、一套版本、一次安装。**
> 自 2026-10-19 起，原 `hermes-a2a-bridge`（Python 桥）与 `dsh-a2a-server`（TS 服务端）
> 合并到本仓库（两树带完整历史：`hermes/`、`dsh/`）。**两个包名与安装路径都不变**：
> 桥仍是 Hermes 插件 `hermes-a2a-bridge`，服务端仍是 npm 包 `@artomyuan/dsh-a2a-server`。

## 形态

```
Hermes 网关 ── hermes/（Python 桥，薄壳）──A2A over HTTP(SSE)── dsh/（TS 服务端，大脑）── dsh
               拦截 a2a_call / 流渲染 / 投递 / 卡片         解析请求级选项 / 绑定记忆 / 提问登记
```

- **桥是薄壳**：只做 hook 拦截、直播渲染、结果送达、卡片与点击捕获；
- **服务端是大脑**：工作区解析、沙箱档落地、**§2.2 首选定与 §2.3 绑定记忆**、提问/作答登记；
- **协议单一来源**：`protocol/link-protocol.json` → 生成 `hermes/link_protocol.py` 与
  `dsh/src/link-protocol.ts`（`python3 protocol/gen.py --check` 防漂移）；
- **两半仍是两个进程**，A2A 缝不动；不合并运行时。

## 安装

```sh
scripts/install.sh --dry-run   # 演练（只打印，不写任何文件）
scripts/install.sh             # 真实安装：版本配对 → 装服务端 → 验 agent-card → 装桥
scripts/verify.sh              # 自检：版本握手 + 8091 健康 + 飞书连接 + 协议漂移
scripts/uninstall.sh          # 反序卸载：桥先退 → 服务端后退（恢复最近备份）
```

- **版本单号锁步**（自 0.10.0 起）：`hermes/plugin.yaml`、`dsh/package.json`、agent-card
  三者同号；**不配对拒装**。
- **顺序门禁内置**：先服务端；`install.sh` 会等 agent-card 报出新版本才装桥（未重载时报错
  并给出下一步）；回滚反序。
- **脚本只落位文件、不重启服务**：重载由宿主侧执行（dsh web / 网关各一次）。

## 验证与全测

```sh
scripts/test-all.sh           # 协议 --check + 双侧契约 + 桥 394 + 服务端 109
dsh/  : tsc + tsdown + node --test tests/*.test.mjs
hermes/: python3 -B tests/test_*.py（逐文件）
```

## 契约（两侧同跑）

`tests/contract/fixtures/` 五件：请求级选项（名字/路径）、提问载荷、作答报文、失败状态、
路径形态。Python 跑器 20 断言、Node 跑器 9 断言，**同一份期望**。

## 版本与账本

- `CHANGELOG.md`（根，唯一账本，双语小节）——自 0.10.0 起所有变更记在这里；
  两包内 `CHANGELOG.md` 为历史账本（0.10.0 起指向根账本）。
- 配置说明：`CONFIGURATION.md`（双语小节）；各半的细节文档仍在
  `hermes/README.md`、`hermes/CONFIGURATION.md`、`dsh/README.md`。
- Hermes 源码树补丁（`a2a_call` 的 `workspace`/`sandbox` 参数面）登记在
  `~/.hermes/docs/hermes/custom-patches.md`，随 Hermes 升级重打。

## 回退

1. `scripts/uninstall.sh`（先退桥、后退服务端）→ 宿主侧重载两进程；
2. 或按冻结 tag 整体回退：旧库 tag `hermes-a2a-bridge@v0.9.0` / `dsh-a2a-server@v0.7.0`
   （合并前基线的完整可运行状态）。

## English (short)

`dsh-hermes-link` merges the Hermes bridge (`hermes/`, Python plugin, package name
`hermes-a2a-bridge`) and the dsh A2A server (`dsh/`, npm package
`@artomyuan/dsh-a2a-server`) into one repository with one lock-step version, a single
protocol source (`protocol/link-protocol.json` → generated Python/TypeScript constants),
shared contract fixtures (`tests/contract/`), and a one-command installer
(`scripts/install.sh`, server-first ordering gate; `scripts/verify.sh`; `scripts/uninstall.sh`
in reverse order). Package names and install paths are unchanged; the two halves remain two
processes speaking A2A over HTTP/SSE.
