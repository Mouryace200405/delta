import { useEffect, useState } from 'react'
import { api } from '../lib/api'
import type { VaultStats } from '@shared/types'

export function StatusBar({
  vaultName,
  saveState,
  activePath,
  wordCount,
  showStats,
}: {
  vaultName: string | null
  saveState: 'idle' | 'saving' | 'saved' | 'error'
  activePath: string | null
  wordCount: number
  showStats: boolean
}) {
  const [stats, setStats] = useState<VaultStats | null>(null)

  useEffect(() => {
    if (!showStats) return
    let cancelled = false
    const load = () => {
      try {
        const next = api.stats()
        if (!cancelled) setStats(next)
      } catch {
        /* the vault may be closing */
      }
    }
    load()
    const timer = setInterval(load, 20_000)
    return () => {
      cancelled = true
      clearInterval(timer)
    }
  }, [showStats, activePath])

  const label =
    saveState === 'saving' ? 'Saving…' : saveState === 'error' ? 'Save failed' : saveState === 'saved' ? 'Saved' : 'Ready'

  return (
    <div className="statusbar">
      <span className="status-item">
        <span
          className={`status-dot${saveState === 'saving' ? ' saving' : ''}${saveState === 'error' ? ' error' : ''}`}
        />
        {label}
      </span>
      {activePath && (
        <span className="status-item mono" title={activePath}>
          {activePath}
        </span>
      )}
      <span className="spacer" />
      {showStats && stats && (
        <>
          <span className="status-item">{stats.notes} notes</span>
          <span className="status-item">{stats.tasks} tasks</span>
          <span className="status-item">{stats.events} events</span>
          <span className="status-item">{api.humanSize(stats.vaultBytes)}</span>
        </>
      )}
      <span className="status-item">{wordCount.toLocaleString()} words</span>
      <span className="status-item">{vaultName ?? 'No vault'}</span>
    </div>
  )
}
