import { contextBridge, ipcRenderer } from 'electron'
import type { WavAgentApi, WavAgentEvents } from '../shared/api'

/**
 * 渲染层唯一的对外通道。
 * 只暴露 shared/api.ts 中声明过的方法，渲染进程拿不到 Node 能力。
 */
const api: WavAgentApi = {
  settings: {
    get: () => ipcRenderer.invoke('settings:get'),
    update: (patch) => ipcRenderer.invoke('settings:update', patch),
    pickDirectory: (title, defaultPath) => ipcRenderer.invoke('settings:pickDirectory', title, defaultPath)
  },
  sessions: {
    list: () => ipcRenderer.invoke('sessions:list'),
    get: (id) => ipcRenderer.invoke('sessions:get', id),
    create: (title) => ipcRenderer.invoke('sessions:create', title),
    rename: (id, title) => ipcRenderer.invoke('sessions:rename', id, title),
    remove: (id) => ipcRenderer.invoke('sessions:delete', id),
    setSkills: (id, skillNames) => ipcRenderer.invoke('sessions:setSkills', id, skillNames)
  },
  chat: {
    send: (req) => ipcRenderer.invoke('chat:send', req),
    abort: (sessionId) => ipcRenderer.invoke('chat:abort', sessionId),
    ping: () => ipcRenderer.invoke('chat:ping')
  },
  artifacts: {
    list: () => ipcRenderer.invoke('artifacts:list'),
    get: (id) => ipcRenderer.invoke('artifacts:get', id),
    read: (id) => ipcRenderer.invoke('artifacts:read', id),
    saveToDisk: (id, targetPath) => ipcRenderer.invoke('artifacts:saveToDisk', id, targetPath),
    importFiles: () => ipcRenderer.invoke('artifacts:importFiles'),
    remove: (id) => ipcRenderer.invoke('artifacts:remove', id),
    export: (req) => ipcRenderer.invoke('artifacts:export', req),
    revealInFolder: (targetPath) => ipcRenderer.invoke('artifacts:revealInFolder', targetPath)
  },
  skills: {
    list: () => ipcRenderer.invoke('skills:list'),
    get: (id) => ipcRenderer.invoke('skills:get', id),
    addFromFolder: () => ipcRenderer.invoke('skills:addFromFolder'),
    exportToBuiltin: (id) => ipcRenderer.invoke('skills:exportToBuiltin', id),
    remove: (id) => ipcRenderer.invoke('skills:remove', id),
    openFolder: () => ipcRenderer.invoke('skills:openFolder'),
    reload: () => ipcRenderer.invoke('skills:reload')
  },
  system: {
    openPath: (targetPath) => ipcRenderer.invoke('system:openPath', targetPath),
    copyText: (text) => ipcRenderer.invoke('system:copyText', text),
    on: (channel, listener) => {
      const handler = (_event: unknown, payload: WavAgentEvents[typeof channel]): void => listener(payload)
      ipcRenderer.on(channel, handler)
      return () => ipcRenderer.removeListener(channel, handler)
    }
  }
}

contextBridge.exposeInMainWorld('api', api)
