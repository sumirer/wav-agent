import { useEffect, useRef, useState } from 'react'
import { CloseIcon, PlusIcon, SparkIcon, StopIcon } from '@/lib/icons'
import { useAppStore } from '@/store/useAppStore'

/** 会话级 skills 选择器：选中的 skill 会强制注入到本次对话的提示词里 */
function SkillPicker(): JSX.Element {
  const skills = useAppStore((state) => state.skills)
  const session = useAppStore((state) => state.session)
  const setSessionSkills = useAppStore((state) => state.setSessionSkills)
  const [open, setOpen] = useState(false)
  const anchorRef = useRef<HTMLDivElement | null>(null)
  const enabled = session?.skillNames ?? []

  // 用文档级监听代替整屏遮罩：.composer-box 上的 backdrop-filter 会成为 fixed 定位的包含块，
  // 遮罩会被限制在输入框区域内，导致点击页面其它地方关不掉弹层。
  useEffect(() => {
    if (!open) return
    const handlePointerDown = (event: MouseEvent): void => {
      if (anchorRef.current?.contains(event.target as Node)) return
      setOpen(false)
    }
    document.addEventListener('mousedown', handlePointerDown)
    return () => document.removeEventListener('mousedown', handlePointerDown)
  }, [open])

  const toggle = (id: string): void => {
    const next = enabled.includes(id) ? enabled.filter((item) => item !== id) : [...enabled, id]
    void setSessionSkills(next)
  }

  return (
    <>
      {enabled.map((id) => {
        const skill = skills.find((item) => item.id === id)
        return (
          <button key={id} type="button" className="chip is-active" onClick={() => toggle(id)} title="取消启用">
            <SparkIcon width={11} height={11} />
            {skill?.name ?? id}
            <CloseIcon width={10} height={10} />
          </button>
        )
      })}

      <div ref={anchorRef} style={{ position: 'relative' }}>
        <button type="button" className="chip" onClick={() => setOpen((value) => !value)}>
          <PlusIcon width={11} height={11} />
          启用 skill
        </button>
        {open && (
          /* .popover 默认 bottom:100% 向上弹出：输入区贴着窗口底部，上方才有足够空间 */
          <div className="popover">
            <div className="popover-title">
              {skills.length > 0 ? '选择一个 skill，它的方法论会注入到本轮对话' : '还没有可用 skill，可在设置页导入'}
            </div>
            {skills.map((skill) => (
              <button
                key={skill.id}
                type="button"
                className={`item ${enabled.includes(skill.id) ? 'is-active' : ''}`}
                onClick={() => toggle(skill.id)}
              >
                <div className="item-main">
                  <div className="item-title">{skill.name}</div>
                  {skill.description && <div className="item-meta">{skill.description}</div>}
                </div>
                {skill.builtin ? <span className="badge">内置</span> : <span className="badge badge-ok">自定义</span>}
              </button>
            ))}
          </div>
        )}
      </div>
    </>
  )
}

interface ComposerProps {
  onSend(text: string): void
  onAbort(): void
  running: boolean
  disabled?: boolean
}

export default function Composer({ onSend, onAbort, running, disabled }: ComposerProps): JSX.Element {
  const [text, setText] = useState('')
  const textareaRef = useRef<HTMLTextAreaElement | null>(null)

  // textarea 高度随内容增长，超过上限后在组件内部滚动
  useEffect(() => {
    const node = textareaRef.current
    if (!node) return
    node.style.height = 'auto'
    node.style.height = `${Math.min(node.scrollHeight, 168)}px`
  }, [text])

  const submit = (): void => {
    if (running || disabled) return
    const value = text.trim()
    if (!value) return
    setText('')
    onSend(value)
  }

  return (
    <div className="composer">
      <div className="composer-inner">
        <div className="composer-box">
          <textarea
            ref={textareaRef}
            value={text}
            placeholder={
              disabled
                ? '请先在设置中配置模型 API Key'
                : '描述你想要的音频，例如：做一个科幻感十足的激光枪射击音效，大约 0.6 秒'
            }
            disabled={disabled}
            onChange={(event) => setText(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
                event.preventDefault()
                submit()
              }
            }}
          />
          <div className="skill-bar">
            <SkillPicker />
          </div>
          <div className="composer-toolbar">
            <span style={{ fontSize: 11, color: 'var(--text-faint)' }}>Enter 发送 · Shift + Enter 换行</span>
            <span className="spacer" />
            {running ? (
              <button type="button" className="btn btn-danger" onClick={onAbort}>
                <StopIcon width={13} height={13} />
                停止生成
              </button>
            ) : (
              <button type="button" className="btn btn-primary" disabled={!text.trim() || disabled} onClick={submit}>
                发送
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}
