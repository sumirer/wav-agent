import { useEffect, useMemo, useRef, useState } from 'react'
import Composer from '@/components/Composer'
import MessageItem from '@/components/MessageItem'
import { PlusIcon, SettingsIcon } from '@/lib/icons'
import { useAppStore } from '@/store/useAppStore'

const EXAMPLES = [
  '做一个科幻感十足的激光枪射击音效，大约 0.6 秒',
  '生成一段 8bit 风格的吃金币音效，明亮短促',
  '来一段 4 秒的雨夜氛围，要有低频的雷声',
  '帮我创建一个「赛博朋克机械音」风格的 skill'
]

export default function ChatPage(): JSX.Element {
  const session = useAppStore((state) => state.session)
  const messages = useAppStore((state) => state.messages)
  const running = useAppStore((state) => state.running)
  const statusLabel = useAppStore((state) => state.statusLabel)
  const settings = useAppStore((state) => state.settings)
  const renameSession = useAppStore((state) => state.renameSession)
  const createSession = useAppStore((state) => state.createSession)
  const setView = useAppStore((state) => state.setView)
  const send = useAppStore((state) => state.send)
  const abort = useAppStore((state) => state.abort)
  const artifactCount = useAppStore((state) => state.artifacts.length)

  const scrollRef = useRef<HTMLDivElement | null>(null)
  const [draftTitle, setDraftTitle] = useState(session?.title ?? '')

  useEffect(() => {
    setDraftTitle(session?.title ?? '')
  }, [session?.id, session?.title])

  // 仅在用户已经贴近底部时自动跟随，避免打断向上翻阅历史
  useEffect(() => {
    const node = scrollRef.current
    if (!node) return
    const distance = node.scrollHeight - node.scrollTop - node.clientHeight
    if (distance < 220) node.scrollTop = node.scrollHeight
  }, [messages, statusLabel])

  const configured = Boolean(settings.model.apiKey.trim() && settings.model.model.trim())
  const streamingMessageId = useMemo(() => {
    if (!running) return null
    const last = [...messages].reverse().find((item) => item.role === 'assistant')
    return last?.id ?? null
  }, [messages, running])

  const commitTitle = (): void => {
    if (!session) return
    const next = draftTitle.trim()
    if (next && next !== session.title) void renameSession(session.id, next)
    else setDraftTitle(session.title)
  }

  return (
    <>
      <div className="page-head">
        <div className="page-head-content">
          <input
            className="page-title-input"
            value={draftTitle}
            placeholder="对话名称"
            onChange={(event) => setDraftTitle(event.target.value)}
            onBlur={commitTitle}
            onKeyDown={(event) => {
              if (event.key === 'Enter') event.currentTarget.blur()
            }}
          />
          <div style={{ display: 'flex', gap: 6, marginTop: 2, paddingLeft: 6 }}>
            <span className={`badge ${configured ? '' : 'badge-warn'}`}>
              {settings.model.model || '未配置模型'}
            </span>
            <span className="badge">{settings.defaultSampleRate / 1000}kHz</span>
            <span className="badge">素材 {artifactCount}</span>
          </div>
        </div>
        <div className="page-head-actions">
          <button type="button" className="btn" onClick={() => void createSession()}>
            <PlusIcon width={13} height={13} />
            新建对话
          </button>
        </div>
      </div>

      <div className="chat-scroll" ref={scrollRef}>
        <div className="chat-inner">
          {messages.length === 0 ? (
            <div className="chat-welcome">
              <h2>用一句话，得到一段波形</h2>
              <p>描述你想要的音效、音乐片段或环境声，Agent 会把它合成成 WAV 文件。</p>
              {!configured && (
                <div
                  className="msg-error"
                  style={{ textAlign: 'left', marginBottom: 18, display: 'flex', alignItems: 'center', gap: 10 }}
                >
                  <span style={{ flex: 1 }}>还没有配置模型 API Key，无法开始生成。</span>
                  <button type="button" className="btn" onClick={() => setView('settings')}>
                    <SettingsIcon width={13} height={13} />
                    去设置
                  </button>
                </div>
              )}
              <div className="prompt-grid">
                {EXAMPLES.map((example) => (
                  <button
                    key={example}
                    type="button"
                    className="prompt-card"
                    disabled={!configured}
                    onClick={() => void send(example, session?.skillNames ?? [])}
                  >
                    {example}
                  </button>
                ))}
              </div>
            </div>
          ) : (
            messages.map((message) => (
              <MessageItem
                key={message.id}
                message={message}
                streaming={running && message.id === streamingMessageId}
              />
            ))
          )}

          {running && statusLabel && (
            <div className="status-line">
              <span className="spinner" />
              {statusLabel}
            </div>
          )}
        </div>
      </div>

      <Composer
        running={running}
        disabled={!configured}
        onSend={(text) => void send(text, session?.skillNames ?? [])}
        onAbort={() => void abort()}
      />
    </>
  )
}
