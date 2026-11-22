import { useEffect, useRef } from 'react'
import { Compartment, EditorState, type Extension } from '@codemirror/state'
import {
  EditorView,
  keymap,
  lineNumbers,
  highlightActiveLine,
  highlightActiveLineGutter,
  drawSelection,
  rectangularSelection,
  crosshairCursor,
  placeholder,
} from '@codemirror/view'
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands'
import {
  indentOnInput,
  bracketMatching,
  syntaxHighlighting,
  HighlightStyle,
  StreamLanguage,
  type Language,
  type StreamParser,
  type TagStyle,
} from '@codemirror/language'
import { markdown, markdownLanguage } from '@codemirror/lang-markdown'
import {
  autocompletion,
  closeBrackets,
  closeBracketsKeymap,
  completionKeymap,
  type CompletionContext,
  type CompletionResult,
} from '@codemirror/autocomplete'
import { searchKeymap, highlightSelectionMatches } from '@codemirror/search'
import { tags as t } from '@lezer/highlight'
import { livePreview } from '../lib/live-preview'
import type { ThemeName } from '@shared/types'

// A curated set of code languages keeps the bundle small while covering the
// languages most notes actually contain.
import { javascript, json, typescript } from '@codemirror/legacy-modes/mode/javascript'
import { python } from '@codemirror/legacy-modes/mode/python'
import { rust } from '@codemirror/legacy-modes/mode/rust'
import { css } from '@codemirror/legacy-modes/mode/css'
import { shell } from '@codemirror/legacy-modes/mode/shell'
import { standardSQL, sqlite, mySQL, pgSQL } from '@codemirror/legacy-modes/mode/sql'
import { c, cpp, java } from '@codemirror/legacy-modes/mode/clike'
import { go } from '@codemirror/legacy-modes/mode/go'
import { ruby } from '@codemirror/legacy-modes/mode/ruby'
import { yaml } from '@codemirror/legacy-modes/mode/yaml'
import { xml } from '@codemirror/legacy-modes/mode/xml'

export interface EditorProps {
  value: string
  theme: ThemeName
  readOnly?: boolean
  placeholderText?: string
  /**
   * Show the note as it is written rather than as raw Markdown: the syntax is
   * hidden and the text is styled instead.
   */
  preview?: boolean
  onChange(value: string): void
  onSave(): void
  onPasteImage?(file: File): void
  onDropImage?(file: File): void
  /** Note titles offered by the `[[` autocomplete. */
  linkTargets(): string[]
  onNavigateLink?(target: string): void
}

const LEGACY_MODES: Record<string, StreamParser<unknown>> = {
  javascript,
  js: javascript,
  jsx: javascript,
  node: javascript,
  typescript,
  ts: typescript,
  tsx: typescript,
  python,
  py: python,
  rust,
  rs: rust,
  json,
  jsonc: json,
  css,
  scss: css,
  shell,
  sh: shell,
  bash: shell,
  zsh: shell,
  sql: standardSQL,
  sqlite,
  mysql: mySQL,
  postgres: pgSQL,
  c,
  cpp,
  'c++': cpp,
  java,
  go,
  golang: go,
  ruby,
  rb: ruby,
  yaml,
  yml: yaml,
  xml,
  svg: xml,
}

function codeLanguages(info: string): Language | null {
  const mode = LEGACY_MODES[info.toLowerCase()]
  return mode ? StreamLanguage.define(mode) : null
}

/**
 * Nord-flavoured syntax colours for both themes.
 *
 * In the live preview the prose is left to the stylesheet, so only the code
 * keeps its colours — otherwise a heading would be a different colour in the
 * editor than in the finished note.
 */
function highlightStyle(theme: ThemeName, preview = false): HighlightStyle {
  const dark = theme === 'nord-dark'
  const color = {
    heading: dark ? '#88c0d0' : '#5e81ac',
    keyword: dark ? '#81a1c1' : '#4c6f95',
    string: dark ? '#a3be8c' : '#5f7d4c',
    number: dark ? '#b48ead' : '#8a6a84',
    comment: dark ? '#6b7688' : '#8a93a3',
    emphasis: dark ? '#ebcb8b' : '#96731f',
    strong: dark ? '#ebcb8b' : '#96731f',
    link: dark ? '#88c0d0' : '#5e81ac',
    invalid: dark ? '#bf616a' : '#a3424c',
  }

  const rules: TagStyle[] = [
    { tag: t.keyword, color: color.keyword },
    { tag: t.controlKeyword, color: color.keyword },
    { tag: t.moduleKeyword, color: color.keyword },
    { tag: t.string, color: color.string },
    { tag: t.special(t.string), color: color.string },
    { tag: t.regexp, color: color.string },
    { tag: t.number, color: color.number },
    { tag: t.bool, color: color.number },
    { tag: t.null, color: color.number },
    { tag: t.comment, color: color.comment, fontStyle: 'italic' },
    { tag: t.lineComment, color: color.comment, fontStyle: 'italic' },
    { tag: t.blockComment, color: color.comment, fontStyle: 'italic' },
    { tag: t.monospace, color: color.string },
    { tag: t.invalid, color: color.invalid },
  ]

  if (!preview) {
    rules.unshift(
      { tag: t.heading1, color: color.heading, fontWeight: '700' },
      { tag: t.heading2, color: color.heading, fontWeight: '700' },
      { tag: t.heading3, color: color.heading, fontWeight: '600' },
      { tag: t.heading4, color: color.heading, fontWeight: '600' },
      { tag: t.heading5, color: color.heading, fontWeight: '600' },
      { tag: t.heading6, color: color.heading, fontWeight: '600' },
    )
    rules.push(
      { tag: t.emphasis, color: color.emphasis, fontStyle: 'italic' },
      { tag: t.strong, color: color.strong, fontWeight: '700' },
      { tag: t.strikethrough, color: color.comment, textDecoration: 'line-through' },
      { tag: t.link, color: color.link, textDecoration: 'underline' },
      { tag: t.url, color: color.link },
      { tag: t.quote, color: color.comment, fontStyle: 'italic' },
      { tag: t.list, color: color.keyword },
      { tag: t.processingInstruction, color: color.comment },
    )
  }

  return HighlightStyle.define(rules)
}

/** Editor chrome that follows the application theme. */
function editorTheme(theme: ThemeName, preview = false): Extension {
  const dark = theme === 'nord-dark'
  const bg = dark ? '#2e3440' : '#eceff4'
  const gutterText = dark ? '#6b7688' : '#8a93a3'
  const selection = dark ? 'rgba(136,192,208,0.24)' : 'rgba(94,129,172,0.2)'
  const activeLine = dark ? 'rgba(63,72,89,0.35)' : 'rgba(216,222,233,0.5)'
  const cursor = dark ? '#88c0d0' : '#5e81ac'

  return [
    EditorView.theme(
      {
        '&': { color: dark ? '#d8dee9' : '#2e3440', backgroundColor: bg, height: '100%' },
        '.cm-content': { caretColor: cursor },
        '&.cm-focused .cm-cursor': { borderLeftColor: cursor },
        '.cm-selectionBackground, ::selection': { backgroundColor: selection },
        '.cm-activeLine': { backgroundColor: activeLine },
        '.cm-gutters': { backgroundColor: bg, color: gutterText, border: 'none' },
        '.cm-activeLineGutter': {
          backgroundColor: activeLine,
          color: dark ? '#a9b3c4' : '#4c566a',
        },
        '.cm-scroller': { fontFamily: 'var(--font-content)' },
        '.cm-tooltip': {
          backgroundColor: dark ? '#434c5e' : '#d8dee9',
          border: `1px solid ${dark ? '#4c566a' : '#cfd6e0'}`,
          color: dark ? '#d8dee9' : '#2e3440',
        },
        '.cm-tooltip-autocomplete ul li[aria-selected]': {
          backgroundColor: '#5e81ac',
          color: '#ffffff',
        },
        '.cm-placeholder': { color: gutterText },
      },
      { dark },
    ),
    syntaxHighlighting(highlightStyle(theme, preview)),
  ]
}

/** `[[` triggers a note-title completion list. */
function linkCompletion(getTargets: () => string[]) {
  return (context: CompletionContext): CompletionResult | null => {
    const before = context.matchBefore(/\[\[[^[\]\n]*/)
    if (!before) return null
    const query = before.text.slice(2).toLowerCase()
    const targets = getTargets()
      .filter((title) => title.toLowerCase().includes(query))
      .slice(0, 40)
      .map((title) => ({ label: title, type: 'text' }))
    if (targets.length === 0) return null
    return { from: before.from + 2, options: targets, validFor: /^[^[\]\n]*$/ }
  }
}

export function MarkdownEditor({
  value,
  theme,
  readOnly = false,
  placeholderText,
  preview = false,
  onChange,
  onSave,
  onPasteImage,
  onDropImage,
  linkTargets,
  onNavigateLink,
}: EditorProps) {
  const hostRef = useRef<HTMLDivElement>(null)
  const viewRef = useRef<EditorView | null>(null)
  const themeRef = useRef(new Compartment())
  const previewRef = useRef(new Compartment())
  const callbacks = useRef({ onChange, onSave, onPasteImage, onDropImage, onNavigateLink, linkTargets })
  callbacks.current = { onChange, onSave, onPasteImage, onDropImage, onNavigateLink, linkTargets }

  // Create the editor once.
  useEffect(() => {
    if (!hostRef.current) return

    const extensions: Extension[] = [
      lineNumbers(),
      highlightActiveLine(),
      highlightActiveLineGutter(),
      drawSelection(),
      rectangularSelection(),
      crosshairCursor(),
      history(),
      indentOnInput(),
      bracketMatching(),
      closeBrackets(),
      highlightSelectionMatches(),
      EditorView.lineWrapping,
      EditorState.tabSize.of(2),
      markdown({ base: markdownLanguage, codeLanguages }),
      autocompletion({
        override: [linkCompletion(() => callbacks.current.linkTargets())],
        activateOnTyping: true,
      }),
      keymap.of([
        {
          key: 'Mod-s',
          run: () => {
            callbacks.current.onSave()
            return true
          },
        },
        {
          key: 'Mod-Enter',
          run: (view) => {
            // Ctrl+Enter opens the link under the cursor.
            const range = view.state.selection.main
            const text = view.state.sliceDoc(range.from, range.to)
            const match = /\[\[([^\]]+)\]\]/.exec(text)
            if (match) {
              callbacks.current.onNavigateLink?.(match[1].replace(/\|.*$/, '').trim())
              return true
            }
            return false
          },
        },
        ...closeBracketsKeymap,
        ...defaultKeymap,
        ...historyKeymap,
        ...searchKeymap,
        ...completionKeymap,
        indentWithTab,
      ]),
      EditorView.updateListener.of((update) => {
        if (update.docChanged) {
          callbacks.current.onChange(update.state.doc.toString())
        }
      }),
      EditorView.domEventHandlers({
        paste: (event) => {
          const items = event.clipboardData?.items
          if (!items) return false
          for (const item of Array.from(items)) {
            if (item.type.startsWith('image/')) {
              const file = item.getAsFile()
              if (file && callbacks.current.onPasteImage) {
                event.preventDefault()
                callbacks.current.onPasteImage(file)
                return true
              }
            }
          }
          return false
        },
        drop: (event) => {
          const files = event.dataTransfer?.files
          if (!files || files.length === 0) return false
          const file = Array.from(files).find((f) => f.type.startsWith('image/'))
          if (file && callbacks.current.onDropImage) {
            event.preventDefault()
            callbacks.current.onDropImage(file)
            return true
          }
          return false
        },
        click: (event) => {
          const target = event.target as HTMLElement
          const link = target.closest('a.wikilink') as HTMLAnchorElement | null
          if (link) {
            const name = link.dataset.wikilink
            if (name) {
              event.preventDefault()
              callbacks.current.onNavigateLink?.(name)
              return true
            }
          }
          return false
        },
      }),
      themeRef.current.of(editorTheme(theme, preview)),
      // Live preview can be switched on and off without losing the document,
      // the cursor or the undo history.
      previewRef.current.of(preview ? livePreview() : []),
    ]

    if (readOnly) extensions.push(EditorState.readOnly.of(true))
    if (placeholderText) extensions.push(placeholder(placeholderText))

    const view = new EditorView({
      state: EditorState.create({ doc: value, extensions }),
      parent: hostRef.current,
    })
    viewRef.current = view

    return () => {
      view.destroy()
      viewRef.current = null
    }
    // The editor is created once; theme and content are synced by the effects
    // below so switching tabs never loses the cursor or undo history.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Push external content changes into the editor (tab switches, restores).
  useEffect(() => {
    const view = viewRef.current
    if (!view) return
    const current = view.state.doc.toString()
    if (current === value) return
    view.dispatch({
      changes: { from: 0, to: current.length, insert: value },
      selection: { anchor: Math.min(view.state.selection.main.anchor, value.length) },
    })
  }, [value])

  // Re-apply the theme without disturbing the document or history.
  useEffect(() => {
    viewRef.current?.dispatch({
      effects: themeRef.current.reconfigure(editorTheme(theme, preview)),
    })
  }, [theme, preview])

  // Switch between the live preview and the raw Markdown.
  useEffect(() => {
    viewRef.current?.dispatch({
      effects: previewRef.current.reconfigure(preview ? livePreview() : []),
    })
  }, [preview])

  return <div className="editor-host" ref={hostRef} />
}
