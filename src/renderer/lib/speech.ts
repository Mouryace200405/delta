/**
 * Turning a rendered note into something worth listening to.
 *
 * The note is read the way it is shown on screen: the preview is already
 * Markdown turned into prose, so the speech follows the words a person would
 * say rather than the characters they typed. No hashes, no dashes, no pipes.
 */

/** Tags that start a new line when they are spoken. */
const BLOCK_TAGS = new Set([
  'P',
  'DIV',
  'SECTION',
  'ARTICLE',
  'HEADER',
  'FOOTER',
  'H1',
  'H2',
  'H3',
  'H4',
  'H5',
  'H6',
  'LI',
  'UL',
  'OL',
  'PRE',
  'BLOCKQUOTE',
  'TABLE',
  'THEAD',
  'TBODY',
  'TFOOT',
  'TR',
  'HR',
  'BR',
  'FIGURE',
  'FIGCAPTION',
])

/** Marks that mean a sentence already ends properly. */
const SENTENCE_END = /[.!?…:;,]$/

/** Turn the few entities the renderer produces back into characters. */
function decodeEntities(text: string): string {
  return text
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
}

/**
 * Read the text of a rendered note.
 *
 * Blocks become separate lines, so the voice pauses where a reader would.
 * Every line ends in a full stop, because a voice without punctuation runs
 * on without any shape to it.
 */
export function htmlToSpeech(html: string): string {
  if (!html) return ''

  let raw = ''
  let index = 0
  // Inside a code block the line breaks belong to the code.
  let inCode = 0

  while (index < html.length) {
    const open = html.indexOf('<', index)
    if (open < 0) {
      raw += decodeEntities(html.slice(index))
      break
    }
    if (open > index) {
      const text = decodeEntities(html.slice(index, open))
      raw += inCode > 0 ? text : text.replace(/\s*\n\s*/g, ' ')
    }

    const close = html.indexOf('>', open)
    if (close < 0) {
      raw += decodeEntities(html.slice(open))
      break
    }

    const tag = html.slice(open + 1, close)
    const name = (/^\/?\s*([a-zA-Z][a-zA-Z0-9-]*)/.exec(tag)?.[1] ?? '').toLowerCase()
    const closing = tag.trimStart().startsWith('/')

    if (name === 'pre') {
      inCode += closing ? -1 : 1
      if (inCode < 0) inCode = 0
      raw += '\n'
    } else if (name === 'img') {
      const alt = /\balt\s*=\s*"([^"]*)"/.exec(tag)?.[1] ?? /\balt\s*=\s*'([^']*)'/.exec(tag)?.[1]
      if (alt) raw += ` ${alt} `
    } else if (name === 'hr' || name === 'br') {
      raw += '\n'
    } else if (BLOCK_TAGS.has(name.toUpperCase())) {
      raw += '\n'
    }

    index = close + 1
  }

  const lines = raw
    .split('\n')
    .map((line) => line.replace(/[ \t ]+/g, ' ').trim())
    .filter((line) => line.length > 0)

  return lines
    .map((line) => (SENTENCE_END.test(line) ? line : `${line}.`))
    .join('\n')
}
