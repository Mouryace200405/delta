#!/usr/bin/env node
// End-to-end check of the vault sync.
//
// Two vaults stand in for two devices that share one Git repository. The
// test walks through the whole flow: setting a vault up, pushing, pulling
// the vault down on the second device, syncing in both directions and
// finally resolving a conflict.
//
// The remote is a plain local repository, so the test needs neither a
// GitHub account nor a network.

import { execFileSync } from 'node:child_process'
import { mkdirSync, writeFileSync, rmSync, existsSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const core = await import(join(here, '..', 'native', 'index.js'))

const ROOT = join('/tmp', 'delta-sync-test')
const REMOTE = join(ROOT, 'remote.git')

rmSync(ROOT, { recursive: true, force: true })
mkdirSync(ROOT, { recursive: true })
execFileSync('git', ['init', '--bare', '-b', 'main', REMOTE], { stdio: 'ignore' })

/** Run git and never throw: a failing command simply returns nothing. */
function git(dir, ...args) {
  try {
    return execFileSync('git', ['-C', dir, ...args], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    })
  } catch {
    return ''
  }
}

let failed = 0
function check(label, condition, detail = '') {
  if (condition) {
    console.log(`ok   ${label}`)
  } else {
    failed += 1
    console.log(`FAIL ${label}${detail ? ` — ${detail}` : ''}`)
  }
}

// The first device: a vault that already holds notes and drawings.
const A = join(ROOT, 'deviceA')
mkdirSync(join(A, '.delta'), { recursive: true })
writeFileSync(join(A, '.delta', 'app.db'), 'local cache')
writeFileSync(join(A, 'Welcome.md'), '# Welcome\n\nHello from deviceA\n')
mkdirSync(join(A, 'drawings'), { recursive: true })
writeFileSync(join(A, 'drawings', 'Arch.excalidraw'), '{"type":"excalidraw"}')

let result = core.syncSetup(A, `file://${REMOTE}`, 'main', false)
check('a vault can be set up', result.ok, result.message)

result = core.syncPush(A, `file://${REMOTE}`, 'main', undefined, 'Delta: sync')
check('the first push really pushes', result.ok && result.commits > 0, result.message)

const tracked = git(A, 'ls-files').trim().split('\n')
check(
  'the app folder never reaches git',
  !tracked.some((file) => file.startsWith('.delta')),
  tracked.join(', '),
)
check(
  'notes and drawings are tracked',
  tracked.includes('Welcome.md') && tracked.includes('drawings/Arch.excalidraw'),
)

// The second device: a fresh install with an empty vault.
const B = join(ROOT, 'deviceB')
mkdirSync(B, { recursive: true })

result = core.syncSetup(B, `file://${REMOTE}`, 'main', false)
check('a second vault can be set up', result.ok, result.message)

result = core.syncPull(B, `file://${REMOTE}`, 'main', undefined)
check('the second vault pulls the notes down', result.ok && !result.conflict, result.message)
check(
  'the notes arrived',
  readFileSync(join(B, 'Welcome.md'), 'utf8').includes('deviceA'),
)
check('the drawing arrived', existsSync(join(B, 'drawings', 'Arch.excalidraw')))

// Both directions.
writeFileSync(join(B, 'Welcome.md'), '# Welcome\n\nHello from deviceB (edited)\n')
result = core.syncNow(B, `file://${REMOTE}`, 'main', undefined, 'Delta: edit')
check('the second vault syncs its change up', result.ok && !result.conflict, result.message)

result = core.syncPull(A, `file://${REMOTE}`, 'main', undefined)
check('the first vault pulls the change down', result.ok && !result.conflict, result.message)
check(
  'the change landed',
  readFileSync(join(A, 'Welcome.md'), 'utf8').includes('deviceB (edited)'),
)

// A conflict: both devices change the same file.
writeFileSync(join(A, 'Welcome.md'), '# Welcome\n\nA wins\n')
writeFileSync(join(B, 'Welcome.md'), '# Welcome\n\nB wins\n')

result = core.syncNow(A, `file://${REMOTE}`, 'main', undefined, 'A change')
check('the first vault pushes first', result.ok && !result.conflict, result.message)

result = core.syncNow(B, `file://${REMOTE}`, 'main', undefined, 'B change')
check('the conflict is reported', result.conflict === true, result.message)
check('the conflict names the file', result.message.includes('Welcome.md'), result.message)

const markers = readFileSync(join(B, 'Welcome.md'), 'utf8')
check('the markers are in the note', markers.includes('<<<<<<<') && markers.includes('>>>>>>>'))
check('both versions are kept', markers.includes('A wins') && markers.includes('B wins'))

result = core.syncNow(B, `file://${REMOTE}`, 'main', undefined, 'again')
check('an unresolved conflict is not committed', result.conflict === true, result.message)
check(
  'the markers are left alone',
  readFileSync(join(B, 'Welcome.md'), 'utf8').includes('<<<<<<<'),
)

// Resolving the note the way a person would, and syncing again.
writeFileSync(join(B, 'Welcome.md'), '# Welcome\n\nB wins, resolved by hand\n')
result = core.syncNow(B, `file://${REMOTE}`, 'main', undefined, 'Delta: resolve')
check('the resolved conflict syncs', result.ok && !result.conflict, result.message)
check(
  'no markers are left',
  !readFileSync(join(B, 'Welcome.md'), 'utf8').includes('<<<<<<<'),
)

result = core.syncPull(A, `file://${REMOTE}`, 'main', undefined)
check(
  'the first vault gets the resolution',
  result.ok && readFileSync(join(A, 'Welcome.md'), 'utf8').includes('resolved by hand'),
  result.message,
)

// An empty vault still needs a branch that can be pushed.
const C = join(ROOT, 'empty')
mkdirSync(C, { recursive: true })
result = core.syncSetup(C, `file://${REMOTE}`, 'side', false)
check('an empty vault can be set up', result.ok, result.message)
result = core.syncPush(C, `file://${REMOTE}`, 'side', undefined, 'empty')
check('an empty vault can be pushed', result.ok, result.message)

// A remote without the branch that is being asked for.
const D = join(ROOT, 'deviceD')
mkdirSync(D, { recursive: true })
execFileSync('git', ['-C', D, 'init', '-b', 'main'], { stdio: 'ignore' })
execFileSync('git', ['-C', D, 'remote', 'add', 'origin', `file://${REMOTE}`], { stdio: 'ignore' })
result = core.syncPull(D, `file://${REMOTE}`, 'main', undefined)
check('a missing remote branch is handled', result.ok && !result.conflict, result.message)

try {
  core.syncPull(join(ROOT, 'nothing'), undefined, 'main', undefined)
  check('pulling without a repository fails', false)
} catch (error) {
  check('pulling without a repository fails', true, error.message)
}

const status = core.syncStatus(A, `file://${REMOTE}`, 'main')
check('the status knows the vault is a repository', status.isRepo === true)
check('the status knows git is installed', status.gitAvailable === true)
check('the status knows when git-lfs is missing', status.lfsAvailable === false)
check('the status shows the last commit', Boolean(status.lastCommit), status.lastCommit)

rmSync(ROOT, { recursive: true, force: true })

if (failed > 0) {
  console.log(`\n${failed} sync check(s) failed`)
  process.exit(1)
}
console.log('\nall sync checks passed')
