import { useState } from 'react'
import type { AudioArtifact, SessionMeta } from '@shared/types'
import PeakThumb from '@/components/PeakThumb'
import { PlusIcon, RefreshIcon, SettingsIcon, TrashIcon, WaveIcon } from '@/lib/icons'
import { formatSpan } from '@/lib/player'
import { useAppStore } from '@/store/useAppStore'

function formatTime(timestamp: number): string {
  const date = new Date(timestamp)
  const today = new Date()
  const sameDay =
    date.getFullYear() === today.getFullYear() &&
    date.getMonth() === today.getMonth() &&
    date.getDate() === today.getDate()
  const time = `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`
  return sameDay ? time : `${date.getMonth() + 1}/${date.getDate()} ${time}`
}

function SessionRow({ session }: { session: SessionMeta }): JSX.Element {
  const activeSessionId = useAppStore((state) => state.activeSessionId)
  const selectSession = useAppStore((state) => state.selectSession)
  const removeSession = useAppStore((state) => state.removeSession)
  const active = session.id === activeSessionId

  return (
    <button type="button" className={`item ${active ? 'is-active' : ''}`} onClick={() => void selectSession(session.id)}>
      <div className="item-main">
        <div className="item-title">{session.title}</div>
        <div className="item-meta">
          <span>{formatTime(session.updatedAt)}</span>
          <span>·</span>
          <span>{session.messageCount} 条</span>
          {session.artifactCount > 0 && (
            <>
              <span>·</span>
              <span>{session.artifactCount} 个音频</span>
            </>
          )}
        </div>
      </div>
      <div className="item-actions">
        <span
          className="icon-btn"
          title="删除对话"
          onClick={(event) => {
            event.stopPropagation()
            void removeSession(session.id)
          }}
        >
          <TrashIcon width={14} height={14} />
        </span>
      </div>
    </button>
  )
}

function ArtifactRow({ artifact }: { artifact: AudioArtifact }): JSX.Element {
  const activeArtifactId = useAppStore((state) => state.activeArtifactId)
  const setActiveArtifact = useAppStore((state) => state.setActiveArtifact)
  const removeArtifact = useAppStore((state) => state.removeArtifact)
  const active = artifact.id === activeArtifactId

  return (
    <button
      type="button"
      className={`item ${active ? 'is-active' : ''}`}
      onClick={() => setActiveArtifact(artifact.id)}
      title={artifact.description || artifact.title}
    >
      <div className="item-thumb">
        <PeakThumb peaks={artifact.peaks} height={30} />
      </div>
      <div className="item-main">
        <div className="item-title">{artifact.title}</div>
        <div className="item-meta">
          <span>{formatSpan(artifact.duration)}</span>
          <span>·</span>
          <span>{artifact.sampleRate / 1000}k</span>
          <span>·</span>
          <span>{formatTime(artifact.createdAt)}</span>
        </div>
      </div>
      <div className="item-actions">
        <span
          className="icon-btn"
          title="从素材库移除"
          onClick={(event) => {
            event.stopPropagation()
            void removeArtifact(artifact.id)
          }}
        >
          <TrashIcon width={14} height={14} />
        </span>
      </div>
    </button>
  )
}

export default function Sidebar(): JSX.Element {
  const sidebarTab = useAppStore((state) => state.sidebarTab)
  const setSidebarTab = useAppStore((state) => state.setSidebarTab)
  const view = useAppStore((state) => state.view)
  const setView = useAppStore((state) => state.setView)
  const sessions = useAppStore((state) => state.sessions)
  const artifacts = useAppStore((state) => state.artifacts)
  const createSession = useAppStore((state) => state.createSession)
  const importArtifacts = useAppStore((state) => state.importArtifacts)
  const refreshArtifacts = useAppStore((state) => state.refreshArtifacts)
  const [busy, setBusy] = useState(false)

  const handleImport = async (): Promise<void> => {
    setBusy(true)
    try {
      await importArtifacts()
    } catch (error) {
      useAppStore.getState().pushToast(error instanceof Error ? error.message : String(error), 'err')
    } finally {
      setBusy(false)
    }
  }

  return (
    <aside className="sidebar">
      <div className="sidebar-brand">
        <span className="sidebar-brand-mark">
          <WaveIcon width={15} height={15} color="#fff" />
        </span>
        <div>
          <div className="sidebar-brand-title">WAV Agent</div>
          <div className="sidebar-brand-sub">自然语言生成波形</div>
        </div>
      </div>

      <div className="sidebar-tabs">
        <button
          type="button"
          className={`sidebar-tab ${sidebarTab === 'sessions' ? 'is-active' : ''}`}
          onClick={() => setSidebarTab('sessions')}
        >
          对话
        </button>
        <button
          type="button"
          className={`sidebar-tab ${sidebarTab === 'artifacts' ? 'is-active' : ''}`}
          onClick={() => setSidebarTab('artifacts')}
        >
          音频素材 {artifacts.length > 0 ? `(${artifacts.length})` : ''}
        </button>
      </div>

      <div className="sidebar-body">
        {sidebarTab === 'sessions' ? (
          sessions.length === 0 ? (
            <div className="sidebar-empty">还没有对话记录</div>
          ) : (
            sessions.map((session) => <SessionRow key={session.id} session={session} />)
          )
        ) : artifacts.length === 0 ? (
          <div className="sidebar-empty">
            还没有生成音频
            <br />
            在对话里描述你想要的音效即可
          </div>
        ) : (
          artifacts.map((artifact) => <ArtifactRow key={artifact.id} artifact={artifact} />)
        )}
      </div>

      <div className="sidebar-footer">
        <button type="button" className="btn btn-primary btn-block" onClick={() => void createSession()}>
          <PlusIcon width={14} height={14} />
          新建对话
        </button>
        <div style={{ display: 'flex', gap: 6 }}>
          <button
            type="button"
            className="btn btn-ghost"
            style={{ flex: 1 }}
            disabled={busy}
            onClick={() => void handleImport()}
          >
            <RefreshIcon width={14} height={14} />
            导入 WAV
          </button>
          <button
            type="button"
            className="btn btn-ghost"
            style={{ flex: 1 }}
            onClick={() => void refreshArtifacts()}
            title="刷新素材列表"
          >
            <RefreshIcon width={14} height={14} />
            刷新
          </button>
        </div>
        <button
          type="button"
          className={`btn btn-block ${view === 'settings' ? 'btn-primary' : ''}`}
          onClick={() => setView(view === 'settings' ? 'chat' : 'settings')}
        >
          <SettingsIcon width={14} height={14} />
          {view === 'settings' ? '返回对话' : '设置'}
        </button>
      </div>
    </aside>
  )
}
