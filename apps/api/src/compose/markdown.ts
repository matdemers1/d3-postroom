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

// Sticky (never re-slicing) autolink matcher: `lastIndex` is set to the position under test and a
// sticky ("y") match must start exactly there, so a miss costs O(1) instead of scanning forward.
const AUTOLINK = /(?:https?:\/\/|mailto:)[^\s<>()[\]"']+[^\s<>()[\].,!?;:"']/iy;

/** A run of whitespace characters, used only to build the "next stop" table below. */
const WHITESPACE = /\s/;

/**
 * For every position `0..text.length`, the index of the next occurrence of `ch` at or after that
 * position (or -1). Built once per `renderInline` call in a single backward pass, so every lookup
 * used while scanning is O(1) — the fix for the confirmed quadratic blowup where bracket/delimiter
 * matching re-slicing and re-scanning `text` from every position made a 100 KB adversarial input
 * take seconds.
 */
function nextOccurrenceTable(text: string, ch: string): Int32Array {
  const n = text.length;
  const table = new Int32Array(n + 1);
  table[n] = -1;
  for (let i = n - 1; i >= 0; i -= 1) table[i] = text[i] === ch ? i : (table[i + 1] as number);
  return table;
}

/** Like {@link nextOccurrenceTable}, but for the next `)` or whitespace character (a link destination's end). */
function nextParenStopTable(text: string): Int32Array {
  const n = text.length;
  const table = new Int32Array(n + 1);
  table[n] = -1;
  for (let i = n - 1; i >= 0; i -= 1) table[i] = text[i] === ')' || WHITESPACE.test(text[i] as string) ? i : (table[i + 1] as number);
  return table;
}

/** Like {@link nextOccurrenceTable}, but for the next place two `ch` characters occur back to back (`**` or `__`). */
function nextDoubledTable(text: string, ch: string): Int32Array {
  const n = text.length;
  const table = new Int32Array(n + 1);
  table[n] = -1;
  for (let i = n - 1; i >= 0; i -= 1) table[i] = text[i] === ch && text[i + 1] === ch ? i : (table[i + 1] as number);
  return table;
}

const MAX_INLINE_DEPTH = 32;

/**
 * Inline spans: emphasis, strong, inline code, links, autolinks. Everything else is escaped text.
 *
 * Every character is visited a bounded number of times: six lookup tables (one backward O(n) pass
 * each) answer "where does the next `]`/`` ` ``/`**`/`__`/`*`/`_` occur" in O(1), so bracket matching,
 * delimiter-run scanning and link-destination scanning never rescan `text` from the current
 * position the way naive regex-on-a-shrinking-slice did. Recursion into a matched span's own
 * content is capped at {@link MAX_INLINE_DEPTH} — beyond it the remaining text is escaped literally
 * rather than re-parsed, bounding worst-case nesting.
 */
function renderInline(text: string, depth = 0): string {
  const n = text.length;
  if (n === 0) return '';
  if (depth >= MAX_INLINE_DEPTH) return escapeHtml(text);

  const nextBacktick = nextOccurrenceTable(text, '`');
  const nextCloseBracket = nextOccurrenceTable(text, ']');
  const nextParenStop = nextParenStopTable(text);
  const nextStarStar = nextDoubledTable(text, '*');
  const nextUnderUnder = nextDoubledTable(text, '_');
  const nextStar = nextOccurrenceTable(text, '*');
  const nextUnder = nextOccurrenceTable(text, '_');

  const out: string[] = [];
  let i = 0;
  while (i < n) {
    const ch = text[i] as string;

    // Inline code: `...` — contents are never interpreted further, only escaped. The closing
    // backtick must not be immediately adjacent (the content is at least one character, and never
    // itself contains a backtick, exactly like the original `` `([^`]+)` `` ).
    if (ch === '`') {
      const close = nextBacktick[i + 1] ?? -1;
      if (close > i + 1) {
        out.push(`<code>${escapeHtml(text.slice(i + 1, close))}</code>`);
        i = close + 1;
        continue;
      }
    }

    // Link: [text](https://... | mailto:...)
    if (ch === '[') {
      const closeBracket = nextCloseBracket[i + 1] ?? -1;
      if (closeBracket !== -1 && text[closeBracket + 1] === '(') {
        const urlStart = closeBracket + 2;
        const stop = nextParenStop[urlStart] ?? -1;
        if (stop > urlStart && text[stop] === ')') {
          const href = safeHref(text.slice(urlStart, stop));
          if (href !== null) {
            out.push(`<a href="${escapeHtml(href)}">${renderInline(text.slice(i + 1, closeBracket), depth + 1)}</a>`);
            i = stop + 1;
            continue;
          }
        }
      }
      // No safe, well-formed destination found: render `[` as literal text, not a link.
    }

    // Strong: **...** or __...__ — content is at least one character (an immediately-adjacent
    // closing pair, i.e. empty content, is skipped in favour of the next one, exactly like the
    // original lazy `[\s\S]+?` backtracking past a zero-length match).
    if ((ch === '*' || ch === '_') && text[i + 1] === ch) {
      const table = ch === '*' ? nextStarStar : nextUnderUnder;
      let close = table[i + 2] ?? -1;
      if (close === i + 2) close = table[i + 3] ?? -1;
      if (close !== -1 && close > i + 2) {
        out.push(`<strong>${renderInline(text.slice(i + 2, close), depth + 1)}</strong>`);
        i = close + 2;
        continue;
      }
    }

    // Emphasis: *...* or _..._ (single; the first content character may not be whitespace, `*` or `_`).
    if (ch === '*' || ch === '_') {
      const firstContent = text[i + 1];
      if (firstContent !== undefined && firstContent !== '*' && firstContent !== '_' && !WHITESPACE.test(firstContent)) {
        const table = ch === '*' ? nextStar : nextUnder;
        const close = table[i + 2] ?? -1;
        if (close !== -1) {
          out.push(`<em>${renderInline(text.slice(i + 1, close), depth + 1)}</em>`);
          i = close + 1;
          continue;
        }
      }
    }

    // A bare autolink at this position — sticky, so a miss is O(1), never a forward scan.
    AUTOLINK.lastIndex = i;
    const auto = AUTOLINK.exec(text);
    if (auto !== null) {
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
    out.push(escapeHtml(ch));
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
