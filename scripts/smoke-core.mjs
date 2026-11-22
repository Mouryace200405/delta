/**
 * End-to-end smoke test for the Rust core, exercised through the same JS
 * surface the renderer uses. Run with: node scripts/smoke-core.mjs
 */
import { createRequire } from 'node:module'
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, existsSync, readFileSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const require = createRequire(import.meta.url)
const core = require('../native/index.js')

let passed = 0
let failed = 0

function check(name, condition, detail) {
  if (condition) {
    passed++
    console.log(`  ok  ${name}`)
  } else {
    failed++
    console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`)
  }
}

function section(title) {
  console.log(`\n${title}`)
}

const workDir = mkdtempSync(join(tmpdir(), 'delta-smoke-'))
const vaultDir = join(workDir, 'vault')
mkdirSync(vaultDir, { recursive: true })

try {
  section('vault lifecycle')
  const vault = new core.Vault(vaultDir)
  const info = vault.info()
  check('vault opens', typeof info.path === 'string' && info.path.length > 0)
  check('vault reports a name', info.name.length > 0)
  check('schema version present', info.schemaVersion >= 1)

  section('notes')
  vault.createFolder('Daily')
  vault.createFolder('Projects/Alpha')
  check('folder created', existsSync(join(vaultDir, 'Projects/Alpha')))

  vault.createFile('Projects/Alpha/Plan.md', '# Alpha Plan\n\nKick off #alpha work.\n')
  check('note written', readFileSync(join(vaultDir, 'Projects/Alpha/Plan.md'), 'utf8').includes('Alpha Plan'))

  const stamp = vault.writeFile('Projects/Alpha/Plan.md', '# Alpha Plan\n\nKick off #alpha work.\n\nSee [[Ideas]] and [Budget](Budget.md)\n')
  check('write returns a hash', typeof stamp.hash === 'string' && stamp.hash.length > 0)

  const indexed = vault.indexNote('Projects/Alpha/Plan.md')
  check('title extracted from heading', indexed.title === 'Alpha Plan', `got "${indexed.title}"`)
  check('tag extracted', indexed.tags.includes('alpha'), JSON.stringify(indexed.tags))
  check('excerpt produced', indexed.excerpt.length > 0)

  section('links and backlinks')
  vault.createFile('Ideas.md', '# Ideas\n\nRelated to [[Plan]].\n')
  const back = vault.backlinks('Projects/Alpha/Plan.md')
  check('backlink found by name', back.length >= 1, JSON.stringify(back))

  section('search')
  const hits = vault.searchNotes('alpha', 20)
  check('search returns real hits', hits.length > 0)
  check('search hit references a real path', hits.some(h => h.path === 'Projects/Alpha/Plan.md'))

  section('tasks')
  // napi requires optional fields to be omitted rather than set to null.
  const task = vault.saveTask({
    id: '',
    title: 'Write the release notes',
    description: 'Cover the new features',
    status: 'todo',
    priority: 'high',
    dueDate: '2026-10-26',
    startTime: '09:00',
    durationMinutes: 60,
    timezone: 'local',
    createdAt: 0,
    updatedAt: 0,
  })
  check('task created with an id', task.id.length > 0)
  check('task persisted', vault.listTasks().length === 1)
  const done = vault.saveTask({ ...task, status: 'done' })
  check('task completion stamped', done.completedAt > 0)

  section('events')
  const event = vault.saveEvent({
    id: '',
    title: 'Design review',
    description: '',
    startUtc: Date.UTC(2026, 9, 26, 9, 0),
    endUtc: Date.UTC(2026, 9, 26, 10, 0),
    allDay: false,
    timezone: 'utc',
    rrule: 'FREQ=WEEKLY;COUNT=4',
    exdates: [],
    location: 'Room 2',
    createdAt: 0,
    updatedAt: 0,
  })
  check('event created', event.id.length > 0)
  check('event persisted', vault.listEvents().length === 1)

  section('calendar import / export')
  const ics = core.exportCalendar(vault.listEvents(), 'Delta')
  check('ics produced', ics.includes('BEGIN:VCALENDAR') && ics.includes('SUMMARY:Design review'))
  const imported = core.importCalendar(ics)
  check('ics re-imports', imported.length === 1 && imported[0].title === 'Design review')
  check('rrule survives the round trip', imported[0].rrule === 'FREQ=WEEKLY;COUNT=4')

  section('attachments')
  const png = Buffer.from([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
    0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01, 0x08, 0x06, 0x00, 0x00, 0x00, 0x1f, 0x15, 0xc4,
    0x89,
  ])
  const att = vault.importAttachment('diagram.png', png, 'Projects/Alpha/Plan.md')
  check('attachment copied into the vault', existsSync(join(vaultDir, att.path)))
  check('markdown reference is relative', att.markdownRef.startsWith('../../attachments/'), att.markdownRef)
  const again = vault.importAttachment('diagram.png', png, 'Projects/Alpha/Plan.md')
  check('identical attachment de-duplicated', again.reused === true && again.path === att.path)

  section('move and rename repair references')
  vault.createFile('Notes.md', '# Notes\n\nSee [[Plan]] and ![pic](../attachments/diagram.png)\n')
  const moved = vault.moveEntry('Projects/Alpha/Plan.md', 'Archive')
  check('note moved', moved === 'Archive/Plan.md')
  const renamed = vault.rename('Ideas.md', 'Concepts.md')
  check('note renamed', renamed === 'Concepts.md')

  section('trash is recoverable')
  vault.delete('Concepts.md')
  check('file removed from the tree', !vault.tree().some(e => e.path === 'Concepts.md'))
  const trash = vault.listTrash()
  check('entry is in the trash', trash.length === 1)
  vault.restoreFromTrash(trash[0].name)
  check('entry restored', vault.tree().some(e => e.path === 'Concepts.md'))

  section('recovery journal')
  vault.saveRecovery('Projects/Alpha/Plan.md', '# unsaved work')
  const recovered = vault.loadRecovery()
  check('recovery buffer stored', recovered.length === 1 && recovered[0].content === '# unsaved work')
  vault.clearRecovery('Projects/Alpha/Plan.md')
  check('recovery buffer cleared', vault.loadRecovery().length === 0)

  section('external change detection')
  writeFileSync(join(vaultDir, 'Projects/Alpha/Plan.md'), '# Alpha Plan\n\nChanged outside the app.\n')
  const changed = vault.detectChanges()
  check('external edit detected', changed.includes('Projects/Alpha/Plan.md'), JSON.stringify(changed))

  section('backup')
  const backup = core.createBackup(vaultDir, join(workDir, 'backups'))
  check('backup archive created', existsSync(backup.path))
  const restored = core.restoreBackup(backup.path, join(workDir, 'restored'))
  // The archive keeps the vault in a top-level folder so a restore never
  // scatters files into the destination.
  const restoredVaults = readdirSync(restored, { withFileTypes: true }).filter(e => e.isDirectory())
  check('backup restored into a vault folder', restoredVaults.length === 1)
  check('restored note is intact',
    existsSync(join(restored, restoredVaults[0].name, 'Projects/Alpha/Plan.md')))

  section('path safety')
  let blocked = false
  try {
    vault.readFile('../../../etc/passwd')
  } catch (e) {
    blocked = String(e.message).includes('escapes the vault')
  }
  check('traversal outside the vault rejected', blocked)

  section('stats')
  const stats = vault.stats()
  check('stats counted notes', stats.notes >= 1, JSON.stringify(stats))
  check('stats counted attachments', stats.attachments >= 1)
} finally {
  rmSync(workDir, { recursive: true, force: true })
}

console.log(`\n${passed} passed, ${failed} failed`)
process.exit(failed === 0 ? 0 : 1)
