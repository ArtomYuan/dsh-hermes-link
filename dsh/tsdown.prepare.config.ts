import { defineConfig } from 'tsdown'

// Consumer-side build for git installs (the `prepare` script): transpile
// straight from src/ without tsc project references or type checking. Git
// installs fetch sources, not built artifacts, so pnpm runs this after
// `dsh plugin add github:...`; it must stay self-contained (no sibling
// monorepo checkout). `tsconfig: false` stops tsdown auto-picking an ancestor
// tsconfig (e.g. the harness monorepo's) so the build depends only on this
// package. `pnpm run typecheck` (P0+) owns type checking.
// `src/compat.ts` 单独成 entry：版本探测/双形状适配是纯 stdlib 模块，
// 以 lib/compat.js 独立产物供 tests/ 直接单测，不必加载整个插件图。
// `src/client/mount-strategy.ts` 同理：客户端设置卡挂载策略的纯函数，单独成
// lib/client/mount-strategy.js 供 tests/mount-strategy.test.mjs 在无 DOM 的 node 里单测。
// `src/client/primitive-symbols.ts` 同理：跨版本宿主符号解析的纯函数（无 React/JSX），
// 单独成 lib/client/primitive-symbols.js 供 tests/primitive-symbols.test.mjs 单测。
// `src/settle.ts` 同理：「释放前等活跃子代理结算」的等待原语（纯逻辑、零 dsh 依赖），
// 单独成 lib/settle.js 供 tests/settle-window.test.mjs 单测。
// `src/questions.ts` 同理：§2.6 问答桥接的纯逻辑面（提问规范化 / 载荷构造 /
// 挂起-解挂-放弃，零 dsh 运行时依赖），单独成 lib/questions.js 供 tests/questions.test.mjs 单测。
// `src/request-options.ts` 同理：§2.1/§2.4 请求级选项（工作区解析 / 沙箱档落地，
// 依赖注入、零 dsh 运行时），单独成 lib/request-options.js 供 tests/request-options.test.mjs 单测。
// `src/link-protocol.ts`：链路协议常量生成物（源 protocol/link-protocol.json），
// 单独成 lib/link-protocol.js 供 tests/contract/ 的 Node 侧契约跑器与漂移校验 import。
// `src/link-binding.ts` 同理：§2.2/§2.3 首选定与绑定记忆（依赖注入、零 dsh 运行时），
// 单独成 lib/link-binding.js 供 tests/link-binding.test.mjs 单测。
export default defineConfig({
  entry: ['src/index.ts', 'src/compat.ts', 'src/settle.ts', 'src/questions.ts', 'src/request-options.ts', 'src/link-protocol.ts', 'src/link-binding.ts', 'src/client/mount-strategy.ts', 'src/client/primitive-symbols.ts'],
  outDir: 'lib',
  format: ['esm'],
  platform: 'node',
  target: 'es2024',
  fixedExtension: false,
  dts: false,
  clean: false,
  tsconfig: false,
})
