// A hand-written CommonMark-subset renderer for the composer (PST-T-9.2, PST-REQ-145). Safe by
// construction, not by filtering: every raw character the source contains is HTML-escaped before it
// is ever placed inside an output tag, so there is no code path that can put a `<script`, an `on*`
// attribute, a `style` element or a `javascript:` URL into the rendered document — those strings can
// only ever appear as literal escaped text. The only places we emit an attribute value ourselves
// (`href` on a link) are built from an input that was already checked to be `https:`, `mailto:` or a
// bare autolink, never from unescaped source.
//
// Supported: paragraphs, *emphasis*/**strong** (including nesting), `inline code`, fenced code
// blocks, ATX headings (# … ######), lists (- / * / 1.), blockquotes (>), links [text](url) and bare
// http(s)/mailto autolinks. Anything else (raw HTML, images, reference links, tables) is left as
// plain escaped text — this is a subset, not a full CommonMark implementation, and never falls back
// to passing bytes through unescaped (PST-REQ-174: no image or link is ever added that the user did
// not write).

/** Escape the five characters that matter for both text nodes and (quoted) attribute values. */
function escapeHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

/** A URL this renderer will ever put in an href: https, http, or mailto — never javascript:, data:, or anything else. */
function safeHref(url: string): string | null {
  const trimmed = url.trim();
  // Strip surrounding <...> the way CommonMark link destinations allow.
  const inner = trimmed.startsWith('<') && trimmed.endsWith('>') ? trimmed.slice(1, -1) : trimmed;
  if (/^https?:\/\/[^\s<>"']+$/i.test(inner)) return inner;
  if (/^mailto:[^\s<>"']+$/i.test(inner)) return inner;
  return null;
}

const AUTOLINK = /\b(?:https?:\/\/|mailto:)[^\s<>()[\]"']+[^\s<>()[\].,!?;:"']/gi;

/** Inline spans: emphasis, strong, inline code, links, autolinks. Everything else is escaped text. */
function renderInline(text: string): string {
  // Tokens: `code`, [text](url), **strong**, *em*, autolinks, or plain runs. Processed left to right,
  // non-overlapping, and each token's own text content is itself recursively rendered (except code,
  // which is always literal) — so nesting like **_x_** or [**bold**](url) works, and nothing raw
  // ever reaches the output un-escaped.
  const out: string[] = [];
  let i = 0;
  const n = text.length;
  while (i < n) {
    const rest = text.slice(i);

    // Inline code: `...` — contents are never interpreted further, only escaped.
    const code = /^`([^`]+)`/.exec(rest);
    if (code !== null) {
      out.push(`<code>${escapeHtml(code[1] ?? '')}</code>`);
      i += code[0].length;
      continue;
    }

    // Link: [text](https://... | mailto:...)
    const link = /^\[([^\]]*)\]\(([^)\s]+)\)/.exec(rest);
    if (link !== null) {
      const href = safeHref(link[2] ?? '');
      if (href !== null) {
        out.push(`<a href="${escapeHtml(href)}">${renderInline(link[1] ?? '')}</a>`);
        i += link[0].length;
        continue;
      }
      // Not a safe destination: render as literal escaped text, not a link.
    }

    // Strong: **...** or __...__
    const strong = /^(\*\*|__)([\s\S]+?)\1/.exec(rest);
    if (strong !== null) {
      out.push(`<strong>${renderInline(strong[2] ?? '')}</strong>`);
      i += strong[0].length;
      continue;
    }

    // Emphasis: *...* or _..._ (single, not immediately re-matching strong's delimiter run)
    const em = /^(\*|_)([^\s*_][\s\S]*?)\1/.exec(rest);
    if (em !== null) {
      out.push(`<em>${renderInline(em[2] ?? '')}</em>`);
      i += em[0].length;
      continue;
    }

    // A bare autolink at this position.
    AUTOLINK.lastIndex = 0;
    const auto = AUTOLINK.exec(rest);
    if (auto !== null && auto.index === 0) {
      const href = safeHref(auto[0]);
      if (href !== null) {
        out.push(`<a href="${escapeHtml(href)}">${escapeHtml(auto[0])}</a>`);
        i += auto[0].length;
        continue;
      }
    }

    // No special construct here: consume one character of plain text (escaped) and continue. This
    // is what guarantees termination and what guarantees nothing un-escaped ever survives: every
    // branch above either matches a whole safe construct or we fall through to here one char at a
    // time.
    out.push(escapeHtml(rest[0] ?? ''));
    i += 1;
  }
  return out.join('');
}

interface Block {
  readonly kind: 'heading' | 'paragraph' | 'code' | 'quote' | 'ul' | 'ol' | 'hr';
  readonly level?: number;
  readonly lines: string[];
  readonly lang?: string;
}

/** Split normalised source into block-level chunks (a light CommonMark subset, not a full parser). */
function parseBlocks(source: string): Block[] {
  const lines = source.replace(/\r\n?/g, '\n').split('\n');
  const blocks: Block[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i] ?? '';

    if (line.trim() === '') {
      i += 1;
      continue;
    }

    // Fenced code block: ``` or ~~~, until a matching closing fence or EOF.
    const fence = /^(```|~~~)(.*)$/.exec(line);
    if (fence !== null) {
      const marker = fence[1] as string;
      const lang = (fence[2] ?? '').trim();
      const body: string[] = [];
      i += 1;
      while (i < lines.length && lines[i]?.trimEnd() !== marker) {
        body.push(lines[i] ?? '');
        i += 1;
      }
      i += 1; // consume the closing fence, if any
      blocks.push({ kind: 'code', lines: body, lang });
      continue;
    }

    // ATX heading: # … ###### text
    const heading = /^(#{1,6})\s+(.*)$/.exec(line);
    if (heading !== null) {
      blocks.push({ kind: 'heading', level: (heading[1] as string).length, lines: [(heading[2] ?? '').trim()] });
      i += 1;
      continue;
    }

    // Horizontal rule: a line of three or more -, * or _ and nothing else.
    if (/^(?:-{3,}|\*{3,}|_{3,})$/.test(line.trim())) {
      blocks.push({ kind: 'hr', lines: [] });
      i += 1;
      continue;
    }

    // Blockquote: consecutive lines starting with >
    if (/^>\s?/.test(line)) {
      const body: string[] = [];
      while (i < lines.length && /^>\s?/.test(lines[i] ?? '')) {
        body.push((lines[i] ?? '').replace(/^>\s?/, ''));
        i += 1;
      }
      blocks.push({ kind: 'quote', lines: body });
      continue;
    }

    // Unordered list: consecutive lines starting with -, * or + followed by a space.
    if (/^[-*+]\s+/.test(line)) {
      const items: string[] = [];
      while (i < lines.length && /^[-*+]\s+/.test(lines[i] ?? '')) {
        items.push((lines[i] ?? '').replace(/^[-*+]\s+/, ''));
        i += 1;
      }
      blocks.push({ kind: 'ul', lines: items });
      continue;
    }

    // Ordered list: consecutive lines starting with a number, ".", space.
    if (/^\d+\.\s+/.test(line)) {
      const items: string[] = [];
      while (i < lines.length && /^\d+\.\s+/.test(lines[i] ?? '')) {
        items.push((lines[i] ?? '').replace(/^\d+\.\s+/, ''));
        i += 1;
      }
      blocks.push({ kind: 'ol', lines: items });
      continue;
    }

    // Paragraph: consecutive non-blank, non-special lines, joined with a space.
    const body: string[] = [];
    while (i < lines.length && (lines[i] ?? '').trim() !== '' && !/^(```|~~~|#{1,6}\s|>|[-*+]\s|\d+\.\s)/.test(lines[i] ?? '') && !/^(?:-{3,}|\*{3,}|_{3,})$/.test((lines[i] ?? '').trim())) {
      body.push(lines[i] ?? '');
      i += 1;
    }
    blocks.push({ kind: 'paragraph', lines: body });
  }
  return blocks;
}

function renderBlock(block: Block): string {
  switch (block.kind) {
    case 'heading': {
      const level = block.level ?? 1;
      return `<h${String(level)}>${renderInline(block.lines[0] ?? '')}</h${String(level)}>`;
    }
    case 'code':
      // Code content is only ever escaped, never interpreted as Markdown or HTML.
      return `<pre><code>${escapeHtml(block.lines.join('\n'))}</code></pre>`;
    case 'quote':
      return `<blockquote>${block.lines.map((l) => renderInline(l)).join('<br>')}</blockquote>`;
    case 'ul':
      return `<ul>${block.lines.map((l) => `<li>${renderInline(l)}</li>`).join('')}</ul>`;
    case 'ol':
      return `<ol>${block.lines.map((l) => `<li>${renderInline(l)}</li>`).join('')}</ol>`;
    case 'hr':
      return '<hr>';
    case 'paragraph':
    default:
      return `<p>${block.lines.map((l) => renderInline(l)).join('<br>')}</p>`;
  }
}

/**
 * Render Markdown to a minimal, sanitized HTML fragment: no `<script>`, `<iframe>`, `<style>`, no
 * `on*` handler attribute, no `javascript:` URL — because the renderer's grammar has no code path
 * that can emit them; every raw source character not consumed by a recognised construct is
 * HTML-escaped. Never adds an image or a link the user did not write (PST-REQ-174).
 */
export function renderMarkdown(source: string): string {
  return parseBlocks(source).map(renderBlock).join('\n');
}

/** The rendered fragment wrapped as a minimal standalone document: no external resources, no `<style>`. */
export function renderMarkdownDocument(source: string): string {
  return `<!doctype html>\n<html><head><meta charset="utf-8"></head><body>${renderMarkdown(source)}</body></html>`;
}
