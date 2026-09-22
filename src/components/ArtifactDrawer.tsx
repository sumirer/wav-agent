import { useEffect, useState } from 'react'
import type { AudioPayload } from '@shared/types'
import AudioEditor from '@/components/AudioEditor'
import { CloseIcon } from '@/lib/icons'
import { player } from '@/lib/player'
import { useAppStore } from '@/store/useAppStore'

/** 右侧音频工作台：承载播放器与波形编辑，关闭时释放播放资源 */
export default function ArtifactDrawer(): JSX.Element | null {
  const activeArtifactId = useAppStore((state) => state.activeArtifactId)
  const artifacts = useAppStore((state) => state.artifacts)
  const setActiveArtifact = useAppStore((state) => state.setActiveArtifact)
  const saveArtifact = useAppStore((state) => state.saveArtifact)
  const exportArtifact = useAppStore((state) => state.exportArtifact)
  const pushToast = useAppStore((state) => state.pushToast)

  const [payload, setPayload] = useState<AudioPayload | null>(null)
  const [loading, setLoading] = useState(false)

  const artifact = artifacts.find((item) => item.id === activeArtifactId) ?? null

  useEffect(() => {
    if (!activeArtifactId) {
      setPayload(null)
      return
    }
    let cancelled = false
    setLoading(true)
    setPayload(null)
    window.api.artifacts
      .read(activeArtifactId)
      .then((next) => {
        if (!cancelled) setPayload(next)
      })
      .catch(() => {
        if (!cancelled) pushToast('读取音频数据失败', 'err')
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [activeArtifactId, pushToast])

  const close = (): void => {
    player.stop()
    player.reset()
    setActiveArtifact(null)
  }

  if (!artifact) return null

  return (
    <aside className="drawer">
      {loading || !payload ? (
        <div className="drawer-loading">
          <span className="spinner" />
          正在解码音频…
        </div>
      ) : (
        <>
          <div className="page-head" style={{ padding: '12px 16px' }}>
            <div className="page-head-content">
              <div style={{ fontSize: 13, fontWeight: 600 }}>波形编辑</div>
              <div style={{ fontSize: 11, color: 'var(--text-faint)' }}>
                {artifact.source === 'agent' ? '来自对话生成' : artifact.source === 'edit' ? '来自波形编辑' : '外部导入'}
              </div>
            </div>
            <div className="page-head-actions">
              <button type="button" className="icon-btn" title="关闭" onClick={close}>
                <CloseIcon width={15} height={15} />
              </button>
            </div>
          </div>
          <AudioEditor
            key={artifact.id}
            artifact={artifact}
            payload={payload}
            onClose={close}
            onSaveToDisk={() => void saveArtifact(artifact.id)}
            onExport={async ({ channels, sampleRate, title }) => {
              const created = await exportArtifact({
                title,
                description: `由「${artifact.title}」编辑而来`,
                sampleRate,
                channels,
                originId: artifact.id,
                sessionId: artifact.sessionId
              })
              if (created) setActiveArtifact(created.id)
            }}
          />
        </>
      )}
    </aside>
  )
}
