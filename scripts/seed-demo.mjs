/** Populate a vault with tasks and events so every view has something to show. */
import { createRequire } from 'node:module'
const require = createRequire(import.meta.url)
const core = require('../native/index.js')

const vaultPath = process.argv[2]
if (!vaultPath) {
  console.error('usage: node scripts/seed-demo.mjs <vault-path>')
  process.exit(1)
}

/**
 * A small Excalidraw scene, so the drawing view has something to open.
 *
 * The colours are Nord accents that read well on the dark canvas: light
 * strokes, a slightly raised fill, and near-white text.
 */
function demoDrawing() {
  const box = (id, x, y, width, height, label, strokeColor, backgroundColor) => ({
    id,
    type: 'rectangle',
    x,
    y,
    width,
    height,
    angle: 0,
    strokeColor,
    backgroundColor,
    fillStyle: 'solid',
    strokeWidth: 2,
    strokeStyle: 'solid',
    roughness: 0,
    opacity: 100,
    groupIds: [],
    frameId: null,
    index: 'a0',
    roundness: null,
    seed: 1,
    version: 1,
    versionNonce: 1,
    isDeleted: false,
    boundElements: [],
    updated: 1,
    link: null,
    locked: false,
  })

  const text = (id, x, y, label, index) => ({
    id,
    type: 'text',
    x,
    y,
    width: 92,
    height: 25,
    angle: 0,
    strokeColor: '#eceff4',
    backgroundColor: 'transparent',
    fillStyle: 'solid',
    strokeWidth: 2,
    strokeStyle: 'solid',
    roughness: 0,
    opacity: 100,
    groupIds: [],
    frameId: null,
    index,
    roundness: null,
    seed: 2,
    version: 1,
    versionNonce: 2,
    isDeleted: false,
    boundElements: [],
    updated: 1,
    link: null,
    locked: false,
    text: label,
    fontSize: 20,
    fontFamily: 5,
    textAlign: 'center',
    verticalAlign: 'middle',
    containerId: null,
    originalText: label,
    autoResize: true,
    lineHeight: 1.25,
  })

  const arrow = (id, x, y, width, height) => ({
    id,
    type: 'arrow',
    x,
    y,
    width,
    height,
    angle: 0,
    strokeColor: '#d08770',
    backgroundColor: 'transparent',
    fillStyle: 'solid',
    strokeWidth: 2,
    strokeStyle: 'solid',
    roughness: 0,
    opacity: 100,
    groupIds: [],
    frameId: null,
    index: 'a4',
    roundness: { type: 2 },
    seed: 3,
    version: 1,
    versionNonce: 3,
    isDeleted: false,
    boundElements: [],
    updated: 1,
    link: null,
    locked: false,
    points: [
      [0, 0],
      [width, height],
    ],
    lastCommittedPoint: null,
    startBinding: null,
    endBinding: null,
    startArrowhead: null,
    endArrowhead: 'arrow',
    elbowed: false,
  })

  return {
    type: 'excalidraw',
    version: 2,
    source: 'delta',
    elements: [
      box('renderer-box', 60, 80, 180, 90, 'Renderer', '#88c0d0', '#3b4252'),
      box('vault-box', 340, 80, 180, 90, 'Vault', '#a3be8c', '#3b4252'),
      text('renderer-label', 104, 112, 'Renderer', 'a2'),
      text('vault-label', 398, 112, 'Vault', 'a3'),
      arrow('renderer-to-vault', 240, 125, 100, 0),
    ],
    appState: {
      gridSize: null,
      viewBackgroundColor: '#2e3440',
      theme: 'dark',
    },
    files: {},
  }
}

const vault = new core.Vault(vaultPath)

// Start from a clean slate so repeated runs do not pile up duplicates.
for (const task of vault.listTasks()) vault.deleteTask(task.id)
for (const event of vault.listEvents()) vault.deleteEvent(event.id)
const now = new Date()
const iso = (offsetDays) => {
  const d = new Date(now.getFullYear(), now.getMonth(), now.getDate() + offsetDays)
  return d.toISOString().slice(0, 10)
}
const at = (dayOffset, hour, minutes = 0) =>
  new Date(now.getFullYear(), now.getMonth(), now.getDate() + dayOffset, hour, minutes).getTime()

const tasks = [
  { title: 'Finish the release checklist', status: 'todo', priority: 'urgent', dueDate: iso(0), startTime: '09:00', durationMinutes: 90 },
  { title: 'Review the architecture notes', status: 'doing', priority: 'high', dueDate: iso(0) },
  { title: 'Write release notes', status: 'todo', priority: 'medium', dueDate: iso(2), startTime: '14:00' },
  { title: 'Tag the build', status: 'todo', priority: 'low', dueDate: iso(9) },
  { title: 'Overdue: update the budget', status: 'todo', priority: 'high', dueDate: iso(-3) },
  { title: 'Morning standup', status: 'done', priority: 'none', dueDate: iso(-1), completedAt: Date.now() },
]

for (const task of tasks) {
  vault.saveTask({
    id: '',
    title: task.title,
    description: '',
    status: task.status,
    priority: task.priority,
    timezone: 'local',
    createdAt: 0,
    updatedAt: 0,
    ...(task.dueDate ? { dueDate: task.dueDate } : {}),
    ...(task.startTime ? { startTime: task.startTime } : {}),
    ...(task.durationMinutes ? { durationMinutes: task.durationMinutes } : {}),
    ...(task.completedAt ? { completedAt: task.completedAt } : {}),
  })
}

const events = [
  { title: 'Design review', day: 0, hour: 11, length: 60, location: 'Room 2', rrule: 'FREQ=WEEKLY;COUNT=6' },
  { title: 'Standup', day: 1, hour: 9, length: 15 },
  { title: 'Sprint planning', day: 3, hour: 13, length: 120 },
  { title: 'Release day', day: 7, allDay: true, length: 0 },
]

for (const event of events) {
  const start = event.allDay ? at(event.day, 0) : at(event.day, event.hour)
  vault.saveEvent({
    id: '',
    title: event.title,
    description: '',
    startUtc: start,
    endUtc: start + Math.max(1, event.length || 24 * 60) * 60000,
    allDay: Boolean(event.allDay),
    timezone: 'local',
    exdates: [],
    createdAt: 0,
    updatedAt: 0,
    ...(event.location ? { location: event.location } : {}),
    ...(event.rrule ? { rrule: event.rrule } : {}),
  })
}

console.log(`seeded ${tasks.length} tasks and ${events.length} events into ${vaultPath}`)

// Start from a known look so repeated runs are comparable.
vault.setSetting('theme', 'nord-dark')
vault.setSetting('contentFont', 'iosevka')

const drawingPath = vault.drawingPath('drawings/Architecture')
vault.writeFile(drawingPath, `${JSON.stringify(demoDrawing(), null, 2)}\n`)
console.log(`seeded drawing ${drawingPath}`)

const welcome = `# Welcome to Delta

Delta keeps **Markdown notes**, tasks, a calendar and drawings in one place, on
your own disk. Everything here is a plain file you can read anywhere.

## Try it out

- [x] Open a note and press **Read aloud** to hear it
- [ ] Drag a task onto the calendar
- [ ] Draw something in the **Drawings** view
- [ ] Turn on [[Drawings]] sync in Settings to keep the vault in step

> Notes stay ordinary \`.md\` files. Nothing is locked away.
`
vault.writeFile('Welcome.md', welcome)
console.log('seeded note Welcome.md')

/**
 * A handful of notes that link to one another, so the knowledge graph at the
 * bottom of the sidebar has something real to draw.
 */
const linkedNotes = {
  'Delta.md': `# Delta

Delta is a local-first knowledge base. Your notes stay ordinary Markdown
files, and everything else — tasks, events, drawings — lives beside them.

Start with [[Welcome]], then read about the [[Rust core]] and the
[[Electron shell]].

## The parts

- [[Rust core]] — vault access, SQLite, sync
- [[Electron shell]] — the window and the interface
- [[Piper]] — read the notes aloud
- [[Git sync]] — keep two machines in step
`,
  'Rust core.md': `# Rust core

The Rust addon owns everything that touches the disk: reading and writing
notes, the SQLite index, the file watcher and [[Git sync]].

It is exposed to the interface through a small bridge, which the
[[Electron shell]] loads at start-up.

See also [[Delta]].
`,
  'Electron shell.md': `# Electron shell

The window is an Electron application. It draws the interface with React and
talks to the [[Rust core]] through a preload bridge.

The shell itself knows nothing about the vault format — that is the
[[Rust core]]'s job.

See also [[Delta]] and [[Piper]].
`,
  'Piper.md': `# Piper

Piper reads a note aloud. The text is cleaned of Markdown first, so what you
hear is prose rather than punctuation.

The voice runs on your own machine, so nothing is sent anywhere. The
[[Electron shell]] plays the generated audio.

See also [[Delta]].
`,
  'Git sync.md': `# Git sync

Two vaults on two machines can be kept in step with Git. The [[Rust core]]
commits, merges and pushes; a conflict is left open in the note so you can
resolve it yourself.

Large files are handled by Git LFS, which has to be installed separately.

See also [[Delta]] and [[Rust core]].
`,
}

for (const [name, body] of Object.entries(linkedNotes)) {
  vault.writeFile(name, body)
}
console.log(`seeded ${Object.keys(linkedNotes).length} linked notes`)

// One link that points at a note nobody has written yet — the graph draws it
// as an empty ring.
vault.writeFile(
  'Ideas.md',
  `# Ideas

Things worth writing down later.

- [ ] Write about [[Local first software]]
- [ ] Fold this into [[Delta]]
`,
)
console.log('seeded note Ideas.md')
