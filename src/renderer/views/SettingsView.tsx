import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react'
import type { ContentFont, NoteViewMode, SyncStatus, ThemeName, TtsStatus } from '@shared/types'
import { useActions, useAppState } from '../lib/store'
import { api } from '../lib/api'
import { localTimezone } from '../lib/dates'
import { IconBackup, IconRefresh, IconSync } from '../components/Icons'

/** The themes on offer, with the colours used for their preview. */
const THEMES: { id: ThemeName; label: string; palette: string[] }[] = [
  { id: 'nord-dark', label: 'Nord Dark', palette: ['#2E3440', '#3B4252', '#88C0D0', '#A3BE8C'] },
  { id: 'nord-light', label: 'Nord Light', palette: ['#ECEFF4', '#E5E9F0', '#5E81AC', '#A3BE8C'] },
  { id: 'ayu-dark', label: 'Ayu Dark', palette: ['#0F1419', '#161B22', '#39BAE6', '#AAD94C'] },
  { id: 'ayu-mirage', label: 'Ayu Mirage', palette: ['#1F2430', '#242936', '#5CCFE6', '#AAD94C'] },
]

/** A small coloured label that states what is true about a subsystem. */
function StatusPill({
  tone,
  children,
}: {
  tone: 'ok' | 'warn' | 'off'
  children: ReactNode
}) {
  return <span className={`status-pill ${tone}`}>{children}</span>
}

export function SettingsView() {
  const state = useAppState()
  const actions = useActions()

  const [backups, setBackups] = useState<{ path: string; name: string; size: number }[]>([])
  const [backupDir, setBackupDir] = useState('')

  // --- voice ---------------------------------------------------------------
  const [voiceStatus, setVoiceStatus] = useState<TtsStatus | null>(null)
  const [voice, setVoice] = useState('')
  const [piperPath, setPiperPath] = useState('')
  const [rate, setRate] = useState(1)

  // --- sync ----------------------------------------------------------------
  const [token, setToken] = useState('')
  const [hasToken, setHasToken] = useState(false)
  const [repo, setRepo] = useState('')
  const [branch, setBranch] = useState('main')
  const [useLfs, setUseLfs] = useState(true)
  const [syncStatus, setSyncStatus] = useState<SyncStatus | null>(null)
  const [syncing, setSyncing] = useState(false)

  const coreVersion = useMemo(() => {
    try {
      return api.coreVersion()
    } catch {
      return '0.0.0'
    }
  }, [])

  // Load the stored settings once the vault is open.
  useEffect(() => {
    if (!state.vault) return
    try {
      setVoice(api.getSetting('ttsVoice') ?? '')
      setPiperPath(api.getSetting('ttsPiperPath') ?? '')
      const storedRate = Number(api.getSetting('ttsRate') ?? '1')
      setRate(Number.isFinite(storedRate) && storedRate > 0 ? storedRate : 1)
      setRepo(api.getSetting('syncRepo') ?? '')
      setBranch(api.getSetting('syncBranch') ?? 'main')
      setUseLfs(api.getSetting('syncLfs') !== '0')
    } catch {
      /* settings are best-effort */
    }
    try {
      setVoiceStatus(api.ttsStatus())
    } catch {
      setVoiceStatus(null)
    }
    void api.getSyncToken().then((stored) => {
      setHasToken(Boolean(stored))
    })
  }, [state.vault])

  // Keep the sync panel up to date.
  const refreshSyncStatus = useCallback(() => {
    if (!state.vault) return
    try {
      setSyncStatus(api.syncStatus(repo || undefined, branch || undefined))
    } catch {
      setSyncStatus(null)
    }
  }, [state.vault, repo, branch])

  useEffect(() => {
    refreshSyncStatus()
  }, [refreshSyncStatus])

  const saveSetting = (key: string, value: string) => {
    try {
      api.setSetting(key, value)
    } catch {
      /* settings are best-effort */
    }
  }

  const loadBackups = async () => {
    const dir = await api.pickFolder('Choose the folder that holds your backups')
    if (!dir) return
    setBackupDir(dir)
    try {
      setBackups(api.listBackups(dir))
    } catch {
      setBackups([])
    }
  }

  const exportCalendar = async () => {
    try {
      const ics = api.exportCalendar(state.events, state.vault?.name ?? 'Delta')
      api.writeFile('calendar.ics', ics)
      actions.refreshTree()
      actions.toast('success', 'Calendar exported to the vault root')
    } catch (error) {
      actions.toast('error', `Could not export the calendar: ${String(error)}`)
    }
  }

  const importCalendar = async () => {
    try {
      const files = await api.pickFiles(['ics'])
      if (files.length === 0) return
      const bytes = api.readBytes(files[0])
      const text = new TextDecoder().decode(bytes)
      const imported = api.importCalendar(text)
      if (imported.length === 0) {
        actions.toast('warn', 'That file contained no events')
        return
      }
      for (const event of imported) {
        api.saveEvent({ ...event, id: '' })
      }
      actions.refreshEvents()
      actions.toast('success', `Imported ${imported.length} event${imported.length === 1 ? '' : 's'}`)
    } catch (error) {
      actions.toast('error', `Could not import the calendar: ${String(error)}`)
    }
  }

  // --- voice ---------------------------------------------------------------

  const saveVoice = (path: string) => {
    setVoice(path)
    saveSetting('ttsVoice', path)
  }

  const testVoice = async () => {
    const model = voice || voiceStatus?.voices[0]?.path || ''
    if (!model) {
      actions.toast('warn', 'No voice model is selected')
      return
    }
    try {
      const path = await api.speak(
        'Delta can read your notes aloud. This is how it sounds.',
        model,
        piperPath || undefined,
        rate,
        true,
      )
      const audio = new Audio(window.delta.audioFileUrl(path))
      await audio.play()
    } catch (error) {
      actions.toast('error', `Could not play the sample: ${String(error)}`)
    }
  }

  // --- sync ----------------------------------------------------------------

  const saveToken = async () => {
    try {
      await api.setSyncToken(token.trim())
      setHasToken(token.trim().length > 0)
      if (token.trim()) {
        setToken('')
        actions.toast('success', 'Token saved in the system key store')
      } else {
        actions.toast('info', 'Token removed')
      }
    } catch (error) {
      actions.toast('error', `Could not store the token: ${String(error)}`)
    }
  }

  const createRepo = async () => {
    const name = repo.trim()
    if (!name) {
      actions.toast('warn', 'Enter a repository name first')
      return
    }
    setSyncing(true)
    try {
      const result = await api.createGitHubRepo(name.replace(/\.git$/, ''), true)
      if (result.ok) {
        setRepo(result.repo)
        saveSetting('syncRepo', result.repo)
        actions.toast('success', `Created ${result.repo}`)
      } else {
        actions.toast('error', result.message)
      }
    } finally {
      setSyncing(false)
    }
  }

  const runSync = async (mode: 'sync' | 'push' | 'pull') => {
    setSyncing(true)
    try {
      const result =
        mode === 'push'
          ? await api.syncPush(repo || undefined, branch || undefined)
          : mode === 'pull'
            ? await api.syncPull(repo || undefined, branch || undefined)
            : await api.syncNow(repo || undefined, branch || undefined)

      if (result.conflict) {
        actions.toast('warn', result.message)
      } else if (result.ok) {
        actions.toast('success', result.message)
      } else {
        actions.toast('error', result.message)
      }

      // Files may have arrived from the other device.
      actions.refreshTree()
      actions.refreshNotes()
      actions.refreshTasks()
      actions.refreshEvents()
      refreshSyncStatus()
    } catch (error) {
      actions.toast('error', `Sync failed: ${String(error)}`)
    } finally {
      setSyncing(false)
    }
  }

  const setupSync = async () => {
    if (!repo.trim()) {
      actions.toast('warn', 'Enter a repository first')
      return
    }
    setSyncing(true)
    try {
      saveSetting('syncRepo', repo.trim())
      saveSetting('syncBranch', branch.trim() || 'main')
      saveSetting('syncLfs', useLfs ? '1' : '0')
      const result = await api.syncSetup(repo.trim(), branch.trim() || 'main', useLfs)
      actions.toast('success', result.message)
      refreshSyncStatus()
    } catch (error) {
      actions.toast('error', `Could not set up sync: ${String(error)}`)
    } finally {
      setSyncing(false)
    }
  }

  return (
    <div className="content">
      <div className="settings">
        <h2>Settings</h2>
        <p className="hint">
          Everything is stored on this machine. Delta only reaches the network when you ask it to sync.
        </p>

        {/* -------------------------------------------------- appearance */}
        <h3>Appearance</h3>
        <div className="setting-row column">
          <div>
            <div className="label">Theme</div>
            <div className="desc">Nord and Ayu, in a light and a dark variant.</div>
          </div>
          <div className="theme-grid">
            {THEMES.map((theme) => (
              <button
                key={theme.id}
                type="button"
                className={`theme-card${state.theme === theme.id ? ' active' : ''}`}
                onClick={() => actions.setTheme(theme.id)}
              >
                <span className="swatches">
                  {theme.palette.map((color) => (
                    <span key={color} className="swatch" style={{ background: color }} />
                  ))}
                </span>
                <span className="theme-name">{theme.label}</span>
              </button>
            ))}
          </div>
        </div>

        <div className="setting-row">
          <div>
            <div className="label">Writing font</div>
            <div className="desc">Iosevka for notes and code, Noto Sans for the interface.</div>
          </div>
          <div className="seg">
            {(['iosevka', 'noto'] as ContentFont[]).map((font) => (
              <button
                key={font}
                type="button"
                className={state.contentFont === font ? 'active' : ''}
                onClick={() => actions.setContentFont(font)}
              >
                {font === 'iosevka' ? 'Iosevka' : 'Noto'}
              </button>
            ))}
          </div>
        </div>

        <div className="setting-row">
          <div>
            <div className="label">Note view</div>
            <div className="desc">
              How a note opens. Reading shows the finished note, Editing writes it as you read it,
              Source shows the raw Markdown, Split both.
            </div>
          </div>
          <div className="seg">
            {(['reading', 'editing', 'source', 'split'] as NoteViewMode[]).map((mode) => (
              <button
                key={mode}
                type="button"
                className={state.viewMode === mode ? 'active' : ''}
                onClick={() => actions.setViewMode(mode)}
              >
                {mode === 'reading'
                  ? 'Reading'
                  : mode === 'editing'
                    ? 'Editing'
                    : mode === 'source'
                      ? 'Source'
                      : 'Split'}
              </button>
            ))}
          </div>
        </div>

        {/* ------------------------------------------------------ voice */}
        <h3>Voice</h3>
        <div className="setting-row">
          <div>
            <div className="label">Speech engine</div>
            <div className="desc">
              {voiceStatus?.available
                ? `Piper is ready${voiceStatus.piperPath ? ` — ${voiceStatus.piperPath}` : ''}.`
                : (voiceStatus?.error ?? 'Checking for Piper…')}
            </div>
          </div>
          {voiceStatus?.available ? (
            <StatusPill tone="ok">Ready</StatusPill>
          ) : (
            <StatusPill tone="warn">Not set up</StatusPill>
          )}
        </div>

        <div className="setting-row">
          <div>
            <div className="label">Voice</div>
            <div className="desc">
              {voiceStatus && voiceStatus.voices.length > 0
                ? `${voiceStatus.voices.length} voice model${voiceStatus.voices.length === 1 ? '' : 's'} found.`
                : 'Download Piper voices into the folder below to enable read aloud.'}
            </div>
          </div>
          <select
            className="text-input"
            value={voice}
            onChange={(event) => saveVoice(event.target.value)}
          >
            <option value="">Choose a voice…</option>
            {(voiceStatus?.voices ?? []).map((item) => (
              <option key={item.path} value={item.path}>
                {item.name}
                {item.language ? ` (${item.language})` : ''}
              </option>
            ))}
          </select>
        </div>

        <div className="setting-row">
          <div>
            <div className="label">Speaking rate</div>
            <div className="desc">Lower is slower and clearer; higher is faster.</div>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <input
              type="range"
              min={0.6}
              max={1.6}
              step={0.05}
              value={rate}
              onChange={(event) => {
                const value = Number(event.target.value)
                setRate(value)
                saveSetting('ttsRate', String(value))
              }}
            />
            <span className="mono muted" style={{ width: 34, textAlign: 'right' }}>
              {rate.toFixed(2)}
            </span>
          </div>
        </div>

        <div className="setting-row">
          <div>
            <div className="label">Piper executable</div>
            <div className="desc">
              Leave empty to use the one found on your path. Setting it explicitly is useful when Piper
              lives somewhere unusual.
            </div>
          </div>
          <input
            className="text-input"
            placeholder="Auto-detected"
            value={piperPath}
            onChange={(event) => {
              setPiperPath(event.target.value)
              saveSetting('ttsPiperPath', event.target.value)
            }}
          />
        </div>

        <div className="setting-row">
          <div>
            <div className="label">Try it out</div>
            <div className="desc">Reads a short sample with the selected voice.</div>
          </div>
          <button
            type="button"
            className="btn"
            disabled={!voiceStatus?.available}
            onClick={() => void testVoice()}
          >
            Play sample
          </button>
        </div>

        {/* ------------------------------------------------------- sync */}
        <h3>Sync</h3>
        <p className="hint">
          Delta can keep the vault in a GitHub repository, so every device sees the same notes. The
          index and settings stay local; only your files travel.
        </p>

        <div className="setting-row">
          <div>
            <div className="label">GitHub token</div>
            <div className="desc">
              {hasToken
                ? 'A token is stored in the system key store.'
                : 'A personal access token with the `repo` scope. It is stored in the system key store.'}
            </div>
          </div>
          <div style={{ display: 'flex', gap: 6 }}>
            <input
              className="text-input"
              type="password"
              placeholder={hasToken ? '••••••••' : 'ghp_…'}
              value={token}
              onChange={(event) => setToken(event.target.value)}
            />
            <button type="button" className="btn" onClick={() => void saveToken()}>
              Save
            </button>
          </div>
        </div>

        <div className="setting-row">
          <div>
            <div className="label">Repository</div>
            <div className="desc">In the form <code>owner/name</code>.</div>
          </div>
          <div style={{ display: 'flex', gap: 6 }}>
            <input
              className="text-input"
              placeholder="owner/name"
              value={repo}
              onChange={(event) => {
                setRepo(event.target.value)
                saveSetting('syncRepo', event.target.value)
              }}
            />
            <button
              type="button"
              className="btn"
              disabled={!hasToken || syncing}
              onClick={() => void createRepo()}
              title="Create a private repository on GitHub"
            >
              Create
            </button>
          </div>
        </div>

        <div className="setting-row">
          <div>
            <div className="label">Branch</div>
            <div className="desc">The branch that is synced.</div>
          </div>
          <input
            className="text-input"
            value={branch}
            onChange={(event) => {
              setBranch(event.target.value)
              saveSetting('syncBranch', event.target.value)
            }}
          />
        </div>

        <div className="setting-row">
          <div>
            <div className="label">Git LFS</div>
            <div className="desc">
              {syncStatus?.lfsAvailable
                ? 'Images, audio and drawings are stored through Git LFS, which keeps large files out of the history.'
                : 'Install git-lfs to store large files through Git LFS.'}
            </div>
          </div>
          <label className="switch">
            <input
              type="checkbox"
              checked={useLfs}
              disabled={!syncStatus?.lfsAvailable}
              onChange={(event) => {
                setUseLfs(event.target.checked)
                saveSetting('syncLfs', event.target.checked ? '1' : '0')
              }}
            />
            <span className="slider" />
          </label>
        </div>

        <div className="setting-row">
          <div>
            <div className="label">Status</div>
            <div className="desc mono">
              {syncStatus?.lastCommit
                ? `Last commit: ${syncStatus.lastCommit}`
                : syncStatus?.isRepo
                  ? 'The vault is a git repository.'
                  : 'The vault is not linked to a repository yet.'}
              {syncStatus?.pendingChanges ? ' · uncommitted changes' : ''}
            </div>
          </div>
          <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
            {syncStatus?.gitAvailable ? (
              <StatusPill tone="ok">git ready</StatusPill>
            ) : (
              <StatusPill tone="off">git missing</StatusPill>
            )}
            {syncStatus?.lfsAvailable ? (
              <StatusPill tone="ok">lfs ready</StatusPill>
            ) : (
              <StatusPill tone="off">lfs missing</StatusPill>
            )}
          </div>
        </div>

        {syncStatus?.conflictFiles?.length ? (
          <div className="setting-row column">
            <div className="label" style={{ color: 'var(--warn, #ebcb8b)' }}>
              Needs your attention
            </div>
            <div className="desc">
              {syncStatus.conflictFiles.length === 1
                ? 'Another device changed '
                : 'Another device changed '}
              {syncStatus.conflictFiles.join(', ')} while you were offline. The conflict
              markers are in the note — keep the version you want, then sync again.
            </div>
          </div>
        ) : null}

        <div className="setting-row">
          <div>
            <div className="label">Sync now</div>
            <div className="desc">Pulls what changed elsewhere, then pushes what changed here.</div>
          </div>
          <div style={{ display: 'flex', gap: 6 }}>
            <button
              type="button"
              className="btn"
              disabled={!syncStatus?.isRepo || syncing}
              onClick={() => void setupSync()}
            >
              {syncStatus?.isRepo ? 'Update setup' : 'Set up'}
            </button>
            <button
              type="button"
              className="btn"
              disabled={!syncStatus?.isRepo || syncing}
              onClick={() => void runSync('pull')}
            >
              Pull
            </button>
            <button
              type="button"
              className="btn primary"
              disabled={!syncStatus?.isRepo || syncing}
              onClick={() => void runSync('sync')}
            >
              <IconSync /> {syncing ? 'Syncing…' : 'Sync'}
            </button>
          </div>
        </div>

        {/* ------------------------------------------------------ vault */}
        <h3>Vault</h3>
        <div className="setting-row">
          <div>
            <div className="label">Current vault</div>
            <div className="desc mono">{state.vault?.path ?? 'None'}</div>
          </div>
          <button type="button" className="btn" onClick={() => void actions.chooseVault()}>
            Open another…
          </button>
        </div>
        <div className="setting-row">
          <div>
            <div className="label">Time zone</div>
            <div className="desc">Events and due dates use this zone.</div>
          </div>
          <span className="mono muted">{localTimezone()}</span>
        </div>

        {/* --------------------------------------------------- calendar */}
        <h3>Calendar</h3>
        <div className="setting-row">
          <div>
            <div className="label">Import / export iCalendar</div>
            <div className="desc">
              Standard <code>.ics</code> files. Exported calendars are written to the vault root.
            </div>
          </div>
          <span style={{ display: 'flex', gap: 6 }}>
            <button type="button" className="btn" onClick={() => void importCalendar()}>
              Import…
            </button>
            <button type="button" className="btn" onClick={() => void exportCalendar()}>
              Export…
            </button>
          </span>
        </div>

        {/* ------------------------------------------- backup and recovery */}
        <h3>Backup and recovery</h3>
        <div className="setting-row">
          <div>
            <div className="label">Back up the vault</div>
            <div className="desc">
              Creates a zip containing notes, attachments, drawings and the local database.
            </div>
          </div>
          <button type="button" className="btn" onClick={() => void actions.createBackup()}>
            <IconBackup /> Back up…
          </button>
        </div>
        <div className="setting-row">
          <div>
            <div className="label">Restore a backup</div>
            <div className="desc">
              {backupDir
                ? `Backups found in ${backupDir}`
                : 'Choose the folder that holds your backup archives.'}
            </div>
          </div>
          <span style={{ display: 'flex', gap: 6 }}>
            <button type="button" className="btn" onClick={() => void loadBackups()}>
              Find backups
            </button>
            <button
              type="button"
              className="btn"
              onClick={() => {
                actions.refreshTree()
                actions.refreshNotes()
                actions.refreshTasks()
                actions.refreshEvents()
                actions.toast('success', 'Re-indexed the vault')
              }}
            >
              <IconRefresh /> Re-index
            </button>
          </span>
        </div>
        {backups.length > 0 && (
          <div style={{ marginTop: 8 }}>
            {backups.map((backup) => (
              <div className="setting-row" key={backup.path}>
                <div>
                  <div className="label mono">{backup.name}</div>
                  <div className="desc">{api.humanSize(backup.size)}</div>
                </div>
                <button
                  type="button"
                  className="btn"
                  onClick={() => void actions.restoreBackup(backup.path)}
                >
                  Restore…
                </button>
              </div>
            ))}
          </div>
        )}

        {/* ------------------------------------------------------- about */}
        <h3>About</h3>
        <div className="setting-row">
          <div>
            <div className="label">Delta</div>
            <div className="desc">
              Rust core {coreVersion} · local-first knowledge base
            </div>
          </div>
          <button type="button" className="btn" onClick={() => actions.setModal({ kind: 'about' })}>
            Details
          </button>
        </div>
      </div>
    </div>
  )
}
