/**
 * 跨版本宿主符号的**纯函数**解析层（无 React、无 JSX，可在 node 里独立单测）。
 *
 * 为什么需要它：浏览器半边与宿主包之间是 **bundle external** 关系——产物里以
 * 「命名空间属性访问」形态引用宿主模块（编译产出形如
 * `_deepseek_ai_dsh_client_ui_primitives.Tag`）。因此**静态按名导入一个宿主没有的
 * 导出不会构建失败、也不会链接失败，只会在运行时得到 `undefined`**；把它当
 * 组件渲染即 React #130（element type is invalid），而且只在 details 维度炸
 * （summary 不渲染该符号）——正是 2026-10-05 浏览器实测抓到的崩溃形态。
 *
 * 实测的两版差异（`@deepseek-ai/dsh-client-ui-primitives`）：
 *  - 图标命名：0.1.5 用**尺寸后缀**（`IconChevronDownOutline14`）；0.2.0 改为
 *    **变体后缀**（`IconChevronDownOutlineRegular` 1px / `…Medium` 1.3px），
 *    `…14` 在 0.2.0 全树零命中。
 *  - `Tag` 在两版契约一致（`TagTone` 取值集合逐字相同），但仍按同一套机制解析，
 *    避免「某天某版改掉它」时重演同一类崩溃。
 *
 * 结论：**按候选名列表运行时解析 + 本地兜底**，两端都不再依赖单一版本的符号面。
 */

/** React 可接受的元素类型判定：函数组件 / 字符串（内置标签）/ 带 $$typeof 的 memo·forwardRef 包装 */
export function isComponentType(value: unknown): boolean {
  if (typeof value === 'function' || typeof value === 'string') return true
  return typeof value === 'object' && value !== null && '$$typeof' in value
}

/**
 * 按候选名顺序解析宿主模块上的组件符号，取第一个可用者。
 *
 * @param source - 宿主模块的命名空间对象（可整体缺省/异常形状）
 * @param names - 候选导出名，**按版本优先级排列**
 * @returns 解析到的可渲染组件类型；全部缺失时返回 `undefined`（由调用方走本地兜底）
 */
export function resolveComponent<P>(
  source: Record<string, unknown> | undefined | null,
  names: readonly string[],
): P | undefined {
  if (source === undefined || source === null) return undefined
  for (const name of names) {
    const candidate = source[name]
    if (isComponentType(candidate)) return candidate as P
  }
  return undefined
}

/**
 * 折叠箭头图标的候选名（按优先级）：
 * 0.1.5 的尺寸后缀命名优先（保持既有观感），随后是 0.2.0 的变体命名，
 * 最后是 0.2.0 的基名兜底。全缺失时由本地 SVG 兜底。
 */
export const CHEVRON_DOWN_CANDIDATES: readonly string[] = [
  'IconChevronDownOutline14',
  'IconChevronDownOutlineRegular',
  'IconChevronDownOutlineMedium',
  'IconChevronDownOutline',
]

/** 标签胶囊的候选名（两版同名；保留列表形态以便同一套机制扩展） */
export const TAG_CANDIDATES: readonly string[] = ['Tag']
