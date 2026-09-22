import { useAppStore } from '@/store/useAppStore'

/** 右下角浮出的轻量提示，避免引入独立的通知系统 */
export default function Toasts(): JSX.Element {
  const toasts = useAppStore((state) => state.toasts)
  const dismiss = useAppStore((state) => state.dismissToast)

  return (
    <div className="toast-stack">
      {toasts.map((toast) => (
        <div
          key={toast.id}
          className={`toast tone-${toast.tone}`}
          onClick={() => dismiss(toast.id)}
          role="status"
        >
          {toast.text}
        </div>
      ))}
    </div>
  )
}
