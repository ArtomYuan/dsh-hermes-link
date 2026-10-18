/**
 * A2A 设置卡片的双语文案（namespace `settings.a2aServer`）。
 *
 * zh / en 键集必须完全一致（locale 服务按 namespace 校验双语平衡）；
 * LocaleNamespaceMap 合并让 `register(NS, { zh, en })` 与卡片的 `t` 座位
 * 都走类型检查。
 */

/** 本 namespace 的字典键全集（zh/en 共用） */
export type A2ACardKey =
  | 'a2aTitle'
  | 'a2aDescription'
  | 'groupLive'
  | 'groupLiveHint'
  | 'groupRestart'
  | 'groupRestartHint'
  | 'fieldProvider'
  | 'fieldProviderHint'
  | 'fieldModel'
  | 'fieldModelHint'
  | 'fieldPreset'
  | 'fieldPresetHint'
  | 'fieldCwd'
  | 'fieldCwdHint'
  | 'fieldPort'
  | 'fieldPortHint'
  | 'fieldHost'
  | 'fieldHostHint'
  | 'fieldContextMapPath'
  | 'fieldContextMapPathHint'
  | 'fieldContextMapTtlDays'
  | 'fieldContextMapTtlDaysHint'
  | 'fieldAuthToken'
  | 'fieldAuthTokenHint'
  | 'authTokenSet'
  | 'authTokenUnset'
  | 'authTokenUnsetDanger'
  | 'authTokenEnvBadge'
  | 'authTokenEnvHint'
  | 'authTokenPlaceholder'
  | 'authTokenClearConfirm'
  | 'authTokenClearConfirmText'
  | 'overridden'
  | 'clearOverride'
  | 'save'
  | 'discard'
  | 'saveFailed'
  | 'invalidPort'
  | 'invalidHost'
  | 'invalidTtl'
  | 'loading'
  | 'unavailable'
  | 'confirm'
  | 'cancel'
  | 'expand'
  | 'collapse'
  | 'unsaved'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    'settings.a2aServer': A2ACardKey
  }
}

export const zh: Record<A2ACardKey, string> = {
  a2aTitle: 'A2A Server',
  a2aDescription: 'A2A 服务的运行时参数（provider / model / preset / 工作目录 / 端口 / 访问令牌）。',
  groupLive: '即时生效',
  groupLiveHint: '保存后对下一个 A2A 请求生效。',
  groupRestart: '重启后生效',
  groupRestartHint: '保存后需要重启 dsh 服务才会生效。',
  fieldProvider: 'Provider',
  fieldProviderHint: '后端 provider。即时生效；清除覆盖后回落配置层。',
  fieldModel: '模型',
  fieldModelHint: '执行任务的模型；空串 = 跟随 dsh 默认模型。即时生效；清除覆盖后回落配置层。',
  fieldPreset: 'Agent preset',
  fieldPresetHint: '挂载到 A2A 会话的 agent preset。即时生效；清除覆盖后回落配置层。',
  fieldCwd: '工作目录',
  fieldCwdHint: 'A2A 任务的执行目录；空 = 进程当前目录。即时生效；清除覆盖后回落配置层。',
  fieldPort: '端口',
  fieldPortHint: '监听端口（1–65535 整数）。重启后生效。',
  fieldHost: '监听地址',
  fieldHostHint: '默认 127.0.0.1（仅本机）。不能为空串。重启后生效。',
  fieldContextMapPath: '会话映射文件',
  fieldContextMapPathHint: 'contextId→session 映射的持久化路径；空 = 默认位置。重启后生效。',
  fieldContextMapTtlDays: '映射保留天数',
  fieldContextMapTtlDaysHint: '超期映射条目在加载/写入时清理（≥1 整数）。即时生效。',
  fieldAuthToken: '访问令牌',
  fieldAuthTokenHint: 'Bearer token；设置后所有请求必须携带。只写不回显。',
  authTokenSet: '已设置',
  authTokenUnset: '未设置',
  authTokenUnsetDanger: '未设置 = 无鉴权（危险）',
  authTokenEnvBadge: '由环境变量接管',
  authTokenEnvHint: '进程环境存在 A2A_SERVER_TOKEN，优先级最高，此处写入不会生效。',
  authTokenPlaceholder: '输入新令牌（留空 = 不修改）',
  authTokenClearConfirm: '确认清除访问令牌覆盖？',
  authTokenClearConfirmText: '令牌将回落到 cordis.patch.yml 中的既有令牌；若配置层也未设置，服务将变为无鉴权。',
  overridden: '已被用户层覆盖',
  clearOverride: '清除覆盖',
  save: '保存',
  discard: '放弃修改',
  saveFailed: '保存失败：配置已被其他会话修改，请重试。',
  invalidPort: '端口必须是 1–65535 的整数',
  invalidHost: '监听地址不能为空',
  invalidTtl: '保留天数必须是 ≥1 的整数',
  loading: '正在读取配置…',
  unavailable: '设置服务不可用（该命名空间未对本客户端开放）。',
  confirm: '确认清除',
  cancel: '取消',
  expand: '展开',
  collapse: '收起',
  unsaved: '未保存',
}

export const en: Record<A2ACardKey, string> = {
  a2aTitle: 'A2A Server',
  a2aDescription: 'Runtime parameters of the A2A service (provider / model / preset / working directory / port / access token).',
  groupLive: 'Takes effect immediately',
  groupLiveHint: 'Applies to the next A2A request after saving.',
  groupRestart: 'Takes effect after restart',
  groupRestartHint: 'Applies only after the dsh service restarts.',
  fieldProvider: 'Provider',
  fieldProviderHint: 'Backend provider. Immediate; clearing the override falls back to the config layer.',
  fieldModel: 'Model',
  fieldModelHint: 'Model for task execution; empty = follow the dsh default. Immediate; clearing falls back to the config layer.',
  fieldPreset: 'Agent preset',
  fieldPresetHint: 'Agent preset mounted onto A2A sessions. Immediate; clearing falls back to the config layer.',
  fieldCwd: 'Working directory',
  fieldCwdHint: 'Execution directory of A2A tasks; empty = process cwd. Immediate; clearing falls back to the config layer.',
  fieldPort: 'Port',
  fieldPortHint: 'Listen port (integer 1–65535). Applies after restart.',
  fieldHost: 'Listen address',
  fieldHostHint: 'Defaults to 127.0.0.1 (local only). Must not be empty. Applies after restart.',
  fieldContextMapPath: 'Session map file',
  fieldContextMapPathHint: 'Persistence path of the contextId→session map; empty = default location. Applies after restart.',
  fieldContextMapTtlDays: 'Map retention days',
  fieldContextMapTtlDaysHint: 'Expired map entries are cleaned on load/write (integer ≥ 1). Immediate.',
  fieldAuthToken: 'Access token',
  fieldAuthTokenHint: 'Bearer token; when set, every request must carry it. Write-only, never echoed back.',
  authTokenSet: 'Set',
  authTokenUnset: 'Not set',
  authTokenUnsetDanger: 'Not set = no authentication (dangerous)',
  authTokenEnvBadge: 'Overridden by environment',
  authTokenEnvHint: 'The process environment carries A2A_SERVER_TOKEN; it wins over this field, so writes here have no effect.',
  authTokenPlaceholder: 'Enter a new token (blank = no change)',
  authTokenClearConfirm: 'Clear the access-token override?',
  authTokenClearConfirmText: 'The token falls back to the existing one in cordis.patch.yml; if the config layer sets none either, the service becomes unauthenticated.',
  overridden: 'Overridden by the user layer',
  clearOverride: 'Clear override',
  save: 'Save',
  discard: 'Discard changes',
  saveFailed: 'Save failed: the configuration changed in another session, please retry.',
  invalidPort: 'Port must be an integer between 1 and 65535',
  invalidHost: 'Listen address must not be empty',
  invalidTtl: 'Retention days must be an integer ≥ 1',
  loading: 'Loading configuration…',
  unavailable: 'Settings service unavailable (the namespace is not exposed to this client).',
  confirm: 'Confirm clear',
  cancel: 'Cancel',
  expand: 'Expand',
  collapse: 'Collapse',
  unsaved: 'Unsaved',
}
