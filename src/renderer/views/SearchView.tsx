import { useEffect, useState } from 'react'
import { useActions, useAppState } from '../lib/store'
import { api } from '../lib/api'
import { IconSearch } from '../components/Icons'

export function SearchView() {
  const state = useAppState()
  const actions = useActions()
  const [query, setQuery] = useState(state.searchQuery)

  useEffect(() => {
    const timer = setTimeout(() => actions.search(query), 140)
    return () => clearTimeout(timer)
  }, [query, actions])

  return (
    <>
      <div className="search-bar">
        <IconSearch style={{ color: 'var(--text-faint)' }} />
        <input
          className="input"
          autoFocus
          placeholder="Search titles, contents, tasks and events…"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
        />
        {query && (
          <button type="button" className="btn ghost" onClick={() => setQuery('')}>
            Clear
          </button>
        )}
      </div>
      <div className="content">
        {state.searchResults.length === 0 ? (
          <div className="empty">
            <h3>{query ? 'No matches' : 'Search the vault'}</h3>
            <p>
              {query
                ? 'Try a different word, or search for a tag such as #project.'
                : 'Results come from note titles, note contents, tags, tasks and calendar events.'}
            </p>
          </div>
        ) : (
          <>
            <div className="sidebar-section" style={{ paddingLeft: 18 }}>
              {state.searchResults.length} result{state.searchResults.length === 1 ? '' : 's'}
            </div>
            {state.searchResults.map((result, index) => (
              <div
                key={`${result.kind}-${result.path || result.title}-${index}`}
                className="result-row"
                onClick={() => {
                  if (result.kind === 'note' && result.path) actions.openNote(result.path)
                  else if (result.kind === 'task') actions.setView('tasks')
                  else if (result.kind === 'event') actions.setView('calendar')
                }}
              >
                <span className="result-title">{result.title || result.path}</span>
                <span className="result-snippet">{result.snippet}</span>
                {result.path && <span className="result-kind">{result.path}</span>}
                <span className="result-kind">{result.kind}</span>
              </div>
            ))}
          </>
        )}
      </div>
    </>
  )
}

/** Notes that carry a given tag — used by the sidebar tag list. */
export function TagResults({ tag }: { tag: string }) {
  const actions = useActions()
  const [notes, setNotes] = useState(() => {
    try {
      return api.notesByTag(tag)
    } catch {
      return []
    }
  })

  useEffect(() => {
    try {
      setNotes(api.notesByTag(tag))
    } catch {
      setNotes([])
    }
  }, [tag])

  return (
    <div className="content">
      <div className="sidebar-section" style={{ paddingLeft: 18 }}>
        #{tag} · {notes.length} note{notes.length === 1 ? '' : 's'}
      </div>
      {notes.map((note) => (
        <div key={note.path} className="result-row" onClick={() => actions.openNote(note.path)}>
          <span className="result-title">{note.title}</span>
          <span className="result-snippet">{note.excerpt}</span>
          <span className="result-kind">{note.path}</span>
        </div>
      ))}
    </div>
  )
}
