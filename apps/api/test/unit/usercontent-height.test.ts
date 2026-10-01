// PST-T-17.3 (design finding PST-DA-084): the render ticket's height estimate. The frame runs no
// script and lives on another origin, so it can never report its own height; the Newsletters feed
// sizes each frame from this estimate instead. These pin the box model's shape, not exact pixels.
import { describe, expect, it } from 'vitest';
import { estimateHtmlHeight, estimateTextHeight, ESTIMATE_WIDTHS, MAX_ESTIMATE } from '../../src/usercontent/height.js';
import { sanitizeHtml } from '../../src/usercontent/sanitize.js';

const plain = { designed: false };
const paragraph = (n: number): string => `<p>${'All the news that fits, and a little more besides. '.repeat(n)}</p>`;

describe('estimateHtmlHeight', () => {
  it('measures at the two frame widths the client interpolates between', () => {
    expect(ESTIMATE_WIDTHS).toEqual({ narrow: 360, wide: 720 });
  });

  it('gives a one-line plain message a short frame: one 16px/1.6 line and its paragraph margins', () => {
    const { narrow, wide } = estimateHtmlHeight(sanitizeHtml('<p>Hello there, a single line.</p>').html, plain);
    expect(wide).toBe(Math.ceil(16 * 1.6 + 32));
    expect(narrow).toBe(wide);
  });

  it('gives a one-line designed message its 12px page padding at 14px/1.5', () => {
    const { wide } = estimateHtmlHeight('<div>One line.</div>', { designed: true });
    expect(wide).toBe(Math.ceil(14 * 1.5 + 24));
  });

  it('grows with the text, and wraps more in the narrow frame', () => {
    const short = estimateHtmlHeight(paragraph(4), plain);
    const long = estimateHtmlHeight(Array.from({ length: 12 }, () => paragraph(8)).join(''), plain);
    expect(long.wide).toBeGreaterThan(1000);
    expect(long.wide).toBeGreaterThan(short.wide * 5);
    expect(long.narrow).toBeGreaterThan(long.wide * 1.6);
  });

  it('counts a <br> as a line break and stacks block elements', () => {
    expect(estimateHtmlHeight('<div>a</div>', plain).wide).toBe(Math.ceil(16 * 1.6));
    expect(estimateHtmlHeight('<div>a<br>b<br>c</div>', plain).wide).toBe(Math.ceil(3 * 16 * 1.6));
    expect(estimateHtmlHeight('<div>a</div><div>b</div><div>c</div>', plain).wide).toBe(Math.ceil(3 * 16 * 1.6));
  });

  it('gives a hidden preheader nothing', () => {
    const body = '<div>Read this.</div>';
    const preheader = `<div style="display:none;max-height:0;overflow:hidden">${'Preview text '.repeat(40)}</div>`;
    expect(estimateHtmlHeight(sanitizeHtml(preheader + body).html, plain)).toEqual(estimateHtmlHeight(body, plain));
  });

  it('puts table cells side by side when wide and stacks them when narrow (NARROW_FIT_STYLE)', () => {
    const cell = `<td>${'word '.repeat(60)}</td>`;
    const cellAlone = estimateHtmlHeight(`<table><tr>${cell}</tr></table>`, plain);
    const twoCells = estimateHtmlHeight(`<table width="600"><tr>${cell}${cell}</tr></table>`, plain);
    // Side by side, each cell is half as wide, so each wraps to about twice the lines — not four times.
    expect(twoCells.wide).toBeLessThan(cellAlone.wide * 3);
    // Linearised, the row is both cells, one under the other.
    expect(twoCells.narrow).toBeGreaterThanOrEqual(cellAlone.narrow * 2 - 8);
  });

  it('honours declared heights and vertical padding', () => {
    const spacer = estimateHtmlHeight('<table cellpadding="0" cellspacing="0"><tr><td height="40"></td></tr></table>', plain).wide;
    expect(spacer).toBe(40);
    const padded = estimateHtmlHeight('<div style="padding:20px 10px">x</div>', plain).wide;
    expect(padded).toBe(Math.ceil(16 * 1.6 + 40));
  });

  it('sizes an image from its declared box, scaled to fit the frame', () => {
    const loaded = (attrs: string): number => estimateHtmlHeight(`<img src="cid:a" ${attrs}>`, plain).wide;
    expect(loaded('width="600" height="300"')).toBe(300);
    // Wider than the frame: max-width:100% scales it down with its aspect ratio.
    expect(loaded('width="1440" height="720"')).toBe(360);
    expect(loaded('style="height:120px"')).toBe(120);
    // A blocked remote image is the 1×1 placeholder: height:auto gives it the placeholder's square.
    const blocked = sanitizeHtml('<img src="https://img.example/banner.png" width="300" height="100">').html;
    expect(estimateHtmlHeight(blocked, plain).wide).toBe(300);
    expect(estimateHtmlHeight(blocked, { designed: false, images: true }).wide).toBe(100);
  });

  it('measures headings at their own size', () => {
    expect(estimateHtmlHeight('<h1>Big news</h1>', plain).wide).toBeGreaterThan(estimateHtmlHeight('<p>Big news</p>', plain).wide);
  });

  it('is a whole number of pixels, never above MAX_ESTIMATE', () => {
    const huge = estimateHtmlHeight(Array.from({ length: 4000 }, () => paragraph(10)).join(''), plain);
    expect(huge.wide).toBe(MAX_ESTIMATE);
    const some = estimateHtmlHeight(paragraph(3), { designed: true });
    expect(Number.isInteger(some.wide)).toBe(true);
    expect(Number.isInteger(some.narrow)).toBe(true);
  });

  it('never throws on unbalanced or odd markup', () => {
    for (const html of ['', '</p>', '<table><td>x', '<ul><li>a<li>b</ul>', '<details><summary>More</summary><p>hidden</p></details>', '<font size="9">x</font>']) {
      const { narrow, wide } = estimateHtmlHeight(sanitizeHtml(html).html, plain);
      expect(narrow).toBeGreaterThanOrEqual(0);
      expect(wide).toBeGreaterThanOrEqual(0);
    }
    expect(estimateHtmlHeight('', plain)).toEqual({ narrow: 0, wide: 0 });
  });
});

describe('estimateTextHeight', () => {
  it('measures a text body as the <pre> it is served in: one line per line, plus its margins', () => {
    expect(estimateTextHeight('Issue one.').wide).toBe(Math.ceil(16 * 1.6 + 32));
    expect(estimateTextHeight('Issue one.\n').wide).toBe(Math.ceil(16 * 1.6 + 32));
    expect(estimateTextHeight('a\n\nb').wide).toBe(Math.ceil(3 * 16 * 1.6 + 32));
    const forty = Array.from({ length: 40 }, (_, i) => `Line ${String(i)}`).join('\n');
    expect(estimateTextHeight(forty).wide).toBe(Math.ceil(40 * 16 * 1.6 + 32));
  });
});
