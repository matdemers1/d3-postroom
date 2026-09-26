// The component tree (RFC 5545 §3.4–§3.6): BEGIN/END nesting with bounded input size, line count
// and depth, and a serializer whose output re-parses to a deep-equal tree.
import { ICalLimitError, ICalParseError } from './errors.js';
import { decodeInput, fold, formatContentLine, parseContentLine, unfold, type Params } from './lexer.js';

export interface Property {
  /** Upper-cased name, e.g. `DTSTART`. */
  name: string;
  params: Params;
  /** Raw value as it appeared on the wire (after unfolding); decode with the value helpers. */
  value: string;
}

export interface Component {
  /** Upper-cased name, e.g. `VCALENDAR`, `VEVENT`, `X-FOO`. */
  name: string;
  properties: Property[];
  components: Component[];
}

export interface ParseOptions {
  /** Maximum input size in bytes (UTF-8). Default 4 MiB. */
  maxBytes?: number;
  /** Maximum component nesting depth (VCALENDAR › VEVENT › VALARM is 3). Default 8. */
  maxDepth?: number;
  /** Maximum number of content lines. Default 100 000. */
  maxLines?: number;
}

export const DEFAULT_MAX_BYTES = 4 * 1024 * 1024;
export const DEFAULT_MAX_DEPTH = 8;
export const DEFAULT_MAX_LINES = 100_000;

/** Parse every top-level component in the input (usually exactly one VCALENDAR). */
export function parseICalendarAll(input: string | Uint8Array, options: ParseOptions = {}): Component[] {
  const maxDepth = options.maxDepth ?? DEFAULT_MAX_DEPTH;
  const text = decodeInput(input, options.maxBytes ?? DEFAULT_MAX_BYTES);
  const lines = unfold(text, options.maxLines ?? DEFAULT_MAX_LINES);
  const roots: Component[] = [];
  const stack: Component[] = [];
  for (const { text: raw, line } of lines) {
    const cl = parseContentLine(raw, line);
    if (cl.name === 'BEGIN') {
      const name = componentName(cl.value, line);
      if (stack.length >= maxDepth) throw new ICalLimitError(`components nested deeper than ${String(maxDepth)}`);
      const comp: Component = { name, properties: [], components: [] };
      const parent = stack[stack.length - 1];
      if (parent === undefined) roots.push(comp);
      else parent.components.push(comp);
      stack.push(comp);
    } else if (cl.name === 'END') {
      const name = componentName(cl.value, line);
      const open = stack.pop();
      if (open === undefined) throw new ICalParseError(`END:${name} with no open component`, line);
      if (open.name !== name) throw new ICalParseError(`END:${name} closes BEGIN:${open.name}`, line);
    } else {
      const open = stack[stack.length - 1];
      if (open === undefined) throw new ICalParseError(`property ${cl.name} outside any component`, line);
      open.properties.push({ name: cl.name, params: cl.params, value: cl.value });
    }
  }
  const unclosed = stack[stack.length - 1];
  if (unclosed !== undefined) throw new ICalParseError(`BEGIN:${unclosed.name} is never closed`);
  return roots;
}

/** Parse input that must hold exactly one top-level component (a CalDAV calendar object resource). */
export function parseICalendar(input: string | Uint8Array, options: ParseOptions = {}): Component {
  const roots = parseICalendarAll(input, options);
  const [first] = roots;
  if (first === undefined) throw new ICalParseError('no component in input');
  if (roots.length > 1) throw new ICalParseError(`expected one top-level component, found ${String(roots.length)}`);
  return first;
}

function componentName(value: string, line: number): string {
  const name = value.trim().toUpperCase();
  if (!/^[A-Z0-9-]+$/.test(name)) throw new ICalParseError(`invalid component name "${value.slice(0, 40)}"`, line);
  return name;
}

/** Serialise components with CRLF line endings, folded at 75 octets, ending in CRLF. */
export function serializeICalendar(input: Component | Component[]): string {
  const out: string[] = [];
  const walk = (c: Component, depth: number): void => {
    if (depth > 64) throw new ICalLimitError('component tree too deep to serialise');
    if (!/^[A-Z0-9-]+$/i.test(c.name)) throw new ICalParseError(`invalid component name "${c.name.slice(0, 40)}"`);
    out.push(`BEGIN:${c.name.toUpperCase()}`);
    for (const p of c.properties) {
      if (!/^[A-Za-z0-9-]+$/.test(p.name) || /^(BEGIN|END)$/i.test(p.name)) {
        throw new ICalParseError(`invalid property name "${p.name.slice(0, 40)}"`);
      }
      for (const pname of Object.keys(p.params)) {
        if (!/^[A-Za-z0-9-]+$/.test(pname)) throw new ICalParseError(`invalid parameter name "${pname.slice(0, 40)}"`);
      }
      out.push(fold(formatContentLine(p)));
    }
    for (const child of c.components) walk(child, depth + 1);
    out.push(`END:${c.name.toUpperCase()}`);
  };
  for (const c of Array.isArray(input) ? input : [input]) walk(c, 0);
  return out.map((l) => `${l}\r\n`).join('');
}

/** First property with this name, or undefined. */
export function getProperty(comp: Component, name: string): Property | undefined {
  const upper = name.toUpperCase();
  return comp.properties.find((p) => p.name === upper);
}

/** Every property with this name, in document order. */
export function getProperties(comp: Component, name: string): Property[] {
  const upper = name.toUpperCase();
  return comp.properties.filter((p) => p.name === upper);
}

/** First value of a parameter, or undefined. */
export function getParam(prop: Property, name: string): string | undefined {
  return prop.params[name.toUpperCase()]?.[0];
}

/** Direct child components with this name. */
export function getComponents(comp: Component, name: string): Component[] {
  const upper = name.toUpperCase();
  return comp.components.filter((c) => c.name === upper);
}
