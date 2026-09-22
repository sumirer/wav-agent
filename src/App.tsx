import { useEffect } from 'react'
import ArtifactDrawer from '@/components/ArtifactDrawer'
import ChatPage from '@/components/ChatPage'
import SettingsPage from '@/components/SettingsPage'
import Sidebar from '@/components/Sidebar'
import Toasts from '@/components/Toasts'
import { useAppStore } from '@/store/useAppStore'

export default function App(): JSX.Element {
  const ready = useAppStore((state) => state.ready)
  const view = useAppStore((state) => state.view)
  const init = useAppStore((state) => state.init)

  useEffect(() => {
    void init()
  }, [init])

  return (
    <div className="app">
      <Sidebar />
      <main className="app-main">
        {!ready ? (
          <div className="drawer-loading">
            <span className="spinner" />
            正在启动 WAV Agent…
          </div>
        ) : view === 'settings' ? (
          <SettingsPage />
        ) : (
          <ChatPage />
        )}
      </main>
      <ArtifactDrawer />
      <Toasts />
    </div>
  )
}
