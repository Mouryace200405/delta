#!/usr/bin/env node
// Checks for the text the voice reads.
//
// The read-aloud feature speaks the rendered note, so this checks that the
// rendering turns into prose: no hashes, no dashes, no checkbox markers and
// no table pipes — and that the sentences stay whole.
//
// Run with: node scripts/speech-test.mjs

import { htmlToSpeech } from '../src/renderer/lib/speech.ts'
import { stripFrontmatter } from '../src/renderer/lib/markdown.ts'

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

section('frontmatter')
const withFrontmatter = `---\ntags: [idea]\n---\n\n# The title\n\nThe body.`
const stripped = stripFrontmatter(withFrontmatter)
check('frontmatter is removed', !stripped.includes('tags'))
check('the title is kept', stripped.includes('# The title'))

section('a rendered note')
const html = `<h1>Welcome to Delta</h1>
<p>Delta keeps <strong>Markdown notes</strong>, tasks and drawings in one place, on
your own disk.</p>
<h2>Try it out</h2>
<ul>
<li class="task-list-item"><input type="checkbox" class="task-checkbox" checked="" disabled>Open a note</li>
<li class="task-list-item"><input type="checkbox" class="task-checkbox" disabled>Drag a task</li>
</ul>
<p>Turn on <a href="#/note/Drawings">Drawings</a> sync in Settings.</p>
<blockquote>
<p>Notes stay ordinary <code>.md</code> files.</p>
</blockquote>`

const speech = htmlToSpeech(html)

check('no hashes', !speech.includes('#'), speech)
check('no dashes at the start of a line', !/^-/m.test(speech), speech)
check('no checkbox markers', !/\[[ xX]\]/.test(speech), speech)
check('no table pipes', !speech.includes('|'), speech)
check('no angle brackets', !speech.includes('<'), speech)

check('the heading is spoken', speech.includes('Welcome to Delta.'), speech)
check('the emphasis is gone', speech.includes('keeps Markdown notes,'), speech)
check('the list items are spoken', speech.includes('Open a note.'), speech)
check('the link text is spoken', speech.includes('Turn on Drawings sync'), speech)
check('the quote is spoken', speech.includes('Notes stay ordinary .md files.'), speech)

section('sentences stay whole')
check(
  'a wrapped sentence is not cut in half',
  speech.includes('in one place, on your own disk.'),
  speech,
)
check('every line ends in a full stop', speech.split('\n').every((l) => /[.!?]$/.test(l)), speech)

section('code blocks')
const code = htmlToSpeech('<pre><code>fn main() {\n    println!()\n}</code></pre>')
check('the code is kept', code.includes('fn main()'), code)
check('the code lines are separate', code.split('\n').length === 3, code)

section('empty input')
check('empty html gives nothing', htmlToSpeech('') === '')

console.log(`\n${passed} passed, ${failed} failed`)
process.exit(failed === 0 ? 0 : 1)
