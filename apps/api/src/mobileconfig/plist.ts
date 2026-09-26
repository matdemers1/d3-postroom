// A minimal, hand-rolled Apple property-list (plist) XML writer (PST-T-8.6). Only the subset a
// configuration profile needs: dict, array, string, integer, boolean and data. No external
// dependency — the point of this project is to understand every part.
export type PlistValue = string | number | boolean | Uint8Array | readonly PlistValue[] | { readonly [key: string]: PlistValue };

/** Escapes the three characters that are ever special inside XML 1.0 element text. */
export function escapeXml(value: string): string {
  return value.replace(/[&<>]/g, (char) => {
    switch (char) {
      case '&':
        return '&amp;';
      case '<':
        return '&lt;';
      default:
        return '&gt;';
    }
  });
}

function isDict(value: PlistValue): value is { readonly [key: string]: PlistValue } {
  return typeof value === 'object' && !Array.isArray(value) && !(value instanceof Uint8Array);
}

function renderValue(value: PlistValue, indent: string): string {
  if (typeof value === 'string') return `${indent}<string>${escapeXml(value)}</string>\n`;
  if (typeof value === 'boolean') return `${indent}<${value ? 'true' : 'false'}/>\n`;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error('plist number must be finite');
    return Number.isInteger(value) ? `${indent}<integer>${String(value)}</integer>\n` : `${indent}<real>${String(value)}</real>\n`;
  }
  if (value instanceof Uint8Array) return `${indent}<data>${Buffer.from(value).toString('base64')}</data>\n`;
  if (Array.isArray(value)) {
    if (value.length === 0) return `${indent}<array/>\n`;
    const inner = value.map((item: PlistValue) => renderValue(item, `${indent}  `)).join('');
    return `${indent}<array>\n${inner}${indent}</array>\n`;
  }
  if (isDict(value)) {
    const entries = Object.entries(value);
    if (entries.length === 0) return `${indent}<dict/>\n`;
    const inner = entries.map(([key, val]) => `${indent}  <key>${escapeXml(key)}</key>\n${renderValue(val, `${indent}  `)}`).join('');
    return `${indent}<dict>\n${inner}${indent}</dict>\n`;
  }
  throw new Error('unsupported plist value');
}

/** A complete plist document: XML declaration, the Apple DOCTYPE, and one root value. */
export function writePlist(root: PlistValue): string {
  const body = renderValue(root, '');
  return (
    '<?xml version="1.0" encoding="UTF-8"?>\n' +
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n' +
    '<plist version="1.0">\n' +
    body +
    '</plist>\n'
  );
}
