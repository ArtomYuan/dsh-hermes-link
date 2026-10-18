/**
 * 宿主原语的**运行时解析 + 本地兜底**包装（浏览器半边）。
 *
 * 卡片不再静态按名导入宿主符号，而是经 {@link resolveComponent} 从宿主模块的
 * 命名空间对象上按候选名解析（见 `primitive-symbols.ts` 的机制说明）。解析不到
 * 时改用本文件里的本地实现，保证**任一版本上都不会渲染 `undefined`**（React #130）。
 *
 * 兜底不是临时补丁：0.2.0 已把图标命名从尺寸后缀换成变体后缀，同类改名今后仍可能
 * 发生；本地兜底让卡片对宿主图标面的变化免疫，而宿主提供的符号仍优先使用，观感
 * 与宿主保持一致。
 */

import * as hostPrimitives from '@deepseek-ai/dsh-client-ui-primitives'
import type { ComponentType, ReactNode } from 'react'
import { CHEVRON_DOWN_CANDIDATES, TAG_CANDIDATES, resolveComponent } from './primitive-symbols.ts'

/** 宿主图标组件的 props（两版 `IconProps` 逐字相同） */
interface HostIconProps {
  size?: number
  className?: string
}

/** 宿主标签组件的 props（本卡片只用 tone + children） */
interface HostTagProps {
  tone?: 'outline' | 'solid' | 'neutral' | 'quiet' | 'success' | 'info' | 'warning' | 'danger'
  children?: ReactNode
}

const host = hostPrimitives as unknown as Record<string, unknown>

/** 解析到的宿主箭头图标（0.1.5 或 0.2.0 的任一候选名），缺失即 undefined */
const HostChevronDown = resolveComponent<ComponentType<HostIconProps>>(host, CHEVRON_DOWN_CANDIDATES)

/** 解析到的宿主 Tag，缺失即 undefined */
const HostTag = resolveComponent<ComponentType<HostTagProps>>(host, TAG_CANDIDATES)

/**
 * 本地绘制的 14px 折叠箭头（宿主无任何候选图标时使用）。
 * 尺寸/线宽/圆角对齐 0.1.5 `IconChevronDownOutline14` 的观感，颜色随 currentColor。
 */
function LocalChevronDown(): ReactNode {
  return (
    <svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden="true" focusable="false">
      <path
        d="M3.75 5.5 7 8.75 10.25 5.5"
        stroke="currentColor"
        strokeWidth="1.2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  )
}

/** 本地标签胶囊兜底样式（近似宿主 `Tag tone="neutral"` 的观感） */
const localTagStyle = {
  display: 'inline-flex',
  alignItems: 'center',
  height: '18px',
  padding: '0 6px',
  borderRadius: '4px',
  fontSize: '11px',
  lineHeight: 1,
  color: 'var(--dsw-alias-label-secondary)',
  background: 'var(--dsw-alias-bg-base)',
  border: '0.5px solid var(--dsw-alias-border-l2)',
} as const

/**
 * 折叠箭头：优先宿主图标（保持与宿主观感一致），缺失时用本地 SVG。
 * @returns 可渲染元素
 */
export function ChevronDown(): ReactNode {
  return HostChevronDown ? <HostChevronDown /> : <LocalChevronDown />
}

/**
 * 中性标签胶囊：优先宿主 `Tag`，缺失时用本地胶囊，两者都只吃 children。
 * @param props.children - 标签文案
 * @returns 可渲染元素
 */
export function SettingsTag({ children }: { children?: ReactNode }): ReactNode {
  return HostTag ? <HostTag tone="neutral">{children}</HostTag> : <span style={localTagStyle}>{children}</span>
}

/** 供测试与诊断使用：本模块实际解析到的宿主符号名（未解析到为 undefined） */
export const resolvedHostSymbols: { readonly chevron: boolean; readonly tag: boolean } = {
  chevron: HostChevronDown !== undefined,
  tag: HostTag !== undefined,
}
