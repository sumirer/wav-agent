import { useEffect, useState } from 'react'
import type { ModelConfig } from '@shared/types'
import { CheckIcon, FolderIcon, PlusIcon, RefreshIcon, TrashIcon } from '@/lib/icons'
import { useAppStore } from '@/store/useAppStore'

/** 失焦 / 回车时才提交的文本输入，避免每敲一个字符就写一次磁盘 */
function CommitInput({
  value,
  onCommit,
  placeholder,
  type = 'text',
  ariaLabel
}: {
  value: string
  onCommit(next: string): void
  placeholder?: string
  type?: string
  ariaLabel?: string
}): JSX.Element {
  const [draft, setDraft] = useState(value)
  useEffect(() => setDraft(value), [value])

  return (
    <input
      className="input"
      type={type}
      value={draft}
      placeholder={placeholder}
      aria-label={ariaLabel}
      spellCheck={false}
      onChange={(event) => setDraft(event.target.value)}
      onBlur={() => {
        if (draft !== value) onCommit(draft)
      }}
      onKeyDown={(event) => {
        if (event.key === 'Enter') event.currentTarget.blur()
      }}
    />
  )
}

function CommitNumber({
  value,
  onCommit,
  min,
  max,
  step = 1,
  ariaLabel
}: {
  value: number
  onCommit(next: number): void
  min: number
  max: number
  step?: number
  ariaLabel?: string
}): JSX.Element {
  const [draft, setDraft] = useState(String(value))
  useEffect(() => setDraft(String(value)), [value])

  const commit = (): void => {
    const parsed = Number(draft)
    if (!Number.isFinite(parsed)) {
      setDraft(String(value))
      return
    }
    const clamped = Math.min(Math.max(parsed, min), max)
    setDraft(String(clamped))
    if (clamped !== value) onCommit(clamped)
  }

  return (
    <input
      className="input"
      type="number"
      value={draft}
      min={min}
      max={max}
      step={step}
      aria-label={ariaLabel}
      onChange={(event) => setDraft(event.target.value)}
      onBlur={commit}
      onKeyDown={(event) => {
        if (event.key === 'Enter') event.currentTarget.blur()
      }}
    />
  )
}

export default function SettingsPage(): JSX.Element {
  const settings = useAppStore((state) => state.settings)
  const updateSettings = useAppStore((state) => state.updateSettings)
  const skills = useAppStore((state) => state.skills)
  const refreshSkills = useAppStore((state) => state.refreshSkills)
  const pushToast = useAppStore((state) => state.pushToast)
  const [probe, setProbe] = useState<{ ok: boolean; message: string; models?: string[] } | null>(null)
  const [probing, setProbing] = useState(false)

  const patchModel = (patch: Partial<ModelConfig>): void => {
    void updateSettings({ model: { ...settings.model, ...patch } })
  }

  const handleProbe = async (): Promise<void> => {
    setProbing(true)
    setProbe(null)
    try {
      setProbe(await window.api.chat.ping())
    } catch (error) {
      setProbe({ ok: false, message: error instanceof Error ? error.message : String(error) })
    } finally {
      setProbing(false)
    }
  }

  return (
    <div className="settings-scroll">
      <div className="settings-inner">
        <div className="card">
          <div className="card-head">
            <span className="card-title">模型配置</span>
            <span className="badge">OpenAI 兼容协议</span>
            <span style={{ flex: 1 }} />
            <button type="button" className="btn" disabled={probing} onClick={() => void handleProbe()}>
              {probing ? <span className="spinner" /> : <CheckIcon width={13} height={13} />}
              测试连接
            </button>
          </div>
          <p className="card-desc">
            任何兼容 <code>/chat/completions</code> 的服务都可以直接接入，例如 OpenAI、DeepSeek、通义千问、Ollama、
            vLLM 或自建网关。Base URL 需要包含版本前缀（如 https://api.openai.com/v1）。
          </p>

          <div className="field">
            <label className="field-label">Base URL</label>
            <CommitInput
              value={settings.model.baseUrl}
              placeholder="https://api.openai.com/v1"
              ariaLabel="Base URL"
              onCommit={(next) => patchModel({ baseUrl: next })}
            />
          </div>

          <div className="field">
            <label className="field-label">API Key</label>
            <CommitInput
              value={settings.model.apiKey}
              type="password"
              placeholder="sk-..."
              ariaLabel="API Key"
              onCommit={(next) => patchModel({ apiKey: next })}
            />
            <span className="field-hint">
              仅保存在本机 userData 目录的 data.json 中，不会上传到任何第三方。
            </span>
          </div>

          <div className="field">
            <label className="field-label">模型名称</label>
            <CommitInput
              value={settings.model.model}
              placeholder="gpt-4o-mini"
              ariaLabel="模型名称"
              onCommit={(next) => patchModel({ model: next })}
            />
            {probe && (
              <span className="field-hint" style={{ color: probe.ok ? 'var(--success)' : 'var(--danger)' }}>
                {probe.message}
                {probe.models && probe.models.length > 0 ? `：${probe.models.slice(0, 8).join(', ')}` : ''}
              </span>
            )}
          </div>

          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 14 }}>
            <div className="field">
              <label className="field-label">温度（越高越有想象力）</label>
              <CommitNumber
                value={settings.model.temperature}
                min={0}
                max={2}
                step={0.1}
                ariaLabel="温度"
                onCommit={(next) => patchModel({ temperature: next })}
              />
            </div>
            <div className="field">
              <label className="field-label">单次回复最大 token</label>
              <CommitNumber
                value={settings.model.maxTokens}
                min={256}
                max={32768}
                step={256}
                ariaLabel="单次回复最大 token"
                onCommit={(next) => patchModel({ maxTokens: next })}
              />
            </div>
          </div>
        </div>

        <div className="card">
          <div className="card-head">
            <span className="card-title">音频存储</span>
          </div>
          <p className="card-desc">生成的音频只有在点击「保存到本地」并选定路径后才会写入这里。</p>

          <div className="field">
            <label className="field-label">默认保存目录</label>
            <div className="field-row">
              <div className="input-static" title={settings.audioOutputDir}>
                {settings.audioOutputDir || '未设置'}
              </div>
              <button
                type="button"
                className="btn"
                onClick={async () => {
                  const dir = await window.api.settings.pickDirectory('选择音频保存目录', settings.audioOutputDir)
                  if (dir) await updateSettings({ audioOutputDir: dir })
                }}
              >
                <FolderIcon width={13} height={13} />
                选择
              </button>
              <button
                type="button"
                className="btn"
                disabled={!settings.audioOutputDir}
                onClick={() => void window.api.system.openPath(settings.audioOutputDir)}
              >
                打开
              </button>
            </div>
          </div>

          <div className="field">
            <label className="field-label">默认采样率</label>
            <CommitNumber
              value={settings.defaultSampleRate}
              min={8000}
              max={192000}
              step={100}
              ariaLabel="默认采样率"
              onCommit={(next) => void updateSettings({ defaultSampleRate: next })}
            />
            <span className="field-hint">模型未显式指定采样率时使用该值，常见选择为 44100 或 48000。</span>
          </div>
        </div>

        <div className="card">
          <div className="card-head">
            <span className="card-title">Agent 行为</span>
          </div>

          <div className="field">
            <label className="field-label">追加的系统提示词</label>
            <textarea
              className="input"
              style={{ minHeight: 78, resize: 'vertical', lineHeight: 1.7 }}
              value={settings.systemPromptExtra}
              placeholder="例如：我们的项目是像素风游戏，音效请偏干、不要混响。"
              onChange={(event) => void updateSettings({ systemPromptExtra: event.target.value })}
            />
            <span className="field-hint">会附加在内置提示词之后，用于约束音色风格与命名习惯。</span>
          </div>

          <div className="field">
            <label className="field-label" style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <input
                type="checkbox"
                checked={settings.autoRunCodeBlock}
                onChange={(event) => void updateSettings({ autoRunCodeBlock: event.target.checked })}
              />
              兜底执行正文中的规格代码块
            </label>
            <span className="field-hint">
              部分模型不支持 function calling，会把合成规格直接写在回复正文里。开启后应用会自动识别并合成，
              关闭后这些内容只会作为文本展示。
            </span>
          </div>
        </div>

        <div className="card">
          <div className="card-head">
            <span className="card-title">Skills</span>
            <span className="badge">
              共 {skills.length} 个 · 自定义 {skills.filter((skill) => !skill.builtin).length}
            </span>
            <span style={{ flex: 1 }} />
            <button
              type="button"
              className="btn"
              onClick={async () => {
                try {
                  const added = await window.api.skills.addFromFolder()
                  await refreshSkills()
                  if (added) pushToast(`已导入 skill「${added.name}」`, 'ok')
                } catch (error) {
                  pushToast(error instanceof Error ? error.message : String(error), 'err')
                }
              }}
            >
              <PlusIcon width={13} height={13} />
              导入目录
            </button>
            <button
              type="button"
              className="btn"
              onClick={async () => {
                await refreshSkills()
                pushToast('已重新加载 skills', 'ok')
              }}
            >
              <RefreshIcon width={13} height={13} />
            </button>
          </div>
          <p className="card-desc">
            每个 skill 是一个包含 <code>SKILL.md</code> 的目录，可选带 <code>examples/*.json</code> 示例规格。
            内置 skill 随安装包分发；自定义 skill 存放在上面的固定目录里，
            点「导出为内置」可以把它们固化成默认 skill，之后打包就会一起带上。
          </p>

          <div className="field">
            <label className="field-label">自定义 skill 固定目录</label>
            <div className="field-row">
              <div className="input-static" title={settings.skillsDir}>
                {settings.skillsDir || '未设置'}
              </div>
              <button
                type="button"
                className="btn"
                onClick={async () => {
                  const dir = await window.api.settings.pickDirectory('选择 skill 存放目录', settings.skillsDir)
                  if (dir) await updateSettings({ skillsDir: dir })
                }}
              >
                <FolderIcon width={13} height={13} />
                选择
              </button>
              <button type="button" className="btn" onClick={() => void window.api.skills.openFolder()}>
                打开
              </button>
            </div>
            <span className="field-hint">
              应用启动时会自动扫描该目录。你可以直接在对话里说「帮我创建一个 XX 风格的 skill」，
              Agent 会先问清风格要点，再把它写进这个目录并立刻出现在下方列表中。
              把这里指向源码仓库的 <code>skills</code> 目录，新建的 skill 就会随下次打包一起分发。
            </span>
          </div>

          {skills.length === 0 ? (
            <div style={{ padding: '10px 0 14px', color: 'var(--text-faint)', fontSize: 12 }}>
              还没有 skill，可以在对话里让 Agent 创建，或点击「导入目录」添加。
            </div>
          ) : (
            skills.map((skill) => (
              <div key={skill.id} className="skill-row">
                <div className="skill-info">
                  <div className="skill-name">
                    {skill.name}
                    {skill.builtin ? <span className="badge">内置</span> : <span className="badge badge-ok">自定义</span>}
                    {!skill.builtin && skill.exported && <span className="badge">已随包分发</span>}
                    {skill.examples.length > 0 && <span className="badge">示例 {skill.examples.length}</span>}
                  </div>
                  {skill.description && <div className="skill-desc">{skill.description}</div>}
                  <div className="skill-desc" style={{ color: 'var(--text-faint)' }}>
                    {skill.dir}
                  </div>
                </div>
                {!skill.builtin && !skill.exported && (
                  <button
                    type="button"
                    className="btn"
                    title="复制到随包分发的内置目录，成为默认 skill"
                    onClick={async () => {
                      try {
                        await window.api.skills.exportToBuiltin(skill.id)
                        await refreshSkills()
                        pushToast(`「${skill.name}」已复制到内置目录，下次打包会一起分发`, 'ok')
                      } catch (error) {
                        pushToast(error instanceof Error ? error.message : String(error), 'err')
                      }
                    }}
                  >
                    导出为内置
                  </button>
                )}
                <button
                  type="button"
                  className="icon-btn"
                  disabled={skill.builtin}
                  title={skill.builtin ? '内置 skill 不能删除' : '删除该 skill'}
                  onClick={async () => {
                    try {
                      await window.api.skills.remove(skill.id)
                      await refreshSkills()
                    } catch (error) {
                      pushToast(error instanceof Error ? error.message : String(error), 'err')
                    }
                  }}
                >
                  <TrashIcon width={14} height={14} />
                </button>
              </div>
            ))
          )}
        </div>
      </div>
    </div>
  )
}
