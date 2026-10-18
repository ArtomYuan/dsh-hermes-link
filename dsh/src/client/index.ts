/**
 * dsh-a2a-server 设置卡片的浏览器半边：注册双语文案，并把 A2A 卡片挂进设置面板。
 *
 * 双版本互斥挂载（能力探测，见 mount-strategy.ts）：
 *  - 0.1.5：`settingsScope` + `settings.plugin.item` 槽（key = settings 命名空间
 *    `a2a-server`，与 host 半边注册的名字配对），行为原样不变；
 *  - 0.2.0：`configForms` + `whileServed(['a2a-server'])` + `plugins.item` 槽
 *    （list 槽，照抄官方 dsh-client-ui-settings-{subagent,agent-loop,…} 的注册形状）。
 *
 * 两个服务都走嵌套 inject：不写进模块级 inject，让缺少对应服务的 host 上整个插件
 * 仍能挂载，只是不出现卡片（0.1.5 上无 configForms、0.2.0 上无 settingsScope）。
 */

import type { Context as ClientContext } from '@deepseek-ai/cordis'
// 类型声明合并：ctx.locale（LocaleRuntime + register/bind）
import type {} from '@deepseek-ai/dsh-client-locale/client'
// 类型声明合并：ctx.settingsScope（SettingsScopeBinder）+ SettingsDescribeFace
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
// 类型声明合并：settings.plugin.item 槽声明（slot-contract）
import type {} from '@deepseek-ai/dsh-client-ui-settings-plugins/client'
// 类型声明合并：ctx.slots（SlotRegistry）
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type { SettingsDescribeFace } from '@deepseek-ai/dsh-client-ui-settings/client'
import { A2ASettingsCard } from './A2ASettingsCard.tsx'
import {
  A2A_SETTINGS_NS,
  A2ASettingsCardController,
  legacyScopeSource,
  type A2AFormSource,
  type A2ASettingsValue,
} from './card-controller.ts'
import { en, zh } from './locales.ts'
import { pickClientMount, type ClientMountStrategy } from './mount-strategy.ts'

/** Cordis 插件名 */
export const name = '@artomyuan/dsh-a2a-server'

/** 依赖的服务（settingsScope / configForms 走嵌套 inject，见模块注释） */
export const inject = ['slots', 'locale']

/** 文案命名空间（双字典键集一致，见 locales.ts） */
const NS = 'settings.a2aServer'

/**
 * 0.2.0 `ctx.configForms` 服务的最小结构契约（本地声明，不引入 0.2.0 devDep）。
 * 运行时由 `@deepseek-ai/dsh-client-ui-settings` 提供；0.1.5 无此服务。
 */
interface A2AConfigFormsService {
  get<T>(entryId: string): A2AFormSource<T>
  describe(): SettingsDescribeFace
  whileServed(
    namespaces: readonly string[],
    register: (served: ReadonlySet<string>) => () => void,
  ): () => void
}

/** 0.2.0 `plugins.item` 槽的 owner props（本地最小声明，view 区分列表一栏/整页表单） */
interface A2APluginConfigViewProps {
  view: 'summary' | 'page'
  form?: unknown
}

// 类型声明合并：ctx.configForms（0.2.0 的 configForms 服务，0.1.5 无）
declare module '@deepseek-ai/cordis' {
  interface Context {
    configForms: A2AConfigFormsService
  }
}

// 类型声明合并：0.2.0 `plugins.item` 槽声明（list 槽，官方 plugin-manager 声明，
// 此处本地最小复刻以通过 register 的类型检查）
declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface SlotMap {
    'plugins.item': {
      kind: 'list'
      scope: 'root'
      owner: A2APluginConfigViewProps
    }
  }
}

/**
 * 挂载设置卡片：注册字典 + 按能力探测走 legacy（0.1.5）或 modern（0.2.0）路径。
 * 两条路径互斥：共享 `mounted` 标志保证同一实例只挂一次。
 * @param ctx - 浏览器插件 context
 */
export function apply(ctx: ClientContext): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'dsh-a2a-server: card dictionaries')

  const t = ctx.locale.bind(NS)
  /** 0.1.5 与 0.2.0 的设置服务跨版本互斥，正常 host 上只触发其一；标志防病态双服务 */
  let mounted: ClientMountStrategy | undefined

  // 0.1.5 路径（行为原样不变）：settingsScope + settings.plugin.item（keyed）
  ctx.inject(['settingsScope'], (scoped) => {
    const strategy = pickClientMount({
      hasSettingsScope: scoped.get('settingsScope') !== undefined,
      hasConfigForms: scoped.get('configForms') !== undefined,
    })
    if (mounted !== undefined || strategy !== 'legacy') return
    mounted = strategy
    const controller = new A2ASettingsCardController(
      legacyScopeSource(scoped.settingsScope.bind({ namespace: A2A_SETTINGS_NS })),
      scoped.settingsScope.describe(),
      scoped,
    )
    scoped.slots.inject('settings.plugin.item', () => scoped.slots.register({
      name: 'settings.plugin.item',
      key: A2A_SETTINGS_NS,
      locale: NS,
      inject: () => controller.inject(),
    }, A2ASettingsCard))
  })

  // 0.2.0 路径：configForms + whileServed + plugins.item（list，照抄官方注册形状）
  ctx.inject(['configForms'], (scoped) => {
    const strategy = pickClientMount({
      hasSettingsScope: scoped.get('settingsScope') !== undefined,
      hasConfigForms: scoped.get('configForms') !== undefined,
    })
    if (mounted !== undefined || strategy !== 'modern') return
    mounted = strategy
    const configForms = scoped.configForms
    const controller = new A2ASettingsCardController(
      configForms.get<A2ASettingsValue>(A2A_SETTINGS_NS),
      configForms.describe(),
      scoped,
    )
    ctx.effect(() => configForms.whileServed([A2A_SETTINGS_NS], () => scoped.slots.inject('plugins.item', () => scoped.slots.register({
      name: 'plugins.item',
      id: A2A_SETTINGS_NS,
      order: 50,
      label: () => t('a2aTitle'),
      locale: NS,
      inject: () => controller.inject(),
    }, A2ASettingsCard))), 'dsh-a2a-server: page')
  })
}
