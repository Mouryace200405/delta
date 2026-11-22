import { parser } from '@lezer/markdown'
import type { SyntaxNode } from '@lezer/common'

/**
 * The live-preview engine.
 *
 * The document in the editor stays plain Markdown — that is what ends up on
 * disk — but the *display* hides the syntax and styles the text, so a note
 * reads like a finished note while it is being written. Clicking puts the
 * cursor in the text and typing works as it does in any editor.
 *
 * This module only works out *where* the syntax is. It knows nothing about
 * the DOM or about CodeMirror, which keeps it testable on its own.
 */

export type MarkKind =
  | 'heading1'
  | 'heading2'
  | 'heading3'
  | 'heading4'
  | 'heading5'
  | 'heading6'
  | 'emphasis'
  | 'strong'
  | 'code'
  | 'codeblock'
  | 'link'
  | 'wikilink'
  | 'quote'
  | 'rule'
  | 'frontmatter'
  | 'task'

export interface Range {
  from: number
  to: number
}

export interface Mark {
  kind: MarkKind
  /** The whole construct, from the first marker to the last. */
  from: number
  to: number
  /** Syntax that is hidden while the cursor is somewhere else. */
  hide: Range[]
  /** The text that is styled. */
  style?: Range
  /** A class for the whole line, for block-level marks. */
  lineClass?: string
  /** True when a task box is ticked. */
  checked?: boolean
}

/** The YAML frontmatter at the top of a note, if there is one. */
export function frontmatterRange(doc: string): Range | null {
  if (!doc.startsWith('---')) return null
  const rest = doc.slice(3)
  const match = /^([^\n]*\n)*?---[ \t]*(\n|$)/.exec(rest)
  if (!match) return null
  return { from: 0, to: 3 + match[0].length }
}

function children(node: SyntaxNode, name: string): SyntaxNode[] {
  const found: SyntaxNode[] = []
  const cursor = node.cursor()
  if (cursor.firstChild()) {
    do {
      if (cursor.name === name) found.push(cursor.node)
    } while (cursor.nextSibling())
  }
  return found
}

function firstChild(node: SyntaxNode, name: string): SyntaxNode | null {
  return children(node, name)[0] ?? null
}

/** The text between the first and last marker of a construct. */
function between(markers: SyntaxNode[]): Range | null {
  if (markers.length === 0) return null
  const first = markers[0]
  const last = markers[markers.length - 1]
  const from = first.to
  const to = last.from
  if (to <= from) return null
  return { from, to }
}

const HEADING = /^ATXHeading([1-6])$/

/**
 * Work out every mark in a Markdown document.
 *
 * The Markdown parser handles the nesting — bold inside italic, a link inside
 * a heading — while wikilinks and task boxes are found by hand, because plain
 * Markdown has no syntax for either.
 */
export function collectMarks(doc: string): Mark[] {
  const marks: Mark[] = []
  const front = frontmatterRange(doc)
  const tree = parser.parse(doc)

  if (front) {
    marks.push({
      kind: 'frontmatter',
      from: front.from,
      to: front.to,
      hide: [],
      lineClass: 'cm-md-frontmatter',
    })
  }

  // Ranges that hold code, where a wikilink or a task box is only text.
  const codeRanges: Range[] = []

  const inside = (from: number, to: number): boolean =>
    front !== null && from >= front.from && to <= front.to

  tree.iterate({
    enter(node) {
      const name = node.name
      const from = node.from
      const to = node.to
      if (inside(from, to)) return

      const heading = HEADING.exec(name)
      if (heading) {
        const marker = firstChild(node.node, 'HeaderMark')
        if (!marker) return
        // Hide the `###` and the space after it, so the heading starts at the
        // left edge of the line.
        let hideTo = marker.to
        while (hideTo < to && (doc[hideTo] === ' ' || doc[hideTo] === '\t')) hideTo++
        marks.push({
          kind: `heading${heading[1]}` as MarkKind,
          from,
          to,
          hide: [{ from: marker.from, to: hideTo }],
          style: { from: hideTo, to },
          lineClass: `cm-md-h${heading[1]}`,
        })
        return
      }

      if (name === 'StrongEmphasis' || name === 'Emphasis') {
        const markers = children(node.node, 'EmphasisMark')
        if (markers.length === 0) return
        const content = between(markers)
        marks.push({
          kind: name === 'StrongEmphasis' ? 'strong' : 'emphasis',
          from,
          to,
          hide: markers.map((marker) => ({ from: marker.from, to: marker.to })),
          style: content ?? undefined,
        })
        return
      }

      if (name === 'InlineCode') {
        const markers = children(node.node, 'CodeMark')
        if (markers.length === 0) return
        const content = between(markers)
        // Text inside `backticks` is code, not a link or a task box.
        codeRanges.push({ from, to })
        marks.push({
          kind: 'code',
          from,
          to,
          hide: markers.map((marker) => ({ from: marker.from, to: marker.to })),
          style: content ?? undefined,
        })
        return
      }

      if (name === 'Link') {
        const markers = children(node.node, 'LinkMark')
        const url = firstChild(node.node, 'URL')
        // The whole link is hidden but its label, so it reads as one word.
        const hide = markers.map((marker) => ({ from: marker.from, to: marker.to }))
        if (url) hide.push({ from: url.from, to: url.to })
        // The label sits between the opening `[` and the closing `]`.
        const open = markers[0]
        const close = markers[1]
        const label =
          open && close && close.from > open.to ? { from: open.to, to: close.from } : undefined
        marks.push({
          kind: 'link',
          from,
          to,
          hide,
          style: label,
        })
        return
      }

      if (name === 'Blockquote') {
        const markers = children(node.node, 'QuoteMark')
        marks.push({
          kind: 'quote',
          from,
          to,
          hide: markers.map((marker) => ({ from: marker.from, to: marker.to })),
          lineClass: 'cm-md-quote',
        })
        return
      }

      if (name === 'FencedCode') {
        const markers = children(node.node, 'CodeMark')
        codeRanges.push({ from, to })
        marks.push({
          kind: 'codeblock',
          from,
          to,
          hide: markers.map((marker) => ({ from: marker.from, to: marker.to })),
          lineClass: 'cm-md-codeblock',
        })
        return
      }

      if (name === 'CodeBlock') {
        codeRanges.push({ from, to })
        marks.push({
          kind: 'codeblock',
          from,
          to,
          hide: [],
          lineClass: 'cm-md-codeblock',
        })
        return
      }

      if (name === 'HorizontalRule') {
        marks.push({
          kind: 'rule',
          from,
          to,
          hide: [{ from, to }],
          lineClass: 'cm-md-rule',
        })
        return
      }
    },
  })

  const inCode = (from: number, to: number): boolean =>
    codeRanges.some((range) => from >= range.from && to <= range.to)

  // Wikilinks are not Markdown, so they are found by hand.
  const wikilink = /\[\[([^[\]\n]+)\]\]/g
  for (let match = wikilink.exec(doc); match; match = wikilink.exec(doc)) {
    const start = match.index
    const end = start + match[0].length
    if (inCode(start, end)) continue
    const inner = match[1]
    const pipe = inner.indexOf('|')
    if (pipe >= 0) {
      // `[[Target|Alias]]` shows only the alias.
      const aliasStart = start + 2 + pipe + 1
      marks.push({
        kind: 'wikilink',
        from: start,
        to: end,
        hide: [
          { from: start, to: aliasStart },
          { from: end - 2, to: end },
        ],
        style: { from: aliasStart, to: end - 2 },
      })
    } else {
      marks.push({
        kind: 'wikilink',
        from: start,
        to: end,
        hide: [
          { from: start, to: start + 2 },
          { from: end - 2, to: end },
        ],
        style: { from: start + 2, to: end - 2 },
      })
    }
  }

  // A task box is a list item that starts with `[ ]` or `[x]`.
  const task = /^[ \t]*([-*+])[ \t]+\[([ xX])\]/gm
  for (let match = task.exec(doc); match; match = task.exec(doc)) {
    const start = match.index
    const end = start + match[0].length
    if (inCode(start, end)) continue
    marks.push({
      kind: 'task',
      from: start,
      to: end,
      // The bullet and the box are both hidden; a drawn box takes their place.
      hide: [{ from: start, to: end }],
      lineClass: match[2] === ' ' ? 'cm-md-task' : 'cm-md-task-done',
      checked: match[2] !== ' ',
    })
  }

  return marks.sort((a, b) => a.from - b.from || a.to - b.to)
}

/** Does the selection touch this mark? If so the syntax stays visible. */
export function markIsActive(mark: Mark, from: number, to: number): boolean {
  if (from === to) {
    // A cursor inside the construct — or right at its edge — keeps the
    // syntax on screen so it can be edited.
    return from >= mark.from && from <= mark.to
  }
  return from < mark.to && to > mark.from
}

/** The task boxes in a document, for the click handler. */
export function taskMarks(marks: Mark[]): Array<{ from: number; to: number; checked: boolean }> {
  return marks
    .filter((mark) => mark.kind === 'task')
    .map((mark) => ({ from: mark.from, to: mark.to, checked: Boolean(mark.checked) }))
}
