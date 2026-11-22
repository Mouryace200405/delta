import { IconClose } from './Icons'
import { useActions, useAppState } from '../lib/store'

export function Toasts() {
  const { toasts } = useAppState()
  const { dismissToast } = useActions()
  if (toasts.length === 0) return null
  return (
    <div className="toast-stack" role="status" aria-live="polite">
      {toasts.map((toast) => (
        <div key={toast.id} className={`toast ${toast.kind}`}>
          <span className="toast-text">{toast.text}</span>
          <button type="button" aria-label="Dismiss" onClick={() => dismissToast(toast.id)}>
            <IconClose />
          </button>
        </div>
      ))}
    </div>
  )
}
