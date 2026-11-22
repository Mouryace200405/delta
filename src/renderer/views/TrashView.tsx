import { useEffect, useState } from 'react'
import type { TrashEntry } from '@shared/types'
import { useActions } from '../lib/store'
import { api } from '../lib/api'
import { IconRefresh, IconTrash } from '../components/Icons'

export function TrashView() {
  const actions = useActions()
  const [entries, setEntries] = useState<TrashEntry[]>([])

  const load = () => {
    try {
      setEntries(api.listTrash())
    } catch {
      setEntries([])
    }
  }

  useEffect(load, [])

  return (
    <>
      <div className="toolbar">
        <span className="toolbar-title">Trash</span>
        <span className="muted">{entries.length} item{entries.length === 1 ? '' : 's'}</span>
        <span className="toolbar-spacer" />
        <button type="button" className="btn" onClick={load}>
          <IconRefresh /> Refresh
        </button>
        <button
          type="button"
          className="btn danger"
          disabled={entries.length === 0}
          onClick={() => {
            actions.purgeTrash()
            load()
          }}
        >
          <IconTrash /> Empty trash
        </button>
      </div>
      <div className="content">
        {entries.length === 0 ? (
          <div className="empty">
            <h3>The trash is empty</h3>
            <p>Deleted files are kept here so nothing is lost by accident.</p>
          </div>
        ) : (
          entries.map((entry) => (
            <div className="trash-row" key={entry.path}>
              <IconTrash className="tree-icon" />
              <span style={{ flex: 1 }}>{entry.name}</span>
              <span className="muted">{entry.kind}</span>
              <span className="muted">{api.humanSize(entry.size)}</span>
              <button
                type="button"
                className="btn"
                onClick={() => {
                  actions.restoreFromTrash(entry.name)
                  load()
                }}
              >
                Restore
              </button>
            </div>
          ))
        )}
      </div>
    </>
  )
}
