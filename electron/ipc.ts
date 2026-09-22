/**
 * IPC 路由：把渲染层的请求映射到各个 service。
 * 所有跨进程数据都通过 shared/api.ts 中的契约传递。
 */
import { BrowserWindow, clipboard, dialog, ipcMain, shell } from 'electron'
import fs from 'node:fs'
import path from 'node:path'
import type { WavAgentEvents } from '../shared/api'
import type { AppSettings, AudioArtifact, ExportRequest, SendChatRequest } from '../shared/types'
import { runAgentTurn } from './services/agent'
import { createArtifact, deleteArtifact, readArtifactPayload } from './services/library'
import { probeModel } from './services/llm'
import { getSkillRegistry } from './services/skills'
import { getStore } from './services/store'
import { decodeWav } from './services/wav'
type Emit = <K extends keyof WavAgentEvents>(channel: K, payload: WavAgentEvents[K]) => void

const abortControllers = new Map<string, AbortController>()

function broadcast<K extends keyof WavAgentEvents>(channel: K, payload: WavAgentEvents[K]): void {
  for (const window of BrowserWindow.getAllWindows()) {
    if (!window.isDestroyed()) window.webContents.send(channel, payload)
  }
}

const emit: Emit = (channel, payload) => broadcast(channel, payload)

function notify(scope: WavAgentEvents['data:changed']['scope']): void {
  broadcast('data:changed', { scope })
}

/** 从标题生成安全的文件名 */
function safeFileName(title: string, fallback = 'audio'): string {
  const cleaned = title.replace(/[\\/:*?"<>|\r\n]+/g, '_').trim()
  return (cleaned || fallback).slice(0, 60)
}

function ensureDir(dir: string): void {
  if (dir && !fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
}

export function registerIpc(): void {
  const store = getStore()
  const registry = getSkillRegistry()
  registry.reload()

  /* ------------------------------ 设置 ------------------------------ */

  ipcMain.handle('settings:get', () => store.getSettings())

  ipcMain.handle('settings:update', (_event, patch: Partial<AppSettings>) => {
    const next = store.updateSettings(patch)
    // skill 目录变更后立刻重新扫描，用户不需要重启应用
    if (patch.skillsDir !== undefined) {
      registry.reload()
      notify('skills')
    }
    notify('settings')
    return next
  })

  ipcMain.handle('settings:pickDirectory', async (_event, title?: string, defaultPath?: string) => {
    const result = await dialog.showOpenDialog({
      title: title ?? '选择目录',
      defaultPath: defaultPath || store.getSettings().audioOutputDir,
      properties: ['openDirectory', 'createDirectory']
    })
    return result.canceled || result.filePaths.length === 0 ? null : result.filePaths[0]
  })

  /* ------------------------------ 会话 ------------------------------ */

  ipcMain.handle('sessions:list', () => store.listSessions())
  ipcMain.handle('sessions:get', (_event, id: string) => store.getSession(id))
  ipcMain.handle('sessions:create', (_event, title?: string) => {
    const session = store.createSession(title)
    notify('sessions')
    return session
  })
  ipcMain.handle('sessions:rename', (_event, id: string, title: string) => {
    store.renameSession(id, title)
    notify('sessions')
  })
  ipcMain.handle('sessions:delete', (_event, id: string) => {
    abortControllers.get(id)?.abort()
    abortControllers.delete(id)
    store.deleteSession(id)
    notify('sessions')
  })
  ipcMain.handle('sessions:setSkills', (_event, id: string, skillNames: string[]) => {
    store.setSessionSkills(id, skillNames)
    notify('sessions')
  })

  /* ------------------------------ 对话 ------------------------------ */

  ipcMain.handle('chat:send', (_event, req: SendChatRequest) => {
    abortControllers.get(req.sessionId)?.abort()
    const controller = new AbortController()
    abortControllers.set(req.sessionId, controller)
    void runAgentTurn({
      sessionId: req.sessionId,
      userText: req.text,
      skillNames: req.skillNames ?? [],
      emit,
      signal: controller.signal
    })
      .catch((error) => {
        console.error('[agent] 回合执行异常:', error)
      })
      .finally(() => {
        if (abortControllers.get(req.sessionId) === controller) abortControllers.delete(req.sessionId)
        notify('sessions')
        notify('artifacts')
      })
  })

  ipcMain.handle('chat:abort', (_event, sessionId: string) => {
    abortControllers.get(sessionId)?.abort()
    abortControllers.delete(sessionId)
  })

  ipcMain.handle('chat:ping', () => probeModel(store.getSettings().model))

  /* ------------------------------ 素材 ------------------------------ */

  ipcMain.handle('artifacts:list', () => store.listArtifacts())
  ipcMain.handle('artifacts:get', (_event, id: string) => store.getArtifact(id))
  ipcMain.handle('artifacts:read', (_event, id: string) => readArtifactPayload(id))

  ipcMain.handle('artifacts:saveToDisk', async (_event, id: string, targetPath?: string) => {
    const artifact = store.getArtifact(id)
    if (!artifact) throw new Error('素材不存在')
    const source = store.artifactFilePath(id)
    if (!fs.existsSync(source)) throw new Error('音频文件已丢失')

    let destination = targetPath
    if (!destination) {
      const settings = store.getSettings()
      const baseDir = settings.lastSaveDir || settings.audioOutputDir
      ensureDir(baseDir)
      const result = await dialog.showSaveDialog({
        title: '保存 WAV 文件',
        defaultPath: path.join(baseDir, `${safeFileName(artifact.title)}.wav`),
        filters: [{ name: 'WAV 音频', extensions: ['wav'] }]
      })
      if (result.canceled || !result.filePath) return null
      destination = result.filePath
    }

    ensureDir(path.dirname(destination))
    fs.copyFileSync(source, destination)
    store.updateArtifact(id, { savedPath: destination })
    store.updateSettings({ lastSaveDir: path.dirname(destination) })
    notify('artifacts')
    return destination
  })

  ipcMain.handle('artifacts:importFiles', async () => {
    const result = await dialog.showOpenDialog({
      title: '导入 WAV 文件',
      properties: ['openFile', 'multiSelections'],
      filters: [{ name: 'WAV 音频', extensions: ['wav'] }]
    })
    if (result.canceled) return []
    const created: AudioArtifact[] = []
    for (const file of result.filePaths) {
      try {
        const decoded = decodeWav(fs.readFileSync(file))
        created.push(
          createArtifact({
            title: path.basename(file, path.extname(file)),
            description: '外部导入',
            prompt: '',
            sampleRate: decoded.sampleRate,
            channels: decoded.data,
            source: 'import',
            recipe: null
          })
        )
      } catch (error) {
        console.error(`[import] ${file} 导入失败:`, error)
      }
    }
    notify('artifacts')
    return created
  })

  ipcMain.handle('artifacts:remove', (_event, id: string) => {
    deleteArtifact(id)
    notify('artifacts')
  })

  ipcMain.handle('artifacts:export', async (_event, req: ExportRequest) => {
    const channels = req.channels.map((channel) => new Float32Array(channel))
    // 编辑产物沿用来源素材的配方，界面会标注它已不再精确对应当前波形
    const originRecipe = req.originId ? store.getArtifact(req.originId)?.recipe ?? null : null
    const artifact = createArtifact({
      title: req.title,
      description: req.description ?? '波形编辑另存',
      prompt: '',
      sampleRate: req.sampleRate,
      channels,
      source: 'edit',
      recipe: originRecipe,
      originId: req.originId ?? null,
      sessionId: req.sessionId ?? null
    })
    notify('artifacts')
    if (req.promptSave === false) return artifact

    const settings = store.getSettings()
    const baseDir = settings.lastSaveDir || settings.audioOutputDir
    ensureDir(baseDir)
    const result = await dialog.showSaveDialog({
      title: '另存为 WAV 文件',
      defaultPath: path.join(baseDir, `${safeFileName(artifact.title)}.wav`),
      filters: [{ name: 'WAV 音频', extensions: ['wav'] }]
    })
    if (!result.canceled && result.filePath) {
      ensureDir(path.dirname(result.filePath))
      fs.copyFileSync(store.artifactFilePath(artifact.id), result.filePath)
      store.updateArtifact(artifact.id, { savedPath: result.filePath })
      store.updateSettings({ lastSaveDir: path.dirname(result.filePath) })
    }
    notify('artifacts')
    return store.getArtifact(artifact.id)
  })

  ipcMain.handle('artifacts:revealInFolder', (_event, targetPath: string) => {
    if (targetPath && fs.existsSync(targetPath)) shell.showItemInFolder(targetPath)
  })

  /* ------------------------------ Skills ------------------------------ */

  ipcMain.handle('skills:list', () => registry.list())
  ipcMain.handle('skills:get', (_event, id: string) => registry.get(id))
  ipcMain.handle('skills:addFromFolder', async () => {
    const skill = await registry.addFromFolder()
    notify('skills')
    return skill
  })
  ipcMain.handle('skills:exportToBuiltin', (_event, id: string) => {
    const skill = registry.exportToBuiltin(id)
    notify('skills')
    return skill
  })
  ipcMain.handle('skills:remove', (_event, id: string) => {
    registry.remove(id)
    notify('skills')
  })
  ipcMain.handle('skills:openFolder', async () => {
    const dir = registry.customDir
    ensureDir(dir)
    await shell.openPath(dir)
  })
  ipcMain.handle('skills:reload', () => {
    const list = registry.reload()
    notify('skills')
    return list
  })

  /* ------------------------------ 系统 ------------------------------ */

  ipcMain.handle('system:openPath', async (_event, targetPath: string) => {
    if (targetPath) await shell.openPath(targetPath)
  })

  // 走主进程写剪贴板，避免渲染层的 clipboard 权限与安全上下文差异
  ipcMain.handle('system:copyText', (_event, text: string) => {
    clipboard.writeText(String(text ?? ''))
  })
}
