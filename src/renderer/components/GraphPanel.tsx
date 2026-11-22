import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { GraphData } from '@shared/types'
import { useActions, useAppState } from '../lib/store'
import { graphNeighbors, layoutGraph, pickNode, type GraphLayout, type GraphPoint } from '../lib/graph'
import { IconChevron, IconGraph } from './Icons'

/** Height of the drawing area when the panel is open. */
const PANEL_HEIGHT = 200

interface Palette {
  edge: string
  edgeDim: string
  edgeActive: string
  node: string
  nodeMissing: string
  highlight: string
  active: string
  label: string
  labelBg: string
}

/**
 * The colours live in the stylesheet so every theme gets its own, and the
 * canvas never has to know which theme is active.
 */
function readPalette(): Palette {
  const styles = getComputedStyle(document.documentElement)
  const get = (name: string, fallback: string) => styles.getPropertyValue(name).trim() || fallback
  return {
    edge: get('--graph-edge', '#4c566a'),
    edgeDim: get('--graph-edge-dim', '#3b4252'),
    edgeActive: get('--graph-edge-active', '#88c0d0'),
    node: get('--graph-node', '#88c0d0'),
    nodeMissing: get('--graph-node-missing', '#62748c'),
    highlight: get('--graph-highlight', '#eceff4'),
    active: get('--graph-active', '#a3be8c'),
    label: get('--graph-label', '#d8dee9'),
    labelBg: get('--graph-label-bg', '#2e3440'),
  }
}

/**
 * The knowledge graph, folded into the bottom of the left sidebar.
 *
 * It shows every note as a dot and every link between notes as a line, the
 * way Obsidian draws its graph. Hovering a note lights up the notes it is
 * connected to; clicking one opens it; dragging one moves it out of the way.
 */
export function GraphPanel() {
  const state = useAppState()
  const actions = useActions()

  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const wrapRef = useRef<HTMLDivElement | null>(null)
  const layoutRef = useRef<GraphLayout | null>(null)
  const pointsRef = useRef<Map<string, GraphPoint>>(new Map())
  const paletteRef = useRef<Palette>(readPalette())
  const hoveredRef = useRef<string | null>(null)
  const activeRef = useRef<string | null>(null)
  const sizeRef = useRef({ width: 0, height: PANEL_HEIGHT })
  const graphRef = useRef<GraphData>(state.graph)
  const dragRef = useRef<{ id: string; startX: number; startY: number; moved: boolean } | null>(null)

  const [draggingId, setDraggingId] = useState<string | null>(null)
  const [width, setWidth] = useState(0)

  const open = state.graphOpen

  /** Paint the graph. Reads everything from refs so it never goes stale. */
  const draw = useCallback(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const ctx = canvas.getContext('2d')
    if (!ctx) return

    const { width: w, height: h } = sizeRef.current
    const dpr = window.devicePixelRatio || 1
    const pixelWidth = Math.max(1, Math.round(w * dpr))
    const pixelHeight = Math.max(1, Math.round(h * dpr))
    if (canvas.width !== pixelWidth || canvas.height !== pixelHeight) {
      canvas.width = pixelWidth
      canvas.height = pixelHeight
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    ctx.clearRect(0, 0, w, h)

    const layout = layoutRef.current
    const graph = graphRef.current
    if (!layout || layout.points.length === 0) return

    const palette = paletteRef.current
    const points = pointsRef.current
    const hover = hoveredRef.current
    const neighbours = hover ? graphNeighbors(graph.edges, hover) : null

    // Exposed so the hovered note can be found without reaching into React.
    canvas.dataset.hovered = hover ?? ''

    // Edges first, so the nodes sit on top of them.
    for (const edge of graph.edges) {
      const from = points.get(edge.source)
      const to = points.get(edge.target)
      if (!from || !to) continue
      const lit = hover !== null && (edge.source === hover || edge.target === hover)
      ctx.strokeStyle = hover === null ? palette.edge : lit ? palette.edgeActive : palette.edgeDim
      ctx.lineWidth = lit ? 1.5 : 1
      ctx.beginPath()
      ctx.moveTo(from.x, from.y)
      ctx.lineTo(to.x, to.y)
      ctx.stroke()
    }

    // Nodes.
    for (const node of graph.nodes) {
      const point = points.get(node.id)
      if (!point) continue
      const radius = layout.radii[node.id] ?? 3
      const dim = hover !== null && node.id !== hover && !neighbours?.has(node.id)
      ctx.globalAlpha = dim ? 0.22 : 1

      if (node.missing) {
        // A link with no note behind it is drawn as an empty ring.
        ctx.strokeStyle = palette.nodeMissing
        ctx.lineWidth = 1.2
        ctx.beginPath()
        ctx.arc(point.x, point.y, radius, 0, Math.PI * 2)
        ctx.stroke()
      } else {
        ctx.fillStyle = palette.node
        ctx.beginPath()
        ctx.arc(point.x, point.y, radius, 0, Math.PI * 2)
        ctx.fill()
      }

      if (node.id === activeRef.current) {
        ctx.strokeStyle = palette.active
        ctx.lineWidth = 1.6
        ctx.beginPath()
        ctx.arc(point.x, point.y, radius + 2.6, 0, Math.PI * 2)
        ctx.stroke()
      }
      if (node.id === hover) {
        ctx.strokeStyle = palette.highlight
        ctx.lineWidth = 1.4
        ctx.beginPath()
        ctx.arc(point.x, point.y, radius + 2, 0, Math.PI * 2)
        ctx.stroke()
      }
    }
    ctx.globalAlpha = 1

    // The name of the note under the cursor.
    if (hover) {
      const point = points.get(hover)
      const node = graph.nodes.find((item) => item.id === hover)
      if (point && node) {
        const radius = layout.radii[hover] ?? 3
        ctx.font = '11px "Noto Sans", system-ui, sans-serif'
        const text = node.title
        const measured = ctx.measureText(text).width
        let x = point.x + radius + 6
        if (x + measured > w - 4) x = point.x - radius - 6 - measured
        if (x < 2) x = 2
        const y = Math.min(h - 3, Math.max(12, point.y + 4))
        ctx.fillStyle = palette.labelBg
        ctx.fillRect(x - 3, y - 11, measured + 6, 15)
        ctx.fillStyle = palette.label
        ctx.fillText(text, x, y)
      }
    }
  }, [])

  // Keep the refs in step with the store.
  useEffect(() => {
    graphRef.current = state.graph
    activeRef.current = state.activePath
  }, [state.graph, state.activePath])

  // The theme decides the colours, so the palette is read again on a change.
  useEffect(() => {
    paletteRef.current = readPalette()
    draw()
  }, [state.theme, draw])

  // Measure the panel so the layout knows how much room it has.
  //
  // The first measurement is taken directly rather than from a resize
  // observer: observers only report while the window is painting, so a panel
  // that is opened before the window is on screen would never be measured.
  useLayoutEffect(() => {
    if (!open) return
    const element = wrapRef.current
    if (!element) return
    const measure = (): void => {
      const next = Math.max(0, Math.floor(element.getBoundingClientRect().width))
      sizeRef.current = { width: next, height: PANEL_HEIGHT }
      setWidth(next)
    }
    measure()
    const observer = new ResizeObserver(() => measure())
    observer.observe(element)
    return () => observer.disconnect()
  }, [open])

  // Lay the graph out whenever the data or the panel changes.
  useEffect(() => {
    if (!open || width <= 0) return
    const layout = layoutGraph(state.graph.nodes, state.graph.edges, width, PANEL_HEIGHT)
    layoutRef.current = layout
    pointsRef.current = new Map(layout.points.map((point) => [point.id, point]))
    draw()
  }, [state.graph, open, width, draw])

  const setHover = useCallback(
    (id: string | null) => {
      if (hoveredRef.current === id) return
      hoveredRef.current = id
      draw()
    },
    [draw],
  )

  const pickAt = useCallback((event: { clientX: number; clientY: number }): string | null => {
    const canvas = canvasRef.current
    const layout = layoutRef.current
    if (!canvas || !layout) return null
    const rect = canvas.getBoundingClientRect()
    return pickNode(layout.points, layout.radii, event.clientX - rect.left, event.clientY - rect.top)
  }, [])

  const onMouseDown = (event: React.MouseEvent<HTMLCanvasElement>) => {
    const id = pickAt(event)
    if (!id) return
    dragRef.current = { id, startX: event.clientX, startY: event.clientY, moved: false }
    setDraggingId(id)
  }

  const onMouseMove = (event: React.MouseEvent<HTMLCanvasElement>) => {
    setHover(pickAt(event))
    const drag = dragRef.current
    if (!drag) return
    const dx = event.clientX - drag.startX
    const dy = event.clientY - drag.startY
    if (!drag.moved && (Math.abs(dx) > 3 || Math.abs(dy) > 3)) drag.moved = true
    if (!drag.moved) return
    const canvas = canvasRef.current
    const point = pointsRef.current.get(drag.id)
    if (!canvas || !point) return
    const rect = canvas.getBoundingClientRect()
    point.x = Math.min(rect.width - 2, Math.max(2, event.clientX - rect.left))
    point.y = Math.min(rect.height - 2, Math.max(2, event.clientY - rect.top))
    draw()
  }

  const onMouseUp = (event: React.MouseEvent<HTMLCanvasElement>) => {
    const drag = dragRef.current
    dragRef.current = null
    setDraggingId(null)
    if (!drag || drag.moved) return
    const id = pickAt(event)
    if (!id) return
    const node = state.graph.nodes.find((item) => item.id === id)
    if (!node || node.missing) return
    actions.openNote(node.path)
    actions.setView('notes')
  }

  const onMouseLeave = () => {
    setHover(null)
    dragRef.current = null
    setDraggingId(null)
  }

  const nodes = state.graph.nodes.length
  const edges = state.graph.edges.length
  const hasLinks = edges > 0

  return (
    <div className={`graph-panel${open ? ' open' : ''}`}>
      {open && (
        <div className="graph-body" ref={wrapRef} style={{ height: PANEL_HEIGHT }}>
          <canvas
            ref={canvasRef}
            className={`graph-canvas${draggingId ? ' dragging' : ''}`}
            style={{ height: PANEL_HEIGHT }}
            onMouseDown={onMouseDown}
            onMouseMove={onMouseMove}
            onMouseUp={onMouseUp}
            onMouseLeave={onMouseLeave}
          />
          {nodes === 0 && <div className="graph-empty">No notes yet</div>}
          {nodes > 0 && !hasLinks && (
            <div className="graph-empty">Link notes with [[double brackets]] to grow the graph</div>
          )}
        </div>
      )}

      <button
        type="button"
        className="graph-toggle"
        onClick={() => actions.setGraphOpen(!open)}
        title={open ? 'Hide the knowledge graph' : 'Show the knowledge graph'}
        aria-expanded={open}
      >
        <IconChevron className={`graph-chevron${open ? ' open' : ''}`} />
        <IconGraph />
        <span>Graph</span>
        <span className="muted graph-count">
          {nodes > 0 ? `${nodes} · ${edges}` : '—'}
        </span>
      </button>
    </div>
  )
}
