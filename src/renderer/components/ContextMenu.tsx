import { useEffect, useLayoutEffect, useRef, useState, type MouseEvent as ReactMouseEvent } from 'react'

export interface ContextMenuItem {
  label: string
  onSelect(): void
  danger?: boolean
  separator?: boolean
}

/**
 * A lightweight context menu rendered at the pointer position.
 *
 * It flips when it would run off-screen and closes on Escape or an outside
 * click, matching the behaviour of a native menu.
 */
export function ContextMenu({
  x,
  y,
  items,
  onClose,
}: {
  x: number
  y: number
  items: ContextMenuItem[]
  onClose(): void
}) {
  const ref = useRef<HTMLDivElement>(null)
  const [position, setPosition] = useState({ x, y })

  useLayoutEffect(() => {
    const element = ref.current
    if (!element) return
    const rect = element.getBoundingClientRect()
    let nextX = x
    let nextY = y
    if (x + rect.width > window.innerWidth - 8) nextX = Math.max(8, x - rect.width)
    if (y + rect.height > window.innerHeight - 8) nextY = Math.max(8, y - rect.height)
    setPosition({ x: nextX, y: nextY })
  }, [x, y, items.length])

  useEffect(() => {
    const onPointerDown = (event: MouseEvent) => {
      if (!ref.current?.contains(event.target as Node)) onClose()
    }
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose()
    }
    window.addEventListener('mousedown', onPointerDown, true)
    window.addEventListener('keydown', onKey)
    window.addEventListener('resize', onClose)
    return () => {
      window.removeEventListener('mousedown', onPointerDown, true)
      window.removeEventListener('keydown', onKey)
      window.removeEventListener('resize', onClose)
    }
  }, [onClose])

  return (
    <div className="ctx-menu" ref={ref} style={{ left: position.x, top: position.y }} role="menu">
      {items.map((item, index) =>
        item.separator ? (
          <div className="ctx-sep" key={`sep-${index}`} />
        ) : (
          <button
            type="button"
            role="menuitem"
            key={item.label}
            className={`ctx-item${item.danger ? ' danger' : ''}`}
            onClick={() => {
              item.onSelect()
              onClose()
            }}
          >
            {item.label}
          </button>
        ),
      )}
    </div>
  )
}

/** Hook that tracks the position and items of the active context menu. */
export function useContextMenu() {
  const [menu, setMenu] = useState<{ x: number; y: number; items: ContextMenuItem[] } | null>(null)

  const open = (event: ReactMouseEvent, items: ContextMenuItem[]) => {
    event.preventDefault()
    setMenu({ x: event.clientX, y: event.clientY, items })
  }

  const close = () => setMenu(null)

  return { menu, open, close }
}
