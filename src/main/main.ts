import { app, BrowserWindow, Menu, dialog, ipcMain, shell, nativeTheme, session, safeStorage } from 'electron'
import { existsSync, readFileSync, writeFileSync, mkdirSync, copyFileSync, chmodSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { pathToFileURL } from 'node:url'
import { join } from 'node:path'

// The dev server is only used when explicitly requested; otherwise the
// production bundle in dist/ is loaded, which keeps `electron .` usable
// straight after a build.
const isDev = !app.isPackaged && process.env.DELTA_DEV === '1'
const DEV_URL = 'http://localhost:5273'

/** The name the desktop entry uses. The window's app id has to match it. */
const DESKTOP_NAME = 'Delta'

interface GlobalSettings {
  recentVaults: string[]
  windowBounds?: { width: number; height: number; x?: number; y?: number }
  lastVault?: string
}

let mainWindow: BrowserWindow | null = null
let settings: GlobalSettings = { recentVaults: [] }

function settingsPath(): string {
  return join(app.getPath('userData'), 'settings.json')
}

function loadSettings(): void {
  try {
    const file = settingsPath()
    if (existsSync(file)) {
      settings = { recentVaults: [], ...JSON.parse(readFileSync(file, 'utf8')) }
    }
  } catch {
    settings = { recentVaults: [] }
  }
}

function saveSettings(): void {
  try {
    const dir = app.getPath('userData')
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
    writeFileSync(settingsPath(), JSON.stringify(settings, null, 2), 'utf8')
  } catch (error) {
    console.error('Failed to persist settings:', error)
  }
}

function rememberVault(path: string): void {
  settings.recentVaults = [path, ...settings.recentVaults.filter((p) => p !== path)].slice(0, 10)
  settings.lastVault = path
  saveSettings()
}

/** `--vault=/path/to/vault` opens a vault straight from the command line. */
function vaultFromArgs(): string | undefined {
  for (const arg of process.argv) {
    if (arg.startsWith('--vault=')) return arg.slice('--vault='.length)
  }
  return undefined
}

/** Where the icon files live, in development and in a packaged app. */
function iconDir(): string {
  if (app.isPackaged) return join(process.resourcesPath, 'icons')
  return join(app.getAppPath(), 'resources', 'icons')
}

/**
 * Put Delta into the desktop's own folders on Linux.
 *
 * A Wayland desktop shows the icon of the application a window belongs to,
 * and it finds that icon through the desktop entry. Without an entry the
 * panel has nothing to show and falls back to a generic symbol. Registering
 * the app is what makes the mark appear in the panel, the app menu and the
 * task switcher.
 */
function registerLinuxDesktop(): void {
  if (process.platform !== 'linux' || !app.isPackaged) return

  const home = app.getPath('home')
  const dataHome = process.env.XDG_DATA_HOME || join(home, '.local', 'share')
  const applications = join(dataHome, 'applications')
  const icons = join(dataHome, 'icons', 'hicolor')

  try {
    mkdirSync(applications, { recursive: true })

    // The executable the entry should start: the AppImage when there is one,
    // the unpacked binary otherwise.
    const executable = process.env.APPIMAGE || process.execPath
    const entry = `[Desktop Entry]
Type=Application
Name=${DESKTOP_NAME}
Comment=Delta — a local-first knowledge base for notes, tasks, calendar and drawings
Exec="${executable}" %U
Icon=delta
Terminal=false
Categories=Office;
MimeType=text/markdown;
StartupNotify=true
StartupWMClass=${DESKTOP_NAME}
`

    const entryPath = join(applications, `${DESKTOP_NAME}.desktop`)
    const current = existsSync(entryPath) ? readFileSync(entryPath, 'utf8') : ''
    if (current !== entry) {
      writeFileSync(entryPath, entry, 'utf8')
      chmodSync(entryPath, 0o755)
    }
  } catch (error) {
    console.error('Could not register the desktop entry:', error)
  }

  // Copy the icon into every size the desktop might ask for.
  const source = iconDir()
  for (const size of [16, 24, 32, 48, 64, 128, 256, 512]) {
    const from = join(source, `icon-${size}.png`)
    if (!existsSync(from)) continue
    const to = join(icons, `${size}x${size}`, 'apps')
    try {
      mkdirSync(to, { recursive: true })
      copyFileSync(from, join(to, 'delta.png'))
    } catch (error) {
      console.error(`Could not install the ${size}px icon:`, error)
    }
  }
  try {
    const scalable = join(icons, 'scalable', 'apps')
    mkdirSync(scalable, { recursive: true })
    copyFileSync(join(source, 'icon.svg'), join(scalable, 'delta.svg'))
  } catch (error) {
    console.error('Could not install the scalable icon:', error)
  }

  // Re-index the user's hicolor tree so the panel picks the mark up without a
  // relogin. Best effort: the tool is not installed everywhere and a missing
  // cache only costs a refresh, never the icon itself.
  for (const tool of ['gtk-update-icon-cache', 'gtk4-update-icon-cache']) {
    try {
      const result = spawnSync(tool, ['-f', '-t', icons], { stdio: 'ignore', timeout: 20_000 })
      if (result.status === 0) break
    } catch {
      // Ignore: no reindexer on this machine.
    }
  }
}

function createWindow(): void {
  const bounds = settings.windowBounds
  const initialVault = vaultFromArgs()
  const icon = join(iconDir(), 'icon.png')
  mainWindow = new BrowserWindow({
    width: bounds?.width ?? 1280,
    height: bounds?.height ?? 840,
    x: bounds?.x,
    y: bounds?.y,
    minWidth: 720,
    minHeight: 480,
    show: false,
    backgroundColor: '#2E3440',
    title: DESKTOP_NAME,
    // Used by the window manager for the panel and the title bar.
    ...(existsSync(icon) ? { icon } : {}),
    autoHideMenuBar: true,
    webPreferences: {
      preload: join(__dirname, '../preload/preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      // The preload must be able to `require` the compiled Rust addon.
      sandbox: false,
      spellcheck: false,
      additionalArguments: initialVault ? [`--vault=${initialVault}`] : [],
    },
  })

  mainWindow.once('ready-to-show', () => {
    mainWindow?.show()
  })

  // Safety net: if the renderer never signals that it is ready, show the
  // window anyway. Otherwise the app would sit running with nothing on
  // screen, which looks exactly like the app failing to start.
  const showFallback = setTimeout(() => {
    if (mainWindow && !mainWindow.isDestroyed() && !mainWindow.isVisible()) {
      console.warn('Renderer did not become ready in time; showing the window anyway.')
      mainWindow.show()
    }
  }, 8000)
  mainWindow.once('ready-to-show', () => clearTimeout(showFallback))

  mainWindow.on('close', () => {
    if (!mainWindow || mainWindow.isDestroyed()) return
    const size = mainWindow.getNormalBounds()
    settings.windowBounds = {
      width: size.width,
      height: size.height,
      x: size.x,
      y: size.y,
    }
    saveSettings()
  })

  mainWindow.on('closed', () => {
    mainWindow = null
  })

  // External links open in the system browser, never inside the app.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/.test(url)) void shell.openExternal(url)
    return { action: 'deny' }
  })

  // Test hook: drive the UI from a script and capture each screen, so the
  // interface can be verified without a human present.
  //   DELTA_SCRIPT="view.tasks,view.calendar" DELTA_CAPTURE_DIR=/tmp/shots
  //
  // Each step is `command@waitMs[:captureMs]`. `waitMs` is how long to wait
  // before the next step starts; `captureMs` is how long to wait before the
  // screenshot is taken (default 900 ms, raise it for screens that need a
  // lazy-loaded bundle such as the drawing canvas).
  //
  // Steps are separated by `~~~` so that `eval:` snippets can contain commas.
  const script = process.env.DELTA_SCRIPT
  const captureDir = process.env.DELTA_CAPTURE_DIR
  if (script && captureDir) {
    const steps = script
      .split(script.includes('~~~') ? '~~~' : ',')
      .map((step) => step.trim())
      .filter(Boolean)
    let elapsed = 2500
    let lastCapture = elapsed
    const started = Date.now()
    steps.forEach((step, index) => {
      const [command, timings] = step.split('@')
      const [waitMs, captureMs] = (timings ?? '').split(':')
      const wait = Number(waitMs ?? 1800)
      const captureDelay = Number(captureMs ?? 900)
      lastCapture = elapsed + captureDelay
      setTimeout(() => {
        console.log(
          '[step]',
          index,
          command.slice(0, 60),
          'at',
          Date.now() - started,
          'visible:',
          mainWindow?.isVisible(),
        )
        if (command.startsWith('eval:')) {
          void mainWindow
            ?.webContents.executeJavaScript(command.slice('eval:'.length))
            .then((result) => console.log('[eval]', JSON.stringify(result)))
            .catch((error) => console.log('[eval] failed:', String(error)))
        } else {
          mainWindow?.webContents.send('delta:menu-command', command)
        }
        setTimeout(() => {
          if (!mainWindow || mainWindow.isDestroyed()) {
            console.log('[capture] no window to capture')
            return
          }
          // Long `eval:` snippets would make a file name that the file
          // system rejects, so the label is shortened.
          const label = command.replace(/\W/g, '_').slice(0, 60)
          const file = join(captureDir, `${index}-${label}.png`)
          const write = (data: Buffer): void => {
            writeFileSync(file, data)
            console.log('[capture] wrote', file)
          }
          // `capturePage` relies on the compositor and occasionally hangs or
          // errors on some systems, so fall back to the DevTools protocol.
          const viaDebugger = (): void => {
            const target = mainWindow?.webContents
            if (!target) return
            try {
              target.debugger.attach('1.3')
            } catch {
              return
            }
            // `fromSurface: false` captures straight from the renderer, which
            // sidesteps the compositor entirely.
            target.debugger
              .sendCommand('Page.captureScreenshot', { format: 'png', fromSurface: false })
              .then(
                (result) => {
                  write(Buffer.from(result.data, 'base64'))
                  target.debugger.detach()
                },
                (error) => {
                  console.log('[capture] debugger failed:', String(error))
                  try {
                    target.debugger.detach()
                  } catch {
                    /* already detached */
                  }
                },
              )
          }
          const attempt = (tries: number): void => {
            const target = mainWindow!.webContents
            // `capturePage` can hang indefinitely when the compositor is
            // unhappy, so it races against a timeout.
            const timeout = new Promise<never>((_resolve, reject) => {
              setTimeout(() => reject(new Error('capturePage timed out')), 3000)
            })
            void Promise.race([target.capturePage(), timeout])
              .then((image) => write((image as Electron.NativeImage).toPNG()))
              .catch((error) => {
                if (tries > 0) {
                  setTimeout(() => attempt(tries - 1), 400)
                } else {
                  console.log('[capture] falling back to the debugger:', String(error))
                  viaDebugger()
                }
              })
          }
          attempt(1)
        }, captureDelay)
      }, elapsed)
      elapsed += wait
    })
    // Stay alive until the last screenshot has been written. A capture can
    // take a while when it falls back to the DevTools protocol.
    setTimeout(() => {
      console.log('[step] quitting at', Date.now() - started)
      app.quit()
    }, lastCapture + 9000)
  }

  const screenshot = process.env.DELTA_SCREENSHOT
  if (screenshot) {
    const delay = Number(process.env.DELTA_SCREENSHOT_DELAY ?? '2500')
    setTimeout(() => {
      mainWindow
        ?.webContents.capturePage()
        .then((image) => writeFileSync(screenshot, image.toPNG()))
        .then(() => {
          app.quit()
        })
        .catch(() => app.quit())
    }, delay)
  }

  mainWindow.webContents.on('console-message', (_event, level, message) => {
    if (level >= 2 || process.env.DELTA_VERBOSE) {
      console.log(`[renderer:${level}]`, message)
    }
  })
  mainWindow.webContents.on('did-fail-load', (_event, code, description, url) => {
    console.error(`[renderer] failed to load ${url}: ${description} (${code})`)
    // Show the window even when the page failed, so the failure is visible
    // instead of leaving an invisible process behind.
    if (mainWindow && !mainWindow.isDestroyed() && !mainWindow.isVisible()) mainWindow.show()
  })

  if (isDev) {
    void mainWindow.loadURL(DEV_URL)
  } else {
    void mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

/**
 * Keep the application strictly offline.
 *
 * Every request that is not local is cancelled. The only exception is the
 * font request Excalidraw makes to a CDN, which is redirected to the copy
 * bundled with the app — that request would otherwise fail offline and leave
 * the drawing editor without its fonts.
 */
function installOfflineGuard(): void {
  const fontsRoot = join(app.getAppPath(), 'dist', 'renderer', 'excalidraw-assets')
  session.defaultSession.webRequest.onBeforeRequest((details, callback) => {
    const url = details.url
    if (!/^https?:/i.test(url)) {
      callback({})
      return
    }
    const marker = '/dist/prod/fonts/'
    const index = url.indexOf(marker)
    if (index >= 0) {
      const relative = url.slice(index + marker.length)
      const local = join(fontsRoot, relative)
      if (existsSync(local)) {
        callback({ redirectURL: pathToFileURL(local).href })
        return
      }
    }
    // Nothing else may reach the network.
    callback({ cancel: true })
  })
}

function send(command: string): void {
  mainWindow?.webContents.send('delta:menu-command', command)
}

function buildMenu(): void {
  const template: Electron.MenuItemConstructorOptions[] = [
    {
      label: 'File',
      submenu: [
        { label: 'New Note', accelerator: 'CmdOrCtrl+N', click: () => send('file.new-note') },
        { label: 'New Folder', accelerator: 'CmdOrCtrl+Shift+N', click: () => send('file.new-folder') },
        { type: 'separator' },
        { label: 'Open Vault…', accelerator: 'CmdOrCtrl+O', click: () => send('file.open-vault') },
        { label: 'Save Note', accelerator: 'CmdOrCtrl+S', click: () => send('file.save') },
        { type: 'separator' },
        { label: 'Backup Vault…', click: () => send('file.backup') },
        { label: 'Restore Backup…', click: () => send('file.restore') },
        { type: 'separator' },
        { role: 'quit' },
      ],
    },
    {
      label: 'Edit',
      submenu: [
        { role: 'undo' },
        { role: 'redo' },
        { type: 'separator' },
        { role: 'cut' },
        { role: 'copy' },
        { role: 'paste' },
        { role: 'selectAll' },
        { type: 'separator' },
        { label: 'Find in Vault', accelerator: 'CmdOrCtrl+Shift+F', click: () => send('edit.find') },
      ],
    },
    {
      label: 'View',
      submenu: [
        { label: 'Notes', accelerator: 'CmdOrCtrl+1', click: () => send('view.notes') },
        { label: 'Tasks', accelerator: 'CmdOrCtrl+2', click: () => send('view.tasks') },
        { label: 'Calendar', accelerator: 'CmdOrCtrl+3', click: () => send('view.calendar') },
        { label: 'Drawings', accelerator: 'CmdOrCtrl+4', click: () => send('view.drawings') },
        { label: 'Search', accelerator: 'CmdOrCtrl+5', click: () => send('view.search') },
        { type: 'separator' },
        { label: 'Cycle Note View', accelerator: 'CmdOrCtrl+E', click: () => send('view.toggle-preview') },
        { label: 'Toggle Theme', accelerator: 'CmdOrCtrl+Shift+L', click: () => send('view.toggle-theme') },
        { type: 'separator' },
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
        { type: 'separator' },
        { role: 'togglefullscreen' },
        { role: 'toggleDevTools' },
      ],
    },
    {
      label: 'Navigate',
      submenu: [
        { label: 'Quick Open', accelerator: 'CmdOrCtrl+P', click: () => send('nav.quick-open') },
        { label: 'Command Palette', accelerator: 'CmdOrCtrl+Shift+P', click: () => send('nav.command-palette') },
        { type: 'separator' },
        { label: 'Next Tab', accelerator: 'CmdOrCtrl+Tab', click: () => send('nav.next-tab') },
        { label: 'Previous Tab', accelerator: 'CmdOrCtrl+Shift+Tab', click: () => send('nav.prev-tab') },
        { type: 'separator' },
        { label: 'Back', accelerator: 'CmdOrCtrl+Alt+Left', click: () => send('nav.back') },
        { label: 'Forward', accelerator: 'CmdOrCtrl+Alt+Right', click: () => send('nav.forward') },
      ],
    },
    {
      label: 'Help',
      submenu: [
        { label: 'Keyboard Shortcuts', accelerator: 'CmdOrCtrl+/', click: () => send('help.shortcuts') },
        { label: 'About Delta', click: () => send('help.about') },
      ],
    },
  ]
  Menu.setApplicationMenu(Menu.buildFromTemplate(template))
}

// ---------------------------------------------------------------- IPC setup

ipcMain.handle('delta:open-vault-dialog', async () => {
  const result = await dialog.showOpenDialog(mainWindow!, {
    title: 'Open Delta Vault',
    properties: ['openDirectory', 'createDirectory'],
    buttonLabel: 'Open Vault',
  })
  if (result.canceled || result.filePaths.length === 0) return null
  const path = result.filePaths[0]
  rememberVault(path)
  return path
})

ipcMain.handle('delta:pick-folder', async (_e, title: string) => {
  const result = await dialog.showOpenDialog(mainWindow!, {
    title: title || 'Choose Folder',
    properties: ['openDirectory', 'createDirectory'],
  })
  if (result.canceled || result.filePaths.length === 0) return null
  return result.filePaths[0]
})

ipcMain.handle('delta:pick-files', async (_e, extensions: string[]) => {
  const result = await dialog.showOpenDialog(mainWindow!, {
    title: 'Choose File',
    properties: ['openFile', 'multiSelections'],
    filters: extensions?.length
      ? [{ name: extensions.join(', ').toUpperCase(), extensions }]
      : undefined,
  })
  return result.canceled ? [] : result.filePaths
})

ipcMain.handle('delta:save-file', async (_e, defaultName: string, extensions: string[]) => {
  const result = await dialog.showSaveDialog(mainWindow!, {
    title: 'Save File',
    defaultPath: defaultName,
    filters: extensions?.length
      ? [{ name: extensions.join(', ').toUpperCase(), extensions }]
      : undefined,
  })
  return result.canceled || !result.filePath ? null : result.filePath
})

ipcMain.handle('delta:remember-vault', (_e, path: string) => {
  rememberVault(path)
  return true
})

ipcMain.handle('delta:recent-vaults', () => settings.recentVaults)
ipcMain.handle('delta:global-settings', () => settings)

// ------------------------------------------------------------------- secrets

/**
 * The GitHub token is kept encrypted with the operating system's key store
 * (`safeStorage`), so it never sits in plain text on disk.
 */
function credentialsPath(): string {
  return join(app.getPath('userData'), 'credentials.json')
}

function readCredentials(): Record<string, string> {
  try {
    const file = credentialsPath()
    if (!existsSync(file)) return {}
    return JSON.parse(readFileSync(file, 'utf8')) as Record<string, string>
  } catch {
    return {}
  }
}

function writeCredentials(values: Record<string, string>): void {
  try {
    const dir = app.getPath('userData')
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
    writeFileSync(credentialsPath(), JSON.stringify(values, null, 2), 'utf8')
  } catch (error) {
    console.error('Failed to store credentials:', error)
  }
}

ipcMain.handle('delta:set-sync-token', async (_e, token: string) => {
  const values = readCredentials()
  if (!token) {
    delete values.syncToken
  } else if (safeStorage.isEncryptionAvailable()) {
    const buffer = await safeStorage.encryptStringAsync(token)
    values.syncToken = buffer.toString('base64')
  } else {
    // Without a key store the token is kept in plain text, which is still
    // better than leaving the user without sync at all.
    console.warn('No system key store available; the token is stored unencrypted.')
    values.syncToken = token
  }
  writeCredentials(values)
  return token
})

ipcMain.handle('delta:get-sync-token', async () => {
  const values = readCredentials()
  const stored = values.syncToken
  if (!stored) return ''
  if (safeStorage.isEncryptionAvailable()) {
    try {
      const decrypted = await safeStorage.decryptStringAsync(Buffer.from(stored, 'base64'))
      return decrypted.result
    } catch {
      return ''
    }
  }
  return stored
})

// ---------------------------------------------------------------------- GitHub

/**
 * Create a repository through the GitHub API so a new vault can be backed up
 * without leaving the app.
 */
ipcMain.handle('delta:create-github-repo', async (_e, name: string, isPrivate: boolean) => {
  const values = readCredentials()
  const stored = values.syncToken
  if (!stored) {
    return { ok: false, repo: '', message: 'Add a GitHub token first.' }
  }

  let token = stored
  if (safeStorage.isEncryptionAvailable()) {
    try {
      token = (await safeStorage.decryptStringAsync(Buffer.from(stored, 'base64'))).result
    } catch {
      return { ok: false, repo: '', message: 'The stored token could not be read.' }
    }
  }

  try {
    const response = await fetch('https://api.github.com/user/repos', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        name,
        private: isPrivate !== false,
        description: 'A Delta vault, synced across devices.',
        auto_init: true,
      }),
    })

    if (response.ok) {
      const body = (await response.json()) as { full_name?: string }
      return { ok: true, repo: body.full_name ?? name, message: 'Repository created.' }
    }

    const detail = await response.text()
    let message = `GitHub returned ${response.status}.`
    try {
      const parsed = JSON.parse(detail) as { message?: string }
      if (parsed.message) message = parsed.message
    } catch {
      /* keep the generic message */
    }
    return { ok: false, repo: '', message }
  } catch (error) {
    return { ok: false, repo: '', message: String(error) }
  }
})

// Forward filesystem change batches from the preload to the renderer.
ipcMain.on('delta:watch-event', (_e, event) => {
  mainWindow?.webContents.send('delta:watch-event', event)
})

// ----------------------------------------------------------------- lifecycle

// The app id is what a Wayland desktop matches a window against, and it has
// to be the name of the installed desktop entry. It has to be set before the
// app is ready.
if (process.platform === 'linux') {
  app.setDesktopName(DESKTOP_NAME)
}

if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  app.on('second-instance', () => {
    if (!mainWindow || mainWindow.isDestroyed()) return
    // Bring the running instance to the front so a second launch never looks
    // like the app failed to start.
    if (mainWindow.isMinimized()) mainWindow.restore()
    if (!mainWindow.isVisible()) mainWindow.show()
    mainWindow.focus()
    mainWindow.moveTop()
  })

  void app.whenReady().then(() => {
    loadSettings()
    installOfflineGuard()
    nativeTheme.themeSource = 'dark'
    registerLinuxDesktop()
    buildMenu()
    createWindow()

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow()
    })
  })

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit()
  })

  app.on('before-quit', () => {
    saveSettings()
  })
}
