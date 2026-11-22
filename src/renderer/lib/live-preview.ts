import { EditorView, Decoration, ViewPlugin, type DecorationSet, type ViewUpdate } from '@codemirror/view'
import type { Extension, Range as CmRange } from '@codemirror/state'
import { collectMarks, markIsActive, type Mark, type Range as MarkRange } from './markdown-marks'

/**
 * Live preview.
 *
 * The note is edited as plain Markdown, but the syntax is hidden and the
 * text is styled instead, so it reads like the finished note while it is
 * being written. The syntax comes back as soon as the cursor touches it, so
 * nothing is ever out of reach.
 */

/** The class that styles the text of each kind of mark. */
const STYLE_CLASS: Record<string, string> = {
  emphasis: 'cm-md-em',
  strong: 'cm-md-strong',
  code: 'cm-md-code',
  link: 'cm-md-link',
  wikilink: 'cm-md-wikilink',
}

/** A decorated range. CodeMirror reads only these three fields. */
interface DecorationRange {
  from: number
  to: number
  value: Decoration
}

function overlaps(a: MarkRange, b: MarkRange): boolean {
  return a.from < b.to && b.from < a.to
}

function buildDecorations(view: EditorView): DecorationSet {
  const doc = view.state.doc.toString()
  const marks = collectMarks(doc)
  const selection = view.state.selection.main

  const ranges: DecorationRange[] = []
  // Line classes are gathered per line, so a line can carry several.
  const lineClasses = new Map<number, Set<string>>()
  // Replace decorations must not overlap each other.
  const hidden: MarkRange[] = []

  const addLineClass = (at: number, className: string): void => {
    const line = view.state.doc.lineAt(at).number
    const set = lineClasses.get(line) ?? new Set<string>()
    set.add(className)
    lineClasses.set(line, set)
  }

  for (const mark of marks) {
    // The syntax only comes back when the editor has the cursor and the
    // cursor is in the construct — so a note reads as a finished note until
    // it is touched.
    const active = view.hasFocus && markIsActive(mark, selection.from, selection.to)

    if (mark.lineClass) addLineClass(mark.from, mark.lineClass)

    // The text itself is styled.
    const styleClass = STYLE_CLASS[mark.kind]
    if (styleClass && mark.style && mark.style.to > mark.style.from) {
      ranges.push({
        from: mark.style.from,
        to: mark.style.to,
        value: Decoration.mark({ class: styleClass }),
      })
    }

    for (const range of mark.hide) {
      if (range.to <= range.from) continue
      if (active) {
        // The cursor is here, so the syntax stays on screen — dimmed, so it
        // is clear that it is markup rather than text.
        ranges.push({
          from: range.from,
          to: range.to,
          value: Decoration.mark({ class: 'cm-md-marker' }),
        })
        continue
      }
      if (hidden.some((other) => overlaps(other, range))) continue
      hidden.push(range)
      ranges.push({ from: range.from, to: range.to, value: Decoration.replace({}) })
    }
  }

  for (const [line, classes] of lineClasses) {
    const spec = view.state.doc.line(line)
    ranges.push({
      from: spec.from,
      to: spec.from,
      value: Decoration.line({ class: [...classes].join(' ') }),
    })
  }

  return Decoration.set(ranges as unknown as CmRange<Decoration>[], true)
}

/** Toggle the box of the task whose line was clicked. */
function toggleTaskAt(view: EditorView, x: number, y: number): boolean {
  const at = view.posAtCoords({ x, y })
  if (at === null) return false
  const doc = view.state.doc.toString()
  const tasks = collectMarks(doc).filter((mark) => mark.kind === 'task')
  if (tasks.length === 0) return false
  const line = view.state.doc.lineAt(at)
  const task = tasks.find((mark) => mark.from === line.from)
  if (!task) return false
  const box = line.text.indexOf('[', task.from)
  if (box < 0) return false
  const position = line.from + box + 1
  view.dispatch({
    changes: {
      from: position,
      to: position + 1,
      insert: task.checked ? ' ' : 'x',
    },
  })
  return true
}

export function livePreview(): Extension {
  return [
    ViewPlugin.fromClass(
      class {
        decorations: DecorationSet

        constructor(view: EditorView) {
          this.decorations = buildDecorations(view)
        }

        update(update: ViewUpdate): void {
          // The syntax comes and goes with the focus, so a focus change has
          // to redraw it as well.
          if (
            update.docChanged ||
            update.selectionSet ||
            update.viewportChanged ||
            update.focusChanged
          ) {
            this.decorations = buildDecorations(update.view)
          }
        }
      },
      { decorations: (value) => value.decorations },
    ),
    EditorView.domEventHandlers({
      mousedown: (event, view) => {
        if (event.button !== 0) return false
        return toggleTaskAt(view, event.clientX, event.clientY)
      },
    }),
  ]
}

/** Exported for the tests: the marks of a document. */
export function previewMarks(doc: string): Mark[] {
  return collectMarks(doc)
}
