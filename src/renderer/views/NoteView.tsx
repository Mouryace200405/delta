import { useMemo } from 'react'
import type { LinkRecord } from '@shared/types'
import { useActions, useAppState } from '../lib/store'
import { api } from '../lib/api'
import { createMarkdown, stripFrontmatter } from '../lib/markdown'
import { htmlToSpeech } from '../lib/speech'
import { normalizePath, parentDir } from '../lib/paths'
import { MarkdownEditor } from '../components/Editor'
import { ReadAloud } from '../components/ReadAloud'
import { IconCode, IconColumns, IconEye, IconImage, IconLink, IconPencil, IconRefresh } from '../components/Icons'

export function NoteView() {
  const state = useAppState()
  const actions = useActions()

  const path = state.activePath
  const buffer = path ? state.buffers[path] : undefined
  const note = state.notes.find((n) => n.path === path)
  const mode = state.viewMode

  // `editing` shows the note as it is written; `source` shows the raw
  // Markdown; `reading` shows the finished note; `split` shows both.
  const showEditor = mode === 'editing' || mode === 'source' || mode === 'split'
  const showPreview = mode === 'reading' || mode === 'split'
  const livePreview = mode !== 'source'

  const backlinks = useMemo<LinkRecord[]>(() => {
    if (!path) return []
    try {
      return api.backlinks(path)
    } catch {
      return []
    }
  }, [path, state.notes])

  const linkTargets = useMemo(
    () => state.notes.map((n) => n.title || n.path.split('/').pop() || n.path),
    [state.notes],
  )

  const html = useMemo(() => {
    if (!path || !buffer) return ''
    const md = createMarkdown({
      notePath: path,
      resolveNote(target: string) {
        try {
          return api.resolveLink(target, path)
        } catch {
          return null
        }
      },
      resolveFile(target: string) {
        if (/^(https?:|data:|file:)/i.test(target)) return target
        const decoded = decodeURIComponent(target)
        const base = parentDir(path)
        const joined = decoded.startsWith('/') ? decoded.slice(1) : `${base}/${decoded}`
        const normalized = normalizePath(joined)
        try {
          return `file://${api.absolutePath(normalized)}`
        } catch {
          return decoded
        }
      },
    })
    try {
      return md.render(stripFrontmatter(buffer.content))
    } catch (error) {
      return `<p class="muted">Preview error: ${String(error)}</p>`
    }
  }, [path, buffer?.content])

  // What the voice reads is what the note looks like, not what it is typed as.
  const speech = useMemo(() => htmlToSpeech(html), [html])

  if (!path || !buffer) {
    return (
      <div className="empty">
        <h3>No note open</h3>
        <p>
          Pick a note from the sidebar, or press <span className="kbd-hint">Ctrl+P</span> to search
          the vault.
        </p>
      </div>
    )
  }

  const onPasteImage = (file: File) => {
    void file.arrayBuffer().then((buffer) => {
      void actions.insertImage(new Uint8Array(buffer), file.name)
    })
  }

  const onDropImage = (file: File) => {
    void file.arrayBuffer().then((buffer) => {
      void actions.insertImage(new Uint8Array(buffer), file.name)
    })
  }

  const pickImage = async () => {
    const files = await api.pickFiles(['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg'])
    for (const file of files) {
      await actions.importImageFromDisk(file)
    }
  }

  return (
    <>
      {buffer.conflict && (
        <div className="conflict-banner">
          <span>
            <strong>{path}</strong> changed on disk while you had unsaved edits.
          </span>
          <span style={{ flex: 1 }} />
          <button
            type="button"
            className="btn"
            onClick={() => {
              const theirs = buffer.conflict?.theirs
              if (theirs === undefined || theirs === null) return
              actions.setBufferContent(path, theirs)
              void actions.saveNote(path)
            }}
          >
            <IconRefresh /> Use the file on disk
          </button>
          <button
            type="button"
            className="btn"
            onClick={() => {
              void actions.saveNote(path)
            }}
          >
            Keep my version
          </button>
        </div>
      )}

      <div className="toolbar">
          <span className="toolbar-title">{note?.title ?? path.split('/').pop()}</span>
          {note && note.tags.length > 0 && (
            <span style={{ display: 'flex', gap: 5 }}>
              {note.tags.map((tag) => (
                <span key={tag} className="chip">
                  #{tag}
                </span>
              ))}
            </span>
          )}
          <span className="toolbar-spacer" />
          <ReadAloud text={speech} plain />
          <button type="button" className="btn" onClick={pickImage} title="Attach an image">
            <IconImage /> Image
          </button>
          <button
            type="button"
            className="btn"
            onClick={() => actions.insertLink('')}
            title="Insert a link to another note"
          >
            <IconLink /> Link
          </button>
          <button
            type="button"
            className="btn"
            onClick={() => actions.setModal({ kind: 'task', draft: { title: '', noteId: note?.id } })}
            title="Create a task for this note"
          >
            + Task
          </button>
        <div style={{ display: 'flex', gap: 6 }}>
          {mode !== 'reading' && (
            <button
              type="button"
              className="btn"
              onClick={() => actions.setViewMode('reading')}
              title="Show the finished note"
            >
              <IconEye /> Reading
            </button>
          )}
          {mode !== 'editing' && (
            <button
              type="button"
              className="btn"
              onClick={() => actions.setViewMode('editing')}
              title="Write the note as you read it"
            >
              <IconPencil /> Editing
            </button>
          )}
          {mode !== 'source' && (
            <button
              type="button"
              className="btn"
              onClick={() => actions.setViewMode('source')}
              title="Show the raw Markdown"
            >
              <IconCode /> Source
            </button>
          )}
          <button
            type="button"
            className={`btn${mode === 'split' ? ' active' : ''}`}
            onClick={() => actions.setViewMode(mode === 'split' ? 'reading' : 'split')}
            title="Show the note and the Markdown side by side"
          >
            <IconColumns /> {mode === 'split' ? 'Split on' : 'Split'}
          </button>
        </div>
      </div>

      <div className={`content${mode === 'split' ? ' split' : ''}`}>
        {showEditor && (
          <div className="pane">
            <MarkdownEditor
              value={buffer.content}
              theme={state.theme}
              preview={livePreview}
              placeholderText="Start writing…"
              onChange={(value) => actions.setBufferContent(path, value)}
              onSave={() => void actions.saveNote(path)}
              onPasteImage={onPasteImage}
              onDropImage={onDropImage}
              linkTargets={() => linkTargets}
              onNavigateLink={(target) => {
                const resolved = api.resolveLink(target, path)
                if (resolved) actions.openNote(resolved)
                else actions.toast('warn', `No note named “${target}”`)
              }}
            />
          </div>
        )}

        {showPreview && (
          <div className="pane">
            <div
              className="markdown-body"
              onClick={(event) => {
                const target = event.target as HTMLElement
                const link = target.closest('a') as HTMLAnchorElement | null
                if (!link) return
                const href = link.getAttribute('href') ?? ''
                if (href.startsWith('#/note/')) {
                  event.preventDefault()
                  const targetPath = decodeURIComponent(href.slice('#/note/'.length))
                  actions.openNote(targetPath)
                } else if (href.endsWith('.md')) {
                  event.preventDefault()
                  const resolved = api.resolveLink(href, path)
                  if (resolved) actions.openNote(resolved)
                }
              }}
              dangerouslySetInnerHTML={{ __html: html }}
            />
            {backlinks.length > 0 && (
              <div className="backlinks">
                <h4>Backlinks · {backlinks.length}</h4>
                {backlinks.map((link, index) => (
                  <div
                    key={`${link.sourcePath}-${index}`}
                    className="backlink-item"
                    onClick={() => actions.openNote(link.sourcePath)}
                  >
                    <span>{link.sourcePath.split('/').pop()}</span>
                    <span className="ctx">{link.sourcePath}</span>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}
      </div>
    </>
  )
}
