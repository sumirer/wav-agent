import { useState } from 'react'
import type { AudioArtifact } from '@shared/types'
import PeakThumb from '@/components/PeakThumb'
import { CheckIcon, EditIcon, FolderIcon, PauseIcon, PlayIcon, SaveIcon } from '@/lib/icons'
import { formatDuration, formatSpan, player, usePlayerState, usePlayerTime } from '@/lib/player'
import { useAppStore } from '@/store/useAppStore'

interface AudioCardProps {
  artifact: AudioArtifact
}

/** 聊天流中展示单个生成结果的卡片：试听 + 保存到本地 + 进入编辑器 */
export default function AudioCard({ artifact }: AudioCardProps): JSX.Element {
  const playerState = usePlayerState()
  const time = usePlayerTime()
  const saveArtifact = useAppStore((state) => state.saveArtifact)
  const setActiveArtifact = useAppStore((state) => state.setActiveArtifact)
  const [saving, setSaving] = useState(false)

  const isCurrent = playerState.artifactId === artifact.id
  const playing = isCurrent && playerState.status === 'playing'
  const position = isCurrent && time.artifactId === artifact.id ? time.position : 0
  const progress = artifact.duration > 0 ? position / artifact.duration : 0

  const handleToggle = async (): Promise<void> => {
    if (isCurrent) {
      player.toggle()
      return
    }
    const payload = await window.api.artifacts.read(artifact.id)
    if (!payload) {
      useAppStore.getState().pushToast('音频数据读取失败', 'err')
      return
    }
    await player.open(artifact.id, { sampleRate: payload.sampleRate, data: payload.data })
  }

  const handleSeek = (ratio: number): void => {
    if (!isCurrent) return
    player.seek(ratio * artifact.duration)
  }

  const handleSave = async (): Promise<void> => {
    setSaving(true)
    try {
      await saveArtifact(artifact.id)
    } catch (error) {
      useAppStore.getState().pushToast(error instanceof Error ? error.message : String(error), 'err')
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="audio-card">
      <div className="audio-card-head">
        <button type="button" className="play-btn" onClick={() => void handleToggle()} title={playing ? '暂停' : '播放'}>
          {playing ? <PauseIcon width={15} height={15} /> : <PlayIcon width={15} height={15} />}
        </button>
        <div className="audio-card-title">{artifact.title}</div>
        <span className="badge">{formatSpan(artifact.duration)}</span>
        <span className="badge">{artifact.channels === 1 ? '单声道' : '立体声'}</span>
        <span className="badge">
          {artifact.recipe?.mode === 'code' ? '代码合成' : artifact.recipe ? '参数合成' : '外部音频'}
        </span>
      </div>

      {artifact.description && <div className="audio-card-desc">{artifact.description}</div>}

      <div
        className="audio-card-wave"
        onClick={(event) => {
          const rect = event.currentTarget.getBoundingClientRect()
          handleSeek((event.clientX - rect.left) / rect.width)
        }}
        title="点击定位播放位置"
      >
        <PeakThumb peaks={artifact.peaks} height={62} progress={progress} />
      </div>

      <div className="audio-card-foot">
        <span>
          {formatDuration(position, true)}
          <span style={{ color: 'var(--text-faint)' }}> / {formatDuration(artifact.duration, true)}</span>
        </span>
        <span>·</span>
        <span>{(artifact.sizeBytes / 1024).toFixed(0)} KB</span>
        {artifact.savedPath ? (
          <span className="badge badge-ok" title={artifact.savedPath}>
            <CheckIcon width={11} height={11} />
            已保存
          </span>
        ) : (
          <span className="badge badge-warn">未保存</span>
        )}
        <span className="spacer" />
        {artifact.savedPath && (
          <button
            type="button"
            className="btn btn-ghost"
            title="在文件夹中显示"
            onClick={() => void window.api.artifacts.revealInFolder(artifact.savedPath!)}
          >
            <FolderIcon width={13} height={13} />
          </button>
        )}
        <button type="button" className="btn" disabled={saving} onClick={() => void handleSave()}>
          <SaveIcon width={13} height={13} />
          {artifact.savedPath ? '另存到…' : '保存到本地'}
        </button>
        <button type="button" className="btn" onClick={() => setActiveArtifact(artifact.id)}>
          <EditIcon width={13} height={13} />
          编辑波形
        </button>
      </div>
    </div>
  )
}
