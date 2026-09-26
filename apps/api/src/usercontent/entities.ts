// Character references (HTML Living Standard §13.2.5.72–80), decoded the way a browser would for the
// cases mail actually uses. The full named table has 2,231 entries; this one carries the ones mail
// senders write. An unknown name is left as literal text — the sanitizer then escapes its `&`, so the
// reader sees "&foo;" rather than a guess. That is a rendering difference, never a safety one: what
// the browser parses is always the sanitizer's own output, not the sender's.

const NAMED: Record<string, string> = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', copy: '©', reg: '®',
  trade: '™', hellip: '…', mdash: '—', ndash: '–', lsquo: '‘', rsquo: '’',
  sbquo: '‚', ldquo: '“', rdquo: '”', bdquo: '„', bull: '•', middot: '·',
  euro: '€', pound: '£', yen: '¥', cent: '¢', curren: '¤', sect: '§',
  para: '¶', deg: '°', plusmn: '±', times: '×', divide: '÷', frac12: '½',
  frac14: '¼', frac34: '¾', laquo: '«', raquo: '»', lsaquo: '‹', rsaquo: '›',
  iexcl: '¡', iquest: '¿', shy: '­', macr: '¯', acute: '´', micro: 'µ',
  cedil: '¸', ordf: 'ª', ordm: 'º', sup1: '¹', sup2: '²', sup3: '³',
  uml: '¨', not: '¬', brvbar: '¦', dagger: '†', Dagger: '‡', permil: '‰',
  prime: '′', Prime: '″', larr: '←', uarr: '↑', rarr: '→', darr: '↓',
  harr: '↔', check: '✓', hearts: '♥', zwnj: '‌', zwj: '‍', lrm: '‎',
  rlm: '‏', ensp: ' ', emsp: ' ', thinsp: ' ', hairsp: ' ', colon: ':',
  semi: ';', comma: ',', period: '.', excl: '!', quest: '?', lpar: '(', rpar: ')', equals: '=',
  sol: '/', bsol: '\\', num: '#', dollar: '$', percnt: '%', ast: '*', plus: '+', commat: '@',
  lowbar: '_', grave: '`', lbrack: '[', rbrack: ']', lcub: '{', rcub: '}', verbar: '|', tilde: '˜',
  circ: 'ˆ', NewLine: '\n', Tab: '\t',
  Agrave: 'À', Aacute: 'Á', Acirc: 'Â', Atilde: 'Ã', Auml: 'Ä', Aring: 'Å',
  AElig: 'Æ', Ccedil: 'Ç', Egrave: 'È', Eacute: 'É', Ecirc: 'Ê', Euml: 'Ë',
  Igrave: 'Ì', Iacute: 'Í', Icirc: 'Î', Iuml: 'Ï', ETH: 'Ð', Ntilde: 'Ñ',
  Ograve: 'Ò', Oacute: 'Ó', Ocirc: 'Ô', Otilde: 'Õ', Ouml: 'Ö', Oslash: 'Ø',
  Ugrave: 'Ù', Uacute: 'Ú', Ucirc: 'Û', Uuml: 'Ü', Yacute: 'Ý', THORN: 'Þ',
  szlig: 'ß', agrave: 'à', aacute: 'á', acirc: 'â', atilde: 'ã', auml: 'ä',
  aring: 'å', aelig: 'æ', ccedil: 'ç', egrave: 'è', eacute: 'é', ecirc: 'ê',
  euml: 'ë', igrave: 'ì', iacute: 'í', icirc: 'î', iuml: 'ï', eth: 'ð',
  ntilde: 'ñ', ograve: 'ò', oacute: 'ó', ocirc: 'ô', otilde: 'õ', ouml: 'ö',
  oslash: 'ø', ugrave: 'ù', uacute: 'ú', ucirc: 'û', uuml: 'ü', yacute: 'ý',
  thorn: 'þ', yuml: 'ÿ', Yuml: 'Ÿ', OElig: 'Œ', oelig: 'œ', Scaron: 'Š',
  scaron: 'š', fnof: 'ƒ', alpha: 'α', beta: 'β', gamma: 'γ', delta: 'δ',
  pi: 'π', mu: 'μ', sigma: 'σ', omega: 'ω', Omega: 'Ω', infin: '∞',
  ne: '≠', le: '≤', ge: '≥', asymp: '≈', minus: '−', radic: '√',
  sum: '∑', loz: '◊', spades: '♠', clubs: '♣', diams: '♦', oline: '‾',
};

/** The names a browser decodes even without the trailing semicolon (the common legacy ones). */
const LEGACY = new Set(['amp', 'lt', 'gt', 'quot', 'nbsp', 'copy', 'reg', 'AMP', 'LT', 'GT', 'QUOT', 'COPY', 'REG']);
const UPPER_ALIASES: Record<string, string> = { AMP: '&', LT: '<', GT: '>', QUOT: '"', COPY: '©', REG: '®' };

/** §13.2.5.80: C1 numeric references are read as windows-1252. */
const WIN1252: Record<number, number> = {
  0x80: 0x20ac, 0x82: 0x201a, 0x83: 0x0192, 0x84: 0x201e, 0x85: 0x2026, 0x86: 0x2020, 0x87: 0x2021,
  0x88: 0x02c6, 0x89: 0x2030, 0x8a: 0x0160, 0x8b: 0x2039, 0x8c: 0x0152, 0x8e: 0x017d, 0x91: 0x2018,
  0x92: 0x2019, 0x93: 0x201c, 0x94: 0x201d, 0x95: 0x2022, 0x96: 0x2013, 0x97: 0x2014, 0x98: 0x02dc,
  0x99: 0x2122, 0x9a: 0x0161, 0x9b: 0x203a, 0x9c: 0x0153, 0x9e: 0x017e, 0x9f: 0x0178,
};

function fromCodePoint(cp: number): string {
  if (cp === 0 || cp > 0x10ffff || (cp >= 0xd800 && cp <= 0xdfff)) return '�';
  return String.fromCodePoint(WIN1252[cp] ?? cp);
}

const REF = /&(?:#[xX]([0-9a-fA-F]{1,8});?|#([0-9]{1,10});?|([A-Za-z][A-Za-z0-9]{0,31})(;?))/g;

/**
 * Decodes character references. In an attribute value, a legacy name without its semicolon that is
 * followed by `=` or an alphanumeric stays literal (§13.2.5.73), which keeps `?a=1&copy=2` intact.
 */
export function decodeEntities(input: string, inAttribute: boolean): string {
  if (!input.includes('&')) return input;
  return input.replace(REF, (whole, hex: string | undefined, dec: string | undefined, name: string | undefined, semi: string, offset: number) => {
    if (hex !== undefined) return fromCodePoint(Number.parseInt(hex, 16));
    if (dec !== undefined) return fromCodePoint(Number.parseInt(dec, 10));
    if (name === undefined) return whole;
    if (semi === ';') {
      const value = NAMED[name] ?? UPPER_ALIASES[name];
      return value ?? whole;
    }
    if (!LEGACY.has(name)) return whole;
    if (inAttribute) {
      const next = input.charAt(offset + whole.length);
      if (next === '=' || /[A-Za-z0-9]/.test(next)) return whole;
    }
    return NAMED[name] ?? UPPER_ALIASES[name] ?? whole;
  });
}
