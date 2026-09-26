// JWZ message threading (https://www.jwz.org/doc/threading.html) over Message-ID, References and
// In-Reply-To, with the RFC 5256 base-subject algorithm used for the root-set subject regrouping
// step. Pure and synchronous: no database, no clock other than the dates the caller supplies.

/** One message as the threader needs it. `id` is the caller's own identifier, carried through
 * unchanged onto the output tree; it plays no part in linking (that's `messageId`/`references`/
 * `inReplyTo`, all raw header text, normalized internally). */
export interface ThreadInput {
  id: string;
  messageId?: string;
  inReplyTo?: string;
  references: string[];
  subject: string;
  date: Date;
  from: string;
  to: string;
}

export interface ThreadTree {
  /** The normalized Message-ID this container was keyed by, or a synthetic id for a dummy
   * container (no message of its own) or a duplicate Message-ID's second-and-later message. */
  id: string;
  message: ThreadInput | null;
  children: ThreadTree[];
}

interface Container {
  key: string;
  message: ThreadInput | null;
  parent: Container | null;
  children: Container[];
}

/** Strip a msg-id down to its bare `local@domain`: unfold, trim, drop the enclosing `<...>`. */
export function normalizeMsgId(raw: string): string {
  const unfolded = raw.replace(/\r?\n[ \t]+/g, ' ').trim();
  const bracketed = /^<([^>]*)>$/.exec(unfolded);
  const inner = bracketed?.[1] ?? unfolded;
  return inner.trim();
}

interface SubjectAnalysis {
  base: string;
  isReply: boolean;
}

/** RFC 5256 §2.1 "base subject" algorithm: strip Re:/Fw:/Fwd:/Aw:/Sv: (any bracketed blob, list
 * tag included), a trailing "(fwd)", and unwrap "[fwd: ...]", repeating until nothing changes. */
function analyzeSubject(subjectRaw: string): SubjectAnalysis {
  let s = subjectRaw.replace(/[\t\r\n]+/g, ' ').replace(/ {2,}/g, ' ').trim();
  let isReply = false;
  let changed = true;
  while (changed) {
    changed = false;

    // (2) trailing "(fwd)", repeated.
    for (;;) {
      const trimmedEnd = s.replace(/\s+$/, '');
      const fwdTrailer = /(?:\s*\(fwd\))+$/i.exec(trimmedEnd);
      if (fwdTrailer) {
        s = trimmedEnd.slice(0, fwdTrailer.index).replace(/\s+$/, '');
        changed = true;
        continue;
      }
      if (trimmedEnd !== s) {
        s = trimmedEnd;
        changed = true;
      }
      break;
    }

    // (3)-(5) leading subj-blob*/re-fw-fwd prefixes.
    for (;;) {
      const leadingWs = s.replace(/^\s+/, '');
      if (leadingWs !== s) {
        s = leadingWs;
        changed = true;
      }
      const refwd = /^(?:\[[^[\]]*\]\s*)*(re|fw|fwd|aw|sv)\s*(?:\[[^[\]]*\]\s*)?:\s*/i.exec(s);
      if (refwd) {
        s = s.slice(refwd[0].length);
        isReply = true;
        changed = true;
        continue;
      }
      const blob = /^\[[^[\]]*\]\s*/.exec(s);
      if (blob && s.length > blob[0].length) {
        s = s.slice(blob[0].length);
        changed = true;
        continue;
      }
      break;
    }

    // (6) "[fwd: ...]" wrapper.
    const wrap = /^\[fwd:\s*(.*)\]$/i.exec(s);
    if (wrap?.[1] !== undefined) {
      s = wrap[1];
      isReply = true;
      changed = true;
    }
  }
  return { base: s.toLowerCase(), isReply };
}

/** The normalized (lower-cased) base subject, for comparison and storage. */
export function baseSubject(subject: string): string {
  return analyzeSubject(subject).base;
}

/** `newParent` becomes `newChild`'s parent, unless `newChild` already has a parent (existing
 * links are never disturbed) or doing so would create a cycle. */
function link(newParent: Container, newChild: Container): void {
  if (newParent === newChild) return;
  if (newChild.parent !== null) return;
  if (isDescendant(newChild, newParent)) return; // newParent is already an ancestor of newChild
  newParent.children.push(newChild);
  newChild.parent = newParent;
}

/** Is `target` reachable by walking down `root`'s children? */
function isDescendant(root: Container, target: Container): boolean {
  const stack = [...root.children];
  while (stack.length > 0) {
    const cur = stack.pop();
    if (cur === undefined) continue;
    if (cur === target) return true;
    stack.push(...cur.children);
  }
  return false;
}

/** JWZ step 4: drop message-less, childless containers; promote a message-less container's only
 * child up to its own place; keep a message-less container with more than one child (it may be
 * the only thing holding a set of siblings together once their real parent is confirmed missing). */
function pruneForest(containers: Container[], parent: Container | null): Container[] {
  const result: Container[] = [];
  for (const c of containers) {
    c.children = pruneForest(c.children, c);
    if (c.message === null && c.children.length === 0) continue;
    if (c.message === null && c.children.length === 1) {
      const only = c.children[0];
      if (only !== undefined) {
        only.parent = parent;
        result.push(only);
        continue;
      }
    }
    c.parent = parent;
    result.push(c);
  }
  return result;
}

/** The subject of the first descendant (possibly `c` itself) that carries a message. */
function subjectSource(c: Container): string | null {
  if (c.message !== null) return c.message.subject;
  for (const child of c.children) {
    const s = subjectSource(child);
    if (s !== null) return s;
  }
  return null;
}

let dummyCounter = 0;

/** JWZ step 5: merge root-set members that share a base subject, so replies and forwards thread
 * even when References/In-Reply-To are absent entirely. */
function groupBySubject(root: Container[]): Container[] {
  const infoByContainer = new Map<Container, SubjectAnalysis>();
  for (const c of root) {
    const subj = subjectSource(c);
    if (subj === null) continue;
    const info = analyzeSubject(subj);
    if (info.base === '') continue;
    infoByContainer.set(c, info);
  }

  const table = new Map<string, Container>();
  for (const c of root) {
    const info = infoByContainer.get(c);
    if (info === undefined) continue;
    const existing = table.get(info.base);
    if (existing === undefined) {
      table.set(info.base, c);
      continue;
    }
    const existingIsDummy = existing.message === null;
    const cIsDummy = c.message === null;
    const existingInfo = infoByContainer.get(existing);
    if (cIsDummy && !existingIsDummy) {
      table.set(info.base, c);
    } else if (!cIsDummy && !existingIsDummy && existingInfo?.isReply === true && !info.isReply) {
      table.set(info.base, c);
    }
  }

  const result: Container[] = [];
  const removed = new Set<Container>();
  for (const c of root) {
    if (removed.has(c)) continue;
    const info = infoByContainer.get(c);
    if (info === undefined) {
      result.push(c);
      continue;
    }
    const rep = table.get(info.base);
    if (rep === undefined || rep === c) {
      result.push(c);
      continue;
    }
    const repIsDummy = rep.message === null;
    const cIsDummy = c.message === null;

    if (repIsDummy && cIsDummy) {
      for (const ch of c.children) {
        ch.parent = rep;
        rep.children.push(ch);
      }
      removed.add(c);
    } else if (repIsDummy && !cIsDummy) {
      c.parent = rep;
      rep.children.push(c);
      removed.add(c);
    } else if (!repIsDummy && cIsDummy) {
      // Uncommon: a dummy sharing a subject with an already-chosen message container. Leave it
      // standing rather than guess at a merge direction the spec doesn't define.
      result.push(c);
    } else {
      const repInfo = infoByContainer.get(rep);
      if (repInfo?.isReply === false && info.isReply) {
        c.parent = rep;
        rep.children.push(c);
        removed.add(c);
      } else if (repInfo?.isReply === true && !info.isReply) {
        rep.parent = c;
        c.children.push(rep);
        const idx = result.indexOf(rep);
        if (idx !== -1) result.splice(idx, 1);
        result.push(c);
        removed.add(rep);
        table.set(info.base, c);
      } else {
        const dummy: Container = { key: `\u0000subj:${String(dummyCounter++)}`, message: null, parent: null, children: [] };
        rep.parent = dummy;
        c.parent = dummy;
        dummy.children.push(rep, c);
        const idx = result.indexOf(rep);
        if (idx !== -1) result.splice(idx, 1);
        result.push(dummy);
        removed.add(rep);
        removed.add(c);
        table.set(info.base, dummy);
      }
    }
  }
  return result;
}

function minDate(c: Container): number {
  if (c.message !== null) return c.message.date.getTime();
  let min = Number.POSITIVE_INFINITY;
  for (const child of c.children) min = Math.min(min, minDate(child));
  return min;
}

function sortForest(containers: Container[]): void {
  for (const c of containers) sortForest(c.children);
  containers.sort((a, b) => minDate(a) - minDate(b));
}

function toThreadTree(c: Container): ThreadTree {
  return { id: c.key, message: c.message, children: c.children.map(toThreadTree) };
}

/** Thread a batch of messages. Order of `msgs` is only "arrival order" for the duplicate-Message-ID
 * rule (the later one gets a synthetic id); the output is otherwise date-sorted. Never throws. */
export function threadMessages(msgs: ThreadInput[]): ThreadTree[] {
  const idTable = new Map<string, Container>();
  const allContainers: Container[] = [];
  let syntheticCounter = 0;
  const nextSynthetic = (): string => `\u0000dup:${String(syntheticCounter++)}`;

  const getOrCreatePlaceholder = (key: string): Container => {
    const existing = idTable.get(key);
    if (existing !== undefined) return existing;
    const created: Container = { key, message: null, parent: null, children: [] };
    idTable.set(key, created);
    allContainers.push(created);
    return created;
  };

  for (const msg of msgs) {
    const rawKey = msg.messageId !== undefined ? normalizeMsgId(msg.messageId) : '';
    let container: Container;
    if (rawKey === '') {
      container = { key: nextSynthetic(), message: msg, parent: null, children: [] };
      allContainers.push(container);
    } else {
      const existing = idTable.get(rawKey);
      if (existing !== undefined && existing.message !== null) {
        // Duplicate Message-ID: the later message (in input order) gets its own synthetic id
        // rather than clobbering the first container's message.
        container = { key: nextSynthetic(), message: msg, parent: null, children: [] };
        allContainers.push(container);
      } else if (existing !== undefined) {
        existing.message = msg;
        container = existing;
      } else {
        container = { key: rawKey, message: msg, parent: null, children: [] };
        idTable.set(rawKey, container);
        allContainers.push(container);
      }
    }

    const refChain: string[] = [];
    for (const ref of msg.references) {
      const norm = normalizeMsgId(ref);
      if (norm !== '' && norm !== refChain[refChain.length - 1]) refChain.push(norm);
    }
    if (msg.inReplyTo !== undefined) {
      const norm = normalizeMsgId(msg.inReplyTo);
      if (norm !== '' && norm !== refChain[refChain.length - 1]) refChain.push(norm);
    }

    let prev: Container | null = null;
    for (const key of refChain) {
      const refContainer = getOrCreatePlaceholder(key);
      if (prev !== null) link(prev, refContainer);
      prev = refContainer;
    }
    if (prev !== null) link(prev, container);
  }

  let rootSet = allContainers.filter((c) => c.parent === null);
  rootSet = pruneForest(rootSet, null);
  rootSet = groupBySubject(rootSet);
  sortForest(rootSet);

  return rootSet.map(toThreadTree);
}
