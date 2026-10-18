/**
 * 设置卡片挂载策略的纯函数决策（无 DOM、无 dsh 类型依赖，可在 node 里独立单测）。
 *
 * 0.1.5 与 0.2.0 的浏览器设置面走两套互斥契约：
 *  - 0.1.5：`ctx.settingsScope`（`SettingsScopeBinder`）+ `settings.plugin.item` 槽；
 *  - 0.2.0：`ctx.configForms`（`ConfigForms`）+ `plugins.item` 槽（`whileServed` 守卫）。
 * 同一运行时只会提供其中一个服务，因此能力事实（两个 boolean）足以决定走哪条。
 * 0.1.5 优先：只要 settingsScope 存在就选 legacy，保证既有部署不回归。
 */

export type ClientMountStrategy = 'legacy' | 'modern' | 'none'

/** 能力探测输入：两个服务各自是否可用（缺省按不存在处理，容忍 undefined） */
export interface ClientMountCapabilities {
  hasSettingsScope?: boolean
  hasConfigForms?: boolean
}

/**
 * 依据能力事实选择卡片挂载路径：
 *  - 两者都有 → `legacy`（0.1.5 优先，不回归）；
 *  - 只有 settingsScope → `legacy`；
 *  - 只有 configForms → `modern`；
 *  - 都没有 / 缺省 / undefined → `none`。
 *
 * @param caps - 能力探测结果（可整体缺省）
 */
export function pickClientMount(caps: ClientMountCapabilities = {}): ClientMountStrategy {
  if (caps.hasSettingsScope) return 'legacy'
  if (caps.hasConfigForms) return 'modern'
  return 'none'
}
