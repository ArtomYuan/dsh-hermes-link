/**
 * A2A Server 设置卡片：读取 `a2a-server` settings 命名空间的快照，分组渲染
 * 「即时生效」与「重启后生效」字段。全部自持：内联样式（不用 CSS Modules，
 * 避免引入 lightningcss 构建链）、无跨插件 value import。
 *
 * 卡片头是折叠开关（官方 PluginCard 同款交互）：默认收起，点击标题在展开/
 * 收起间切换，保存成功后自动收起、失败则保持展开并保留草稿。折叠是本卡的
 * 阅读状态，草稿由 controller 持有，收起不丢改动；带头在收起态显示「未保存」
 * 标记。头按钮带 aria-expanded 与 aria-label（双语字典）。
 *
 * 根节点始终带 data-testid / data-ns / data-scope-status（外加 data-open 与
 * 头/体/未保存标记的 data-testid），非 ready 时只加 `hidden` 而不返回 null
 * ——CDP 可用 DOM 存在性判定卡片「真渲染」（决策 C9）。
 */

import { useEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import type { SnapshotSelectorHook, TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import { ChevronDown, SettingsTag } from './primitives.tsx'
import type { A2ACardKey } from './locales.ts'
import type {
  A2AEditableField,
  A2ASettingsCardState,
} from './card-controller.ts'

/** 卡片组件 props（由 slots renderer 按注册声明合成） */
export interface A2ASettingsCardProps {
  t: TranslateNS<'settings.a2aServer'>
  useA2aSettings: SnapshotSelectorHook<A2ASettingsCardState>
  edit: (field: A2AEditableField | 'authToken', text: string) => void
  save: () => void
  discard: () => void
  clearOverride: (field: A2AEditableField) => void
  clearAuthToken: () => void
  /**
   * 0.2.0 `plugins.item` 槽的 owner 视图：`summary` 渲染卡片一栏（标题下的一行
   * 简介），`page` 渲染完整表单。0.1.5 的 `settings.plugin.item` 槽不传此 prop。
   */
  view?: 'summary' | 'page'
}

// ── 内联样式（无 CSS Modules 构建链，观感对齐官方 PluginCard）─────────

const cardStyle: React.CSSProperties = {
  listStyle: 'none',
  fontFamily: 'inherit',
  fontSize: '13px',
  lineHeight: 1.5,
  color: 'inherit',
  border: '0.5px solid var(--dsw-alias-border-l4)',
  borderRadius: '16px',
  background: 'var(--dsw-alias-bg-layer-3)',
  transition: 'border-color .16s, background .16s',
}

/** 展开态读作「正在编辑的那张卡」，而不只是变高了 */
const cardOpenStyle: React.CSSProperties = {
  background: 'var(--dsw-alias-bg-layer-2)',
  borderColor: 'var(--dsw-alias-label-dimmed)',
}

const headerStyle: React.CSSProperties = {
  width: '100%',
  appearance: 'none',
  border: 0,
  background: 'none',
  font: 'inherit',
  color: 'inherit',
  textAlign: 'left',
  cursor: 'pointer',
  display: 'flex',
  alignItems: 'center',
  gap: '12px',
  padding: '14px 16px',
  borderRadius: '12px',
}

const headTextStyle: React.CSSProperties = {
  flex: 1,
  minWidth: 0,
  display: 'flex',
  flexDirection: 'column',
  gap: '4px',
}

const nameStyle: React.CSSProperties = {
  fontSize: '15px',
  fontWeight: 600,
  lineHeight: 1.4,
  color: 'var(--dsw-alias-label-primary)',
}

const descriptionStyle: React.CSSProperties = {
  fontSize: '13px',
  lineHeight: 1.5,
  color: 'var(--dsw-alias-label-tertiary)',
}

/** 未保存标记的定位壳（胶囊外观由 Tag 提供；Tag 不接受 data-* 透传） */
const pendingStyle: React.CSSProperties = {
  flex: 'none',
  display: 'inline-flex',
}

const chevronStyle: React.CSSProperties = {
  flex: 'none',
  display: 'inline-flex',
  color: 'var(--dsw-alias-label-tertiary)',
  transition: 'transform .16s',
}

const chevronOpenStyle: React.CSSProperties = {
  transform: 'rotate(180deg)',
}

const bodyStyle: React.CSSProperties = {
  borderTop: '0.5px solid var(--dsw-alias-border-l2)',
  margin: '0 16px',
  paddingTop: '12px',
  paddingBottom: '8px',
}

const groupStyle: React.CSSProperties = {
  marginBottom: '14px',
}

const groupLabelStyle: React.CSSProperties = {
  margin: '0 0 2px',
  fontSize: '13px',
  fontWeight: 600,
}

const groupHintStyle: React.CSSProperties = {
  margin: '0 0 6px',
  fontSize: '12px',
  opacity: 0.6,
}

const rowStyle: React.CSSProperties = {
  display: 'flex',
  flexWrap: 'wrap',
  alignItems: 'center',
  gap: '6px 10px',
  padding: '6px 0',
  borderTop: '1px solid rgba(128, 128, 128, 0.18)',
}

const labelStyle: React.CSSProperties = {
  flex: '0 0 130px',
  fontSize: '13px',
}

const inputStyle: React.CSSProperties = {
  flex: '1 1 220px',
  minWidth: 0,
  padding: '5px 8px',
  fontSize: '13px',
  fontFamily: 'inherit',
  color: 'inherit',
  background: 'transparent',
  border: '1px solid rgba(128, 128, 128, 0.4)',
  borderRadius: '4px',
}

const badgeStyle: React.CSSProperties = {
  padding: '1px 6px',
  fontSize: '11px',
  borderRadius: '3px',
  border: '1px solid rgba(128, 128, 128, 0.4)',
  opacity: 0.85,
}

const dangerBadgeStyle: React.CSSProperties = {
  ...badgeStyle,
  borderColor: 'rgba(224, 96, 64, 0.8)',
  color: '#e06040',
}

const envBadgeStyle: React.CSSProperties = {
  ...badgeStyle,
  borderColor: 'rgba(64, 128, 224, 0.8)',
  color: '#4080e0',
}

const buttonStyle: React.CSSProperties = {
  padding: '4px 10px',
  fontSize: '12px',
  fontFamily: 'inherit',
  color: 'inherit',
  background: 'transparent',
  border: '1px solid rgba(128, 128, 128, 0.5)',
  borderRadius: '4px',
  cursor: 'pointer',
}

const primaryButtonStyle: React.CSSProperties = {
  ...buttonStyle,
  borderColor: 'rgba(64, 128, 224, 0.9)',
  color: '#4080e0',
}

const fieldHintStyle: React.CSSProperties = {
  flexBasis: '100%',
  margin: '2px 0 0 140px',
  fontSize: '12px',
  opacity: 0.6,
}

const invalidStyle: React.CSSProperties = {
  flexBasis: '100%',
  margin: '2px 0 0 140px',
  fontSize: '12px',
  color: '#e06040',
}

const footerStyle: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'flex-end',
  gap: '10px',
  marginTop: '10px',
}

const failedStyle: React.CSSProperties = {
  flex: 1,
  minWidth: 0,
  fontSize: '12px',
  color: '#e06040',
}

/** 字段 → 标签/提示文案键（静态映射，t 保持类型检查） */
const FIELD_LABEL_KEYS: Record<A2AEditableField, A2ACardKey> = {
  provider: 'fieldProvider',
  model: 'fieldModel',
  preset: 'fieldPreset',
  cwd: 'fieldCwd',
  port: 'fieldPort',
  host: 'fieldHost',
  contextMapPath: 'fieldContextMapPath',
  contextMapTtlDays: 'fieldContextMapTtlDays',
}

const FIELD_HINT_KEYS: Record<A2AEditableField, A2ACardKey> = {
  provider: 'fieldProviderHint',
  model: 'fieldModelHint',
  preset: 'fieldPresetHint',
  cwd: 'fieldCwdHint',
  port: 'fieldPortHint',
  host: 'fieldHostHint',
  contextMapPath: 'fieldContextMapPathHint',
  contextMapTtlDays: 'fieldContextMapTtlDaysHint',
}

/** 字段行：标签 + 输入 + 覆盖标记/清除 + 生效时机提示 */
function FieldRow(props: {
  t: A2ASettingsCardProps['t']
  label: string
  hint: string
  field: A2AEditableField
  state: A2ASettingsCardState
  disabled: boolean
  onEdit: (field: A2AEditableField, text: string) => void
  onClear: (field: A2AEditableField) => void
}): ReactNode {
  const { t, label, hint, field, state, disabled, onEdit, onClear } = props
  const fieldState = state.fields[field]
  return (
    <div style={rowStyle}>
      <span style={labelStyle}>{label}</span>
      <input
        style={inputStyle}
        type={field === 'port' || field === 'contextMapTtlDays' ? 'number' : 'text'}
        value={fieldState.text}
        disabled={disabled}
        onChange={(event) => { onEdit(field, event.target.value) }}
      />
      {fieldState.overridden ? (
        <span style={badgeStyle}>{t('overridden')}</span>
      ) : null}
      {fieldState.overridden ? (
        <button
          style={buttonStyle}
          disabled={disabled}
          onClick={() => { onClear(field) }}
        >
          {t('clearOverride')}
        </button>
      ) : null}
      {fieldState.invalid !== null ? (
        <span style={invalidStyle}>{t(fieldState.invalid as 'invalidPort' | 'invalidTtl')}</span>
      ) : (
        <span style={fieldHintStyle}>{hint}</span>
      )}
    </div>
  )
}

/**
 * 渲染卡片。
 * @param props - locale 座位、绑定好的 useA2aSettings 钩子与表单动作
 * @returns 卡片根节点（始终带判定属性，见模块注释）
 */
export function A2ASettingsCard(props: A2ASettingsCardProps): ReactNode {
  const { t } = props
  const state = props.useA2aSettings(snapshot => snapshot)
  const [open, setOpen] = useState(false)
  const [confirmClearToken, setConfirmClearToken] = useState(false)
  const saveStarted = useRef(false)
  const ready = state.status === 'ready'
  const disabled = !state.writable || state.saving

  // 保存成功后自动收起；被拒绝或失败的写入保持展开，让诊断与草稿留在眼前。
  useEffect(() => {
    if (state.saving) {
      saveStarted.current = true
      return
    }
    if (!saveStarted.current) return
    saveStarted.current = false
    if (!state.dirty && !state.failed) setOpen(false)
  }, [state.dirty, state.failed, state.saving])

  // 0.2.0 plugins.item 的 summary 视图：只渲染一行简介（官方 SubagentCard 同款），
  // 整页表单在 view === 'page'（或 0.1.5 无 view prop）时走下方完整渲染。
  if (props.view === 'summary') return t('a2aDescription')

  const liveFields: A2AEditableField[] = ['provider', 'model', 'preset', 'cwd', 'contextMapTtlDays']
  const restartFields: A2AEditableField[] = ['port', 'host', 'contextMapPath']

  const token = state.fields.authToken
  const tokenDisabled = disabled || token.envToken
  const title = t('a2aTitle')

  return (
    <li
      style={open ? { ...cardStyle, ...cardOpenStyle } : cardStyle}
      hidden={!ready || undefined}
      data-testid="a2a-server-card"
      data-ns="a2a-server"
      data-scope-status={state.status}
      data-open={open ? 'true' : 'false'}
    >
      {!ready ? (
        <p style={{ margin: 0, padding: '14px 16px' }}>
          {state.status === 'loading' ? t('loading') : t('unavailable')}
        </p>
      ) : (
        <>
          <button
            type="button"
            style={headerStyle}
            data-testid="a2a-server-card-header"
            aria-expanded={open}
            aria-label={`${t(open ? 'collapse' : 'expand')}: ${title}`}
            onClick={() => { setOpen(!open) }}
          >
            <span style={headTextStyle}>
              <span style={nameStyle}>{title}</span>
              <span style={descriptionStyle}>{t('a2aDescription')}</span>
            </span>
            {state.dirty ? (
              <span style={pendingStyle} data-testid="a2a-server-card-unsaved">
                <SettingsTag>{t('unsaved')}</SettingsTag>
              </span>
            ) : null}
            <span style={open ? { ...chevronStyle, ...chevronOpenStyle } : chevronStyle}>
              <ChevronDown />
            </span>
          </button>

          {open ? (
            <div style={bodyStyle} data-testid="a2a-server-card-body">
              <div style={groupStyle}>
                <p style={groupLabelStyle}>{t('groupLive')}</p>
                <p style={groupHintStyle}>{t('groupLiveHint')}</p>
                {liveFields.map(field => (
                  <FieldRow
                    key={field}
                    t={t}
                    label={t(FIELD_LABEL_KEYS[field])}
                    hint={t(FIELD_HINT_KEYS[field])}
                    field={field}
                    state={state}
                    disabled={disabled}
                    onEdit={props.edit}
                    onClear={props.clearOverride}
                  />
                ))}

                {/* authToken：只写不回显 */}
                <div style={rowStyle}>
                  <span style={labelStyle}>{t('fieldAuthToken')}</span>
                  <input
                    style={inputStyle}
                    type="password"
                    value={token.text}
                    disabled={tokenDisabled}
                    placeholder={t('authTokenPlaceholder')}
                    onChange={(event) => { props.edit('authToken', event.target.value) }}
                  />
                  {token.envToken ? (
                    <span style={envBadgeStyle}>{t('authTokenEnvBadge')}</span>
                  ) : token.configured ? (
                    <span style={badgeStyle}>{t('authTokenSet')}</span>
                  ) : (
                    <span style={dangerBadgeStyle}>{t('authTokenUnsetDanger')}</span>
                  )}
                  {token.configured && !token.envToken ? (
                    confirmClearToken ? (
                      <span>
                        <span style={fieldHintStyle}>{t('authTokenClearConfirmText')}</span>
                        <button
                          style={dangerBadgeStyle}
                          disabled={disabled}
                          onClick={() => {
                            setConfirmClearToken(false)
                            props.clearAuthToken()
                          }}
                        >
                          {t('confirm')}
                        </button>
                        <button style={buttonStyle} onClick={() => { setConfirmClearToken(false) }}>
                          {t('cancel')}
                        </button>
                      </span>
                    ) : (
                      <button
                        style={buttonStyle}
                        disabled={disabled}
                        onClick={() => { setConfirmClearToken(true) }}
                      >
                        {t('clearOverride')}
                      </button>
                    )
                  ) : null}
                  {token.envToken ? (
                    <span style={fieldHintStyle}>{t('authTokenEnvHint')}</span>
                  ) : token.configured ? null : (
                    <span style={fieldHintStyle}>{t('authTokenUnset')} — {t('fieldAuthTokenHint')}</span>
                  )}
                </div>
              </div>

              <div style={groupStyle}>
                <p style={groupLabelStyle}>{t('groupRestart')}</p>
                <p style={groupHintStyle}>{t('groupRestartHint')}</p>
                {restartFields.map(field => (
                  <FieldRow
                    key={field}
                    t={t}
                    label={t(FIELD_LABEL_KEYS[field])}
                    hint={t(FIELD_HINT_KEYS[field])}
                    field={field}
                    state={state}
                    disabled={disabled}
                    onEdit={props.edit}
                    onClear={props.clearOverride}
                  />
                ))}
              </div>

              <div style={footerStyle}>
                {state.failed ? <span style={failedStyle}>{t('saveFailed')}</span> : null}
                <button
                  style={buttonStyle}
                  disabled={disabled || !state.dirty}
                  onClick={() => { props.discard() }}
                >
                  {t('discard')}
                </button>
                <button
                  style={primaryButtonStyle}
                  disabled={disabled || !state.dirty || state.invalid}
                  onClick={() => { props.save() }}
                >
                  {t('save')}
                </button>
              </div>
            </div>
          ) : null}
        </>
      )}
    </li>
  )
}
