import { useState, type DragEvent, type MouseEvent as ReactMouseEvent } from 'react'
import { IconClose, IconPlus } from './Icons'

export function TabBar({
  tabs,
  activePath,
  buffers,
  onSelect,
  onClose,
  onNewTab,
  onContextMenu,
  onMove,
}: {
  tabs: string[]
  activePath: string | null
  buffers: Record<string, { dirty: boolean }>
  onSelect(path: string): void
  onClose(path: string): void
  onNewTab(): void
  onContextMenu(path: string, event: ReactMouseEvent): void
  onMove(from: number, to: number): void
}) {
  // The tab being dragged, and the one it would land on.
  const [dragging, setDragging] = useState<number | null>(null)
  const [over, setOver] = useState<number | null>(null)

  if (tabs.length === 0) return null

  const drop = (event: DragEvent, index: number) => {
    event.preventDefault()
    if (dragging !== null && dragging !== index) onMove(dragging, index)
    setDragging(null)
    setOver(null)
  }

  return (
    <div className="tabbar" role="tablist">
      {tabs.map((path, index) => {
        const name = path.split('/').pop() ?? path
        const dirty = buffers[path]?.dirty ?? false
        return (
          <div
            key={path}
            role="tab"
            aria-selected={activePath === path}
            draggable
            className={`tab${activePath === path ? ' active' : ''}${dirty ? ' dirty' : ''}${
              over === index && dragging !== index ? ' drop-target' : ''
            }`}
            onClick={() => onSelect(path)}
            onAuxClick={(event) => {
              if (event.button === 1) onClose(path)
            }}
            onContextMenu={(event) => onContextMenu(path, event)}
            onDragStart={(event) => {
              setDragging(index)
              event.dataTransfer.effectAllowed = 'move'
              // Firefox refuses to start a drag without some payload.
              event.dataTransfer.setData('text/plain', path)
            }}
            onDragOver={(event) => {
              event.preventDefault()
              setOver(index)
            }}
            onDragLeave={() => setOver((current) => (current === index ? null : current))}
            onDrop={(event) => drop(event, index)}
            onDragEnd={() => {
              setDragging(null)
              setOver(null)
            }}
            title={path}
          >
            <span className="tab-name">{name}</span>
            <button
              type="button"
              className="tab-close"
              aria-label={`Close ${name}`}
              onClick={(event) => {
                event.stopPropagation()
                onClose(path)
              }}
            >
              <IconClose />
            </button>
          </div>
        )
      })}
      <button
        type="button"
        className="tab-new"
        title="New note in a new tab"
        aria-label="New note in a new tab"
        onClick={() => onNewTab()}
      >
        <IconPlus />
      </button>
    </div>
  )
}
