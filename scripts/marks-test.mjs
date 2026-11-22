#!/usr/bin/env node
// Checks for the live-preview engine.
//
// The editing view shows a note as it is written: the Markdown syntax is
// hidden and the text is styled instead. These checks make sure the engine
// finds the right places to hide and style, so a heading looks like a
// heading and a link looks like a link.
//
// Run with: node scripts/marks-test.mjs

import { collectMarks, frontmatterRange, markIsActive } from '../src/renderer/lib/markdown-marks.ts'

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

function find(marks, kind) {
  return marks.find((mark) => mark.kind === kind)
}

function text(doc, range) {
  return range ? doc.slice(range.from, range.to) : ''
}

section('frontmatter')
const withFront = `---\ntags: [idea]\n---\n\n# Title\n\nBody.`
const front = frontmatterRange(withFront)
check('the frontmatter is found', front !== null)
check('it runs to the closing marker', withFront.slice(0, front.to).endsWith('---\n'), String(front?.to))
check('a note without frontmatter has none', frontmatterRange('# Title\n') === null)

section('headings')
const headingDoc = '# The title\n\nBody text.\n'
const headingMarks = collectMarks(headingDoc)
const heading = find(headingMarks, 'heading1')
check('a heading is found', heading !== undefined)
check('the `#` is hidden', text(headingDoc, heading.hide[0]) === '# ', JSON.stringify(heading.hide))
check('the heading text is styled', text(headingDoc, heading.style) === 'The title', text(headingDoc, heading.style))
check('the line is marked as a heading', heading.lineClass === 'cm-md-h1', String(heading.lineClass))

const deeper = collectMarks('### Third level\n')
check('the level is kept', find(deeper, 'heading3') !== undefined)
check('the level drives the class', find(deeper, 'heading3')?.lineClass === 'cm-md-h3')

section('emphasis')
const boldDoc = 'Some **bold** and *italic* text.'
const boldMarks = collectMarks(boldDoc)
const strong = find(boldMarks, 'strong')
const emphasis = find(boldMarks, 'emphasis')
check('bold is found', strong !== undefined)
check('both stars are hidden', strong.hide.length === 2, JSON.stringify(strong.hide))
check('the bold text is styled', text(boldDoc, strong.style) === 'bold', text(boldDoc, strong.style))
check('italic is found', emphasis !== undefined)
check('the italic text is styled', text(boldDoc, emphasis.style) === 'italic', text(boldDoc, emphasis.style))

section('code')
const codeDoc = 'Call `run()` now.'
const code = find(collectMarks(codeDoc), 'code')
check('inline code is found', code !== undefined)
check('both backticks are hidden', code.hide.length === 2)
check('the code is styled', text(codeDoc, code.style) === 'run()', text(codeDoc, code.style))

const fenceDoc = '```js\nconst a = 1\n```\n'
const fence = find(collectMarks(fenceDoc), 'codeblock')
check('a fenced block is found', fence !== undefined)
check('the fences are hidden', fence.hide.length === 2, JSON.stringify(fence.hide))
check('the block is styled as code', fence.lineClass === 'cm-md-codeblock')

section('links')
const linkDoc = 'See [the docs](https://example.com) now.'
const link = find(collectMarks(linkDoc), 'link')
check('a link is found', link !== undefined)
check('the label is styled', text(linkDoc, link.style) === 'the docs', text(linkDoc, link.style))
check('the brackets are hidden', link.hide.length >= 2, JSON.stringify(link.hide))
check('the url is hidden too', link.hide.some((range) => text(linkDoc, range).includes('example.com')), JSON.stringify(link.hide))

section('wikilinks')
const wikiDoc = 'Read [[Other note]] and [[Target|The alias]].'
const wikiMarks = collectMarks(wikiDoc)
const wikilinks = wikiMarks.filter((mark) => mark.kind === 'wikilink')
check('both wikilinks are found', wikilinks.length === 2, String(wikilinks.length))
check('the brackets are hidden', wikilinks[0].hide.length === 2)
check('the name is styled', text(wikiDoc, wikilinks[0].style) === 'Other note', text(wikiDoc, wikilinks[0].style))
check('an alias hides the target', wikilinks[1].hide.length === 2, JSON.stringify(wikilinks[1].hide))
check('only the alias is styled', text(wikiDoc, wikilinks[1].style) === 'The alias', text(wikiDoc, wikilinks[1].style))

section('tasks')
const taskDoc = '- [ ] open task\n- [x] done task\n'
const taskMarks = collectMarks(taskDoc).filter((mark) => mark.kind === 'task')
check('both tasks are found', taskMarks.length === 2, String(taskMarks.length))
check('an open task is not checked', taskMarks[0].checked === false)
check('a done task is checked', taskMarks[1].checked === true)
check('the bullet and the box are hidden', text(taskDoc, taskMarks[0].hide[0]) === '- [ ]', text(taskDoc, taskMarks[0].hide[0]))
check('the open task has its own class', taskMarks[0].lineClass === 'cm-md-task')
check('the done task has its own class', taskMarks[1].lineClass === 'cm-md-task-done')

section('quotes and rules')
const quote = find(collectMarks('> A quote\n'), 'quote')
check('a quote is found', quote !== undefined)
check('the `>` is hidden', text('> A quote\n', quote.hide[0]) === '>', text('> A quote\n', quote.hide[0]))
const rule = find(collectMarks('Above\n\n---\n\nBelow\n'), 'rule')
check('a rule is found', rule !== undefined)
check('the rule is hidden', rule.hide.length === 1)

section('the cursor keeps the syntax visible')
const marks = collectMarks('Some **bold** text.')
const bold = find(marks, 'strong')
check('a cursor inside the text keeps the markers', markIsActive(bold, 9, 9))
check('a cursor far away hides them', !markIsActive(bold, 30, 30))
check('a selection over the text keeps them', markIsActive(bold, 6, 12))

section('code is left alone')
const mixed = collectMarks('`[[not a link]]` and [[a real link]]')
const mixedWikilinks = mixed.filter((mark) => mark.kind === 'wikilink')
check('only the real wikilink is found', mixedWikilinks.length === 1, String(mixedWikilinks.length))
check('and it is the right one', text('`[[not a link]]` and [[a real link]]', mixedWikilinks[0].style) === 'a real link')

console.log(`\n${passed} passed, ${failed} failed`)
if (failed > 0) process.exit(1)
