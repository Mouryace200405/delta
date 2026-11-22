import { useCallback, useMemo, useState, type DragEvent, type MouseEvent, type ReactElement } from 'react'
import type { TreeEntry } from '@shared/types'
import { IconChevron, IconDraw, IconFolder, IconFolderOpen, IconImage, IconNote } from './Icons'
import type { ContextMenuItem } from './ContextMenu'

interface TreeNode {
  entry: TreeEntry
  children: TreeNode[]
}

/** Turn the flat vault listing into a nested tree. */
export function buildTree(entries: TreeEntry[]): TreeNode[] {
  const roots: TreeNode[] = []
  const stack: TreeNode[] = []

  for (const entry of entries) {
    const node: TreeNode = { entry, children: [] }
    while (stack.length > 0 && stack[stack.length - 1].entry.depth >= entry.depth) {
      stack.pop()
    }
    const parent = stack[stack.length - 1]
    if (parent) parent.children.push(node)
    else roots.push(node)
    stack.push(node)
  }
  return roots
}

const DRAWING_EXT = 'excalidraw'
const IMAGE_EXT = ['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'bmp']

export function FileTree({
  entries,
  activePath,
  onOpen,
  onOpenDrawing,
  onContextMenu,
  onMove,
}: {
  entries: TreeEntry[]
  activePath: string | null
  onOpen(path: string): void
  onOpenDrawing(path: string): void
  onContextMenu(event: MouseEvent, entry: TreeEntry): void
  onMove(path: string, destination: string): void
}) {
  const [expanded, setExpanded] = useState<Set<string>>(new Set())
  const [dragPath, setDragPath] = useState<string | null>(null)
  const [dropTarget, setDropTarget] = useState<string | null>(null)

  const tree = useMemo(() => buildTree(entries), [entries])

  const toggle = useCallback((path: string) => {
    setExpanded((current) => {
      const next = new Set(current)
      if (next.has(path)) next.delete(path)
      else next.add(path)
      return next
    })
  }, [])

  const activate = useCallback(
    (entry: TreeEntry) => {
      if (entry.kind === 'folder') {
        toggle(entry.path)
        return
      }
      if (entry.extension === DRAWING_EXT) {
        onOpenDrawing(entry.path)
        return
      }
      if (entry.extension === 'md' || entry.extension === 'markdown') {
        onOpen(entry.path)
        return
      }
      // Other files open in the system application.
      onOpen(entry.path)
    },
    [onOpen, onOpenDrawing, toggle],
  )

  const handleDragStart = (event: DragEvent, entry: TreeEntry) => {
    setDragPath(entry.path)
    event.dataTransfer.effectAllowed = 'move'
    event.dataTransfer.setData('text/plain', entry.path)
  }

  const handleDragOver = (event: DragEvent, entry: TreeEntry) => {
    if (!dragPath || dragPath === entry.path) return
    if (entry.kind !== 'folder') return
    event.preventDefault()
    event.dataTransfer.dropEffect = 'move'
    setDropTarget(entry.path)
  }

  const handleDrop = (event: DragEvent, entry: TreeEntry) => {
    event.preventDefault()
    event.stopPropagation()
    const source = dragPath ?? event.dataTransfer.getData('text/plain')
    setDropTarget(null)
    setDragPath(null)
    if (!source || source === entry.path) return
    // Refuse to move a folder into itself or one of its descendants.
    if (entry.path === source || entry.path.startsWith(`${source}/`)) return
    onMove(source, entry.path)
  }

  const renderNode = (node: TreeNode): ReactElement => {
    const { entry } = node
    const isFolder = entry.kind === 'folder'
    const isOpen = expanded.has(entry.path)
    const isDrawing = entry.extension === DRAWING_EXT
    const isImage = IMAGE_EXT.includes(entry.extension)

    return (
      <div key={entry.path}>
        <div
          className={[
            'tree-row',
            activePath === entry.path ? 'selected' : '',
            dropTarget === entry.path ? 'drop-target' : '',
            dragPath === entry.path ? 'dragging' : '',
            isDrawing ? 'is-drawing' : '',
            isImage ? 'is-image' : '',
          ]
            .filter(Boolean)
            .join(' ')}
          style={{ paddingLeft: 8 + entry.depth * 13 }}
          onClick={() => activate(entry)}
          onContextMenu={(event) => onContextMenu(event, entry)}
          draggable
          onDragStart={(event) => handleDragStart(event, entry)}
          onDragOver={(event) => handleDragOver(event, entry)}
          onDragLeave={() => setDropTarget((t) => (t === entry.path ? null : t))}
          onDrop={(event) => handleDrop(event, entry)}
          onDragEnd={() => {
            setDragPath(null)
            setDropTarget(null)
          }}
          title={entry.path}
        >
          {isFolder ? (
            <>
              <IconChevron className={`tree-chevron${isOpen ? ' open' : ''}`} />
              {isOpen ? <IconFolderOpen className="tree-icon" /> : <IconFolder className="tree-icon" />}
            </>
          ) : isDrawing ? (
            <IconDraw className="tree-icon" />
          ) : isImage ? (
            <IconImage className="tree-icon" />
          ) : (
            <IconNote className="tree-icon" />
          )}
          <span className="tree-label">{entry.name}</span>
        </div>
        {isFolder && isOpen && node.children.map(renderNode)}
      </div>
    )
  }

  if (entries.length === 0) {
    return (
      <div style={{ padding: '18px 14px', color: 'var(--text-faint)', fontSize: 12 }}>
        This vault is empty. Create a note to get started.
      </div>
    )
  }

  return <div className="tree">{tree.map(renderNode)}</div>
}

/** Menu entries for a file or folder in the tree. */
export function treeMenuItems(
  entry: TreeEntry,
  handlers: {
    open(): void
    rename(): void
    remove(): void
    newNote(): void
    newFolder(): void
    reveal(): void
  },
): ContextMenuItem[] {
  const isFolder = entry.kind === 'folder'
  return [
    { label: 'Open', onSelect: handlers.open },
    ...(isFolder
      ? [
          { label: 'New note here', onSelect: handlers.newNote },
          { label: 'New folder here', onSelect: handlers.newFolder },
        ]
      : []),
    { label: 'Rename…', onSelect: handlers.rename },
    { label: 'Show in file manager', onSelect: handlers.reveal },
    { label: '', onSelect: () => {}, separator: true },
    { label: isFolder ? 'Delete folder' : 'Delete file', onSelect: handlers.remove, danger: true },
  ]
}
