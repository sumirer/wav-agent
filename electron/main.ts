import { app, BrowserWindow, session, shell } from 'electron'
import path from 'node:path'
import { registerIpc } from './ipc'
import { getStore } from './services/store'

const devServerUrl = process.env.VITE_DEV_SERVER_URL

/**
 * 生产环境下把 CSP 放到响应头里而不是 index.html 的 meta 标签里：
 * Vite 开发服务器需要注入内联的 HMR 脚本，写在 meta 里会导致 dev 模式白屏。
 * 渲染进程不发起任何网络请求（所有请求都在主进程），因此 connect-src 收紧到 'none'。
 */
function applyContentSecurityPolicy(): void {
  if (devServerUrl) return
  session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
    callback({
      responseHeaders: {
        ...details.responseHeaders,
        'Content-Security-Policy': [
          "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; media-src 'self' data: blob:; connect-src 'self'"
        ]
      }
    })
  })
}

let mainWindow: BrowserWindow | null = null

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 920,
    minWidth: 1080,
    minHeight: 680,
    show: false,
    title: 'WAV Agent',
    backgroundColor: '#0d1017',
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  })

  mainWindow.once('ready-to-show', () => mainWindow?.show())

  // 站内导航保留，外部链接交给系统浏览器
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url)
    return { action: 'deny' }
  })

  if (devServerUrl) {
    void mainWindow.loadURL(devServerUrl)
    mainWindow.webContents.openDevTools({ mode: 'detach' })
  } else {
    void mainWindow.loadFile(path.join(__dirname, '../dist/index.html'))
  }
}

const gotLock = app.requestSingleInstanceLock()
if (!gotLock) {
  app.quit()
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore()
      mainWindow.focus()
    }
  })

  void app.whenReady().then(() => {
    // store 依赖 app.getPath，必须等 ready 之后初始化
    applyContentSecurityPolicy()
    registerIpc()
    createWindow()

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow()
    })
  })

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit()
  })

  app.on('before-quit', () => {
    getStore().flushNow()
  })
}
