import { useState } from 'react'
import type { ChatMessage } from '@shared/types'
import AudioCard from '@/components/AudioCard'
import { SparkIcon } from '@/lib/icons'
import { useAppStore } from '@/store/useAppStore'

/** 把正文里的 ``` 代码块拆出来单独渲染，避免规格 JSON 撑坏气泡排版 */
function RichText({ content }: { content: string }): JSX.Element {
  const segments = content.split(/```/)
  return (
    <>
      {segments.map((segment, index) => {
        if (index % 2 === 1) {
          const body = segment.replace(/^[a-zA-Z]+\n/, '')
          return (
            <pre
              key={index}
              style={{
                margin: '8px 0 2px',
                padding: '9px 11px',
                borderRadius: 8,
                background: 'rgba(9, 12, 18, 0.7)',
                overflowX: 'auto',
                fontSize: 11.5,
                lineHeight: 1.6,
                color: 'var(--text-dim)'
              }}
            >
              {body.trim()}
            </pre>
          )
        }
        return segment ? <span key={index}>{segment}</span> : null
      })}
    </>
  )
}

const TOOL_LABELS: Record<string, string> = {
  generate_wav: '合成音频',
  list_skills: '查询 skills',
  use_skill: '加载 skill'
}

interface MessageItemProps {
  message: ChatMessage
  streaming: boolean
}

export default function MessageItem({ message, streaming }: MessageItemProps): JSX.Element {
  const artifacts = useAppStore((state) => state.artifacts)
  const [showTools, setShowTools] = useState(false)
  const isUser = message.role === 'user'
  const related = (message.artifactIds ?? [])
    .map((id) => artifacts.find((item) => item.id === id))
    .filter((item): item is NonNullable<typeof item> => Boolean(item))
  const toolCalls = message.toolCalls ?? []
  const hasText = message.content.trim().length > 0

  return (
    <div className={`msg ${isUser ? 'msg-user' : 'msg-assistant'}`}>
      <div className="msg-avatar">{isUser ? '你' : <SparkIcon width={14} height={14} />}</div>
      <div className="msg-body">
        {(hasText || streaming) && (
          <div className="msg-bubble">
            <RichText content={message.content} />
            {streaming && <span className="msg-cursor" />}
          </div>
        )}

        {!hasText && !streaming && toolCalls.length === 0 && !message.error && (
          <div className="msg-bubble" style={{ color: 'var(--text-faint)' }}>
            （没有返回内容）
          </div>
        )}

        {toolCalls.length > 0 && (
          <div className="tool-line">
            {toolCalls.map((call) => (
              <div key={call.id} className={`tool-item ${call.status === 'error' ? 'is-err' : ''}`}>
                <span>{TOOL_LABELS[call.name] ?? call.name}</span>
                <span>·</span>
                <span>
                  {call.status === 'running' ? '执行中…' : call.status === 'error' ? '失败' : '完成'}
                </span>
                <button type="button" className="tool-toggle" onClick={() => setShowTools((value) => !value)}>
                  {showTools ? '收起参数' : '查看参数'}
                </button>
              </div>
            ))}
          </div>
        )}

        {showTools && (
          <pre
            style={{
              margin: '6px 0 0',
              padding: '10px 12px',
              borderRadius: 8,
              background: 'rgba(9, 12, 18, 0.7)',
              border: '1px solid var(--border)',
              overflowX: 'auto',
              fontSize: 11.5,
              color: 'var(--text-dim)',
              maxHeight: 240
            }}
          >
            {toolCalls
              .map((call) => `# ${call.name}\n${call.args}\n\n> ${call.result ?? '（执行中）'}`)
              .join('\n\n')}
          </pre>
        )}

        {related.map((artifact) => (
          <AudioCard key={artifact.id} artifact={artifact} />
        ))}

        {message.error && <div className="msg-error">{message.error}</div>}
      </div>
    </div>
  )
}
