import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useActions, useAppState } from '../lib/store'
import { api } from '../lib/api'
import { ThemeName } from '../../shared/types'
import { IconDraw, IconPlus, IconRefresh } from '../components/Icons'

const DRAWING_EXT = 'excalidraw'

/** Canvas backgrounds, one per app theme. */
const CANVAS_BACKGROUND: Record<ThemeName, string> = {
  'nord-dark': '#2E3440',
  'nord-light': '#FDFEFF',
  'ayu-dark': '#0f1419',
  'ayu-mirage': '#1f2430',
}

/**
 * Excalidraw stores the canvas background in the scene, and its own defaults
 * are plain white/near-black. Those defaults — and the Nord backgrounds Delta
 * itself writes — are remapped to the surface of the active theme, so the
 * canvas always blends into the app. A colour the user picked deliberately is
 * left untouched.
 */
const EXCALIDRAW_DEFAULT_BACKGROUNDS = new Set([
  '#ffffff',
  '#f8f9fa',
  '#1b1b1f',
  '#121212',
])

/** True when the colour is one Delta manages rather than one the user chose. */
function isManagedBackground(color: unknown): boolean {
  if (typeof color !== 'string') return true
  const hex = color.toLowerCase()
  return (
    EXCALIDRAW_DEFAULT_BACKGROUNDS.has(hex) ||
    Object.values(CANVAS_BACKGROUND).some((value) => value.toLowerCase() === hex)
  )
}

function canvasBackground(scene: string | null, theme: ThemeName): string {
  const nord = CANVAS_BACKGROUND[theme]
  try {
    const raw = scene ? JSON.parse(scene) : null
    const stored = raw?.appState?.viewBackgroundColor
    if (typeof stored === 'string' && !isManagedBackground(stored)) {
      return stored
    }
  } catch {
    // A malformed scene falls back to the Nord canvas colour.
  }
  return nord
}

/** Drawings saved in the vault. */
export function DrawingsView() {
  const state = useAppState()
  const actions = useActions()
  const [active, setActive] = useState<string | null>(null)

  const drawings = useMemo(
    () => state.tree.filter((entry) => entry.kind === 'file' && entry.extension === DRAWING_EXT),
    [state.tree],
  )

  useEffect(() => {
    if (active && !drawings.some((entry) => entry.path === active)) {
      setActive(null)
    }
  }, [drawings, active])

  // Deep link: #/drawing/<path> opens a drawing directly.
  useEffect(() => {
    const readHash = () => {
      const match = /^#\/drawing\/(.+)$/.exec(window.location.hash)
      if (!match) return
      const path = decodeURIComponent(match[1])
      if (drawings.some((entry) => entry.path === path)) setActive(path)
    }
    readHash()
    window.addEventListener('hashchange', readHash)
    return () => window.removeEventListener('hashchange', readHash)
  }, [drawings])

  const createDrawing = () => {
    const name = `Drawing ${new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-')}`
    const path = api.drawingPath(`drawings/${name}`)
    try {
      api.createFile(
        path,
        JSON.stringify(
          {
            type: 'excalidraw',
            version: 2,
            source: 'delta',
            elements: [],
            appState: { gridSize: null, viewBackgroundColor: CANVAS_BACKGROUND[state.theme] },
            files: {},
          },
          null,
          2,
        ),
      )
      actions.refreshTree()
      setActive(path)
    } catch (error) {
      actions.toast('error', `Could not create the drawing: ${String(error)}`)
    }
  }

  if (!active) {
    return (
      <>
        <div className="toolbar">
          <span className="toolbar-title">Drawings</span>
          <span className="toolbar-spacer" />
          <button type="button" className="btn primary" onClick={createDrawing}>
            <IconPlus /> New drawing
          </button>
        </div>
        <div className="content">
          {drawings.length === 0 ? (
            <div className="empty">
              <IconDraw style={{ fontSize: 28 }} />
              <h3>No drawings yet</h3>
              <p>
                Create a diagram to sketch an idea. Drawings are stored as Excalidraw scene files
                inside the vault, so you can keep editing them here or elsewhere.
              </p>
            </div>
          ) : (
            <div style={{ padding: '10px 0' }}>
              {drawings.map((entry) => (
                <div
                  key={entry.path}
                  className="tree-row"
                  style={{ paddingLeft: 16 }}
                  onClick={() => setActive(entry.path)}
                >
                  <IconDraw className="tree-icon" />
                  <span className="tree-label">{entry.name}</span>
                </div>
              ))}
            </div>
          )}
        </div>
      </>
    )
  }

  return <DrawingEditor path={active} onClose={() => setActive(null)} />
}

/**
 * The drawing canvas.
 *
 * Excalidraw is a large dependency, so it is imported on demand — the module
 * is only fetched the first time a drawing is actually opened.
 */
function DrawingEditor({ path, onClose }: { path: string; onClose(): void }) {
  const actions = useActions()
  const state = useAppState()
  const [scene, setScene] = useState<string | null>(null)
  const [ExcalidrawComponent, setExcalidrawComponent] = useState<any>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  // The canvas API is held in state so the theme effect can run once the
  // canvas is actually ready.
  const [canvasApi, setCanvasApi] = useState<any>(null)
  const apiRef = useRef<any>(null)
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const pending = useRef<string | null>(null)

  // Load the canvas bundle on first use.
  useEffect(() => {
    let cancelled = false
    // Excalidraw fetches its fonts from a CDN by default; point it at the
    // copies bundled with the app so drawings work offline.
    ;(window as unknown as { EXCALIDRAW_ASSET_PATH?: string }).EXCALIDRAW_ASSET_PATH =
      new URL('./excalidraw-assets/', document.baseURI).href
    void import('@excalidraw/excalidraw')
      .then((module) => {
        if (cancelled) return
        void import('@excalidraw/excalidraw/index.css')
        setExcalidrawComponent(() => module.Excalidraw)
      })
      .catch((err) => {
        if (!cancelled) setError(String(err))
      })
    return () => {
      cancelled = true
    }
  }, [])

  // Load the scene file.
  useEffect(() => {
    try {
      const text = api.readFile(path)
      setScene(text)
    } catch (err) {
      setError(String(err))
    } finally {
      setLoading(false)
    }
  }, [path])

  const flush = useCallback(() => {
    const content = pending.current
    if (content === null) return
    pending.current = null
    try {
      api.writeFile(path, content)
    } catch (err) {
      actions.toast('error', `Could not save the drawing: ${String(err)}`)
    }
  }, [path, actions])

  // Follow the app theme: whenever the canvas is ready or the theme changes,
  // repaint the canvas background — unless the user picked a colour of their
  // own, which is then left alone.
  useEffect(() => {
    const canvas = canvasApi ?? apiRef.current
    if (!canvas?.getAppState || !canvas?.updateScene) return
    const current = canvas.getAppState()?.viewBackgroundColor
    if (!isManagedBackground(current)) return
    canvas.updateScene({ appState: { viewBackgroundColor: CANVAS_BACKGROUND[state.theme] } })
  }, [canvasApi, state.theme])

  const onChange = useCallback(
    (elements: unknown[], appState: Record<string, unknown>, files: Record<string, unknown>) => {
      // `collaborators` is a Map in memory and cannot round-trip through
      // JSON, so it is left out of the saved scene.
      const cleanAppState: Record<string, unknown> = { ...(appState as Record<string, unknown>) }
      delete cleanAppState.collaborators
      const content = JSON.stringify(
        { type: 'excalidraw', version: 2, source: 'delta', elements, appState: cleanAppState, files },
        null,
        2,
      )
      pending.current = content
      if (saveTimer.current) clearTimeout(saveTimer.current)
      saveTimer.current = setTimeout(flush, 800)
    },
    [flush],
  )

  useEffect(() => {
    return () => {
      if (saveTimer.current) clearTimeout(saveTimer.current)
      flush()
    }
  }, [flush])

  const exportDrawing = async (format: 'png' | 'svg') => {
    const api_ = apiRef.current
    if (!api_) return
    try {
      let blob: Blob | null = null
      if (format === 'png') {
        blob = await api_.exportToBlob({
          elements: api_.getElements(),
          appState: api_.getAppState(),
          files: api_.getFiles(),
          mimeType: 'image/png',
        })
      } else {
        const svg = await api_.exportToSvg({
          elements: api_.getElements(),
          appState: api_.getAppState(),
          files: api_.getFiles(),
        })
        blob = new Blob([svg as unknown as BlobPart], { type: 'image/svg+xml' })
      }
      if (!blob) return
      const bytes = new Uint8Array(await blob.arrayBuffer())
      const info = api.importAttachment(
        `${path.split('/').pop()?.replace(/\.excalidraw$/, '') ?? 'drawing'}.${format}`,
        bytes,
      )
      actions.toast('success', `Exported to ${info.path}`)
      actions.refreshTree()
    } catch (err) {
      actions.toast('error', `Could not export the drawing: ${String(err)}`)
    }
  }

  const linkFromNote = () => {
    actions.insertTextAtCursor(`\n[[${path}]]\n`)
    actions.toast('success', `Linked “${path}” from the current note`)
  }

  if (loading) {
    return (
      <div className="empty">
        <h3>Loading the drawing…</h3>
      </div>
    )
  }

  if (error) {
    return (
      <div className="empty">
        <h3>The drawing could not be opened</h3>
        <p className="mono">{error}</p>
      </div>
    )
  }

  if (!ExcalidrawComponent) {
    return (
      <div className="empty">
        <h3>Preparing the canvas…</h3>
      </div>
    )
  }

  let initialData: unknown
  try {
    const raw = scene ? JSON.parse(scene) : {}
    const appState: Record<string, unknown> = { ...(raw.appState ?? {}) }
    delete appState.collaborators
    initialData = {
      elements: raw.elements ?? [],
      files: raw.files ?? {},
      appState: {
        ...appState,
        // Excalidraw expects collaborators to be a Map.
        collaborators: new Map(),
        viewBackgroundColor: canvasBackground(scene, state.theme),
      },
    }
  } catch {
    initialData = {
      elements: [],
      files: {},
      appState: { collaborators: new Map(), viewBackgroundColor: canvasBackground(null, state.theme) },
    }
  }

  return (
    <div className="drawing-host">
      <div className="toolbar">
        <span className="toolbar-title">{path.split('/').pop()}</span>
        <span className="toolbar-spacer" />
        <button type="button" className="btn" onClick={linkFromNote} title="Insert a link to this drawing in the current note">
          Link from note
        </button>
        <button type="button" className="btn" onClick={() => void exportDrawing('png')}>
          Export PNG
        </button>
        <button type="button" className="btn" onClick={() => void exportDrawing('svg')}>
          Export SVG
        </button>
        <button type="button" className="btn" onClick={onClose}>
          <IconRefresh /> Back to list
        </button>
      </div>
      <div className="excalidraw-wrapper">
        <ExcalidrawComponent
          initialData={initialData}
          onChange={onChange}
          excalidrawAPI={(api_: unknown) => {
            apiRef.current = api_
            setCanvasApi(api_)
          }}
          theme={state.theme === 'nord-dark' ? 'dark' : 'light'}
          UIOptions={{
            canvasActions: {
              loadScene: false,
              saveToActiveFile: false,
              export: false,
              toggleTheme: false,
            },
          }}
          name={path}
        />
      </div>
    </div>
  )
}
