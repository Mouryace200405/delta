import MarkdownIt from 'markdown-it'
import type { RendererRule } from 'markdown-it'

export interface MarkdownContext {
  /** Vault-relative path of the note being rendered. */
  notePath: string
  /** Resolve a wikilink target to a vault path, or null when it is missing. */
  resolveNote(target: string): string | null
  /** Resolve a relative file reference to a displayable URL. */
  resolveFile(target: string): string
}

function isExternal(href: string): boolean {
  return /^(https?:|mailto:|data:|ftp:)/i.test(href)
}

/**
 * Remove the YAML frontmatter from the top of a note.
 *
 * Frontmatter is metadata — `tags`, `aliases`, `created` — and belongs to the
 * note's header, not to its text. It is stripped before rendering, so it
 * never shows up in the preview and is never read out loud.
 */
export function stripFrontmatter(source: string): string {
  if (!source.startsWith('---')) return source
  const lines = source.split('\n')
  if (lines[0].trim() !== '---') return source
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i].trim()
    if (line === '---' || line === '...') {
      return lines.slice(i + 1).join('\n')
    }
  }
  // No closing marker: there is no frontmatter, only a divider.
  return source
}

/**
 * Render Markdown to HTML.
 *
 * Raw HTML is disabled so that a note can never inject markup or scripts into
 * the preview — notes are frequently shared between machines.
 */
export function createMarkdown(ctx: MarkdownContext) {
  const md = new MarkdownIt({
    html: false,
    linkify: true,
    breaks: false,
    typographer: false,
  })

  // ---------------------------------------------------------- wikilinks
  md.inline.ruler.before('link', 'wikilink', (state: any, silent: boolean) => {
    const start = state.pos
    const src = state.src
    const max = state.posMax

    let embed = false
    if (src.charCodeAt(start) === 0x21 /* ! */ && src.charCodeAt(start + 1) === 0x5b /* [ */) {
      embed = true
    }
    const bracket = start + (embed ? 1 : 0)
    if (src.charCodeAt(bracket) !== 0x5b /* [ */) return false
    if (src.charCodeAt(bracket + 1) !== 0x5b) return false

    const close = src.indexOf(']]', bracket + 2)
    if (close < 0 || close >= max) return false

    const inner = src.slice(bracket + 2, close)
    if (!inner.trim()) return false

    if (!silent) {
      const pipe = inner.indexOf('|')
      const target = (pipe >= 0 ? inner.slice(0, pipe) : inner).trim()
      const alias = pipe >= 0 ? inner.slice(pipe + 1).trim() : ''
      const headingSplit = target.indexOf('#')
      const name = (headingSplit >= 0 ? target.slice(0, headingSplit) : target).trim()
      const heading = headingSplit >= 0 ? target.slice(headingSplit) : ''

      const resolved = ctx.resolveNote(name)
      const label = alias || name
      const open = state.push('link_open', 'a', 1)
      open.attrs = [
        ['href', resolved ? `#/note/${encodeURIComponent(resolved)}` : '#'],
        ['class', resolved ? 'wikilink' : 'wikilink missing'],
        ['data-wikilink', name],
      ]
      if (resolved) open.attrs.push(['data-path', resolved])
      const text = state.push('text', '', 0)
      text.content = label
      const closeTag = state.push('link_close', 'a', -1)
      void heading
      void closeTag
    }

    state.pos = close + 2
    return true
  })

  // ------------------------------------------------------------- task list
  md.core.ruler.after('inline', 'task-lists', (state) => {
    const tokens = state.tokens
    for (let i = 0; i < tokens.length; i++) {
      // A task item is: list_item_open, paragraph_open, inline, paragraph_close.
      if (tokens[i].type !== 'list_item_open') continue
      const paragraphOpen = tokens[i + 1]
      const inline = tokens[i + 2]
      const paragraphClose = tokens[i + 3]
      if (!paragraphOpen || !inline || !paragraphClose) continue
      if (paragraphOpen.type !== 'paragraph_open' || inline.type !== 'inline') continue

      const match = /^\[([ xX])\]\s+/.exec(inline.content)
      if (!match) continue
      const checked = match[1].toLowerCase() === 'x'

      // The inline tokens were already parsed, so the marker has to be
      // removed from the first text token rather than from `content`.
      let remaining = match[0].length
      const children: typeof inline.children = []
      for (const child of inline.children ?? []) {
        if (remaining <= 0) {
          children.push(child)
          continue
        }
        if (child.type !== 'text') {
          children.push(child)
          continue
        }
        if (child.content.length <= remaining) {
          remaining -= child.content.length
          continue
        }
        const trimmed = Object.create(Object.getPrototypeOf(child))
        Object.assign(trimmed, child)
        trimmed.content = child.content.slice(remaining)
        children.push(trimmed)
        remaining = 0
      }
      inline.children = [
        {
          type: 'html_inline',
          content: `<input type="checkbox" class="task-checkbox"${checked ? ' checked' : ''} disabled>`,
        } as never,
        ...children,
      ]

      // Style the list item itself, not the paragraph inside it.
      tokens[i].attrJoin('class', 'task-list-item')
      paragraphOpen.attrJoin('class', 'task-list-item')
      paragraphClose.attrJoin('class', 'task-list-item')
    }
  })

  // --------------------------------------------------------------- images
  const defaultImage = md.renderer.rules.image
  md.renderer.rules.image = (tokens, idx, options, env, self) => {
    const token = tokens[idx]
    const src = String(token.attrGet('src') ?? '')
    const resolved = ctx.resolveFile(src)
    token.attrSet('src', resolved)
    const alt = token.content
    token.content = alt
    if (!defaultImage) return self.renderToken(tokens, idx, options)
    return (defaultImage as RendererRule).call(
      md.renderer,
      tokens,
      idx,
      options,
      env,
      self,
    )
  }

  // ---------------------------------------------------------------- links
  // markdown-it has no default rule for `link_open` — the renderer falls back
  // to `renderToken` for it — so the rule has to be written out by hand
  // instead of delegating to a non-existent default.
  md.renderer.rules.link_open = (tokens, idx, options, _env, self) => {
    const token = tokens[idx]
    const href = String(token.attrGet('href') ?? '')
    if (isExternal(href)) {
      token.attrSet('target', '_blank')
      token.attrSet('rel', 'noopener noreferrer')
    } else if (href.endsWith('.md')) {
      token.attrSet('data-md-link', href)
    }
    return self.renderToken(tokens, idx, options)
  }

  return md
}

/** Extract the plain-text preview of a note, used for list rows. */
export function plainPreview(content: string, max = 160): string {
  return content
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/^#{1,6}\s+.*$/m, ' ')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
    .replace(/\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g, '$2$1')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/[*_`>#-]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max)
}
