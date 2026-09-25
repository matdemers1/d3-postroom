// PROXY protocol v2 encoder/decoder and the peer-trust rule (PST-REQ-016).
//
// Spec: https://www.haproxy.org/download/1.8/doc/proxy-protocol.txt
//
// The edge forwarder is pure L4 (PST-REQ-013): it never parses TLS or SMTP, it only prefixes the
// forwarded TCP stream with this binary header so the home side learns the real client address.
import type { Socket } from 'node:net';

export const PACKAGE = '@postroom/proxy-protocol';

const SIGNATURE = Buffer.from([
  0x0d, 0x0a, 0x0d, 0x0a, 0x00, 0x0d, 0x0a, 0x51, 0x55, 0x49, 0x54, 0x0a,
]);

export const PP2_VERSION = 0x20;

export type ProxyCommand = 'LOCAL' | 'PROXY';
export type ProxyFamily = 'TCP4' | 'TCP6' | 'UNSPEC';

const COMMAND_BITS: Record<ProxyCommand, number> = {
  LOCAL: 0x00,
  PROXY: 0x01,
};

const COMMAND_BY_BITS: Record<number, ProxyCommand> = {
  0x00: 'LOCAL',
  0x01: 'PROXY',
};

// fam/proto byte: high nibble = family, low nibble = protocol. We only ever produce/accept the
// stream (TCP) protocol, but decode any low nibble for forward compatibility (unrecognised proto
// combinations we can't interpret addresses for are rejected).
const FAM_BITS: Record<ProxyFamily, number> = {
  UNSPEC: 0x00,
  TCP4: 0x10,
  TCP6: 0x20,
};

const FAM_BY_BITS: Record<number, ProxyFamily> = {
  0x00: 'UNSPEC',
  0x10: 'TCP4',
  0x20: 'TCP6',
};

const PROTO_STREAM = 0x01;

export interface ProxyEndpoint {
  readonly address: string;
  readonly port: number;
}

export interface ProxyTlv {
  readonly type: number;
  readonly value: Buffer;
}

export interface ProxyHeader {
  readonly command: ProxyCommand;
  readonly family: ProxyFamily;
  readonly source?: ProxyEndpoint;
  readonly destination?: ProxyEndpoint;
  readonly tlvs: readonly ProxyTlv[];
}

export interface EncodeProxyV2Input {
  readonly command: ProxyCommand;
  readonly family: ProxyFamily;
  readonly source?: ProxyEndpoint;
  readonly destination?: ProxyEndpoint;
  readonly tlvs?: readonly ProxyTlv[];
}

function normalizeAddress(address: string): string {
  return address.startsWith('::ffff:') ? address.slice('::ffff:'.length) : address;
}

/** True when `address` is a dotted-quad IPv4 literal (after stripping an IPv4-mapped prefix). */
function isIPv4Literal(address: string): boolean {
  const parts = address.split('.');
  if (parts.length !== 4) return false;
  return parts.every((part) => {
    if (part.length === 0 || part.length > 3) return false;
    if (!/^\d+$/.test(part)) return false;
    const n = Number(part);
    return n >= 0 && n <= 255;
  });
}

function encodeIPv4(address: string): Buffer {
  const parts = address.split('.').map((p) => Number(p));
  const buf = Buffer.alloc(4);
  for (let i = 0; i < 4; i += 1) {
    buf.writeUInt8(parts[i] ?? 0, i);
  }
  return buf;
}

function expandIPv6(address: string): Buffer {
  const normalized = normalizeAddress(address);
  // Handle an IPv4-mapped address embedded in IPv6 text (e.g. "::ffff:1.2.3.4" already stripped
  // above, but a bare "::1.2.3.4" form can still appear) by letting Node's own parser do the work.
  const [head, tail] = normalized.split('::');
  const headParts = head && head.length > 0 ? head.split(':') : [];
  const tailParts = tail && tail.length > 0 ? tail.split(':') : [];

  function expandGroup(groups: string[]): number[] {
    const out: number[] = [];
    for (const g of groups) {
      if (g.includes('.')) {
        // trailing embedded IPv4
        const v4 = encodeIPv4(g);
        out.push((v4.readUInt8(0) << 8) | v4.readUInt8(1));
        out.push((v4.readUInt8(2) << 8) | v4.readUInt8(3));
      } else {
        out.push(parseInt(g, 16));
      }
    }
    return out;
  }

  let groups: number[];
  if (normalized.includes('::')) {
    const headGroups = expandGroup(headParts);
    const tailGroups = expandGroup(tailParts);
    const missing = 8 - headGroups.length - tailGroups.length;
    groups = [...headGroups, ...new Array<number>(Math.max(missing, 0)).fill(0), ...tailGroups];
  } else {
    groups = expandGroup(normalized.split(':'));
  }

  const buf = Buffer.alloc(16);
  for (let i = 0; i < 8; i += 1) {
    buf.writeUInt16BE(groups[i] ?? 0, i * 2);
  }
  return buf;
}

/** Resolve the effective family for an endpoint, downgrading IPv4-mapped IPv6 to TCP4. */
function effectiveFamily(address: string): 'TCP4' | 'TCP6' {
  const stripped = normalizeAddress(address);
  return isIPv4Literal(stripped) ? 'TCP4' : 'TCP6';
}

function encodeEndpointAddress(family: ProxyFamily, endpoint: ProxyEndpoint): Buffer {
  const address = normalizeAddress(endpoint.address);
  if (family === 'TCP4') {
    return encodeIPv4(address);
  }
  return expandIPv6(address);
}

function encodePort(port: number): Buffer {
  const buf = Buffer.alloc(2);
  buf.writeUInt16BE(port & 0xffff, 0);
  return buf;
}

function encodeTlv(tlv: ProxyTlv): Buffer {
  const header = Buffer.alloc(3);
  header.writeUInt8(tlv.type, 0);
  header.writeUInt16BE(tlv.value.length, 1);
  return Buffer.concat([header, tlv.value]);
}

/**
 * Encode a PROXY protocol v2 header. IPv4-mapped IPv6 addresses ("::ffff:1.2.3.4") are encoded
 * as TCP4, regardless of the `family` field passed in, matching what a Node TCP server reports
 * for a dual-stack listener.
 */
export function encodeProxyV2(input: EncodeProxyV2Input): Buffer {
  const tlvs = input.tlvs ?? [];

  if (input.command === 'LOCAL' || !input.source || !input.destination) {
    const verCmd = Buffer.from([PP2_VERSION | COMMAND_BITS.LOCAL]);
    const famProto = Buffer.from([FAM_BITS.UNSPEC | 0x00]);
    const tlvBufs = tlvs.map(encodeTlv);
    const len = Buffer.concat(tlvBufs).length;
    const lenBuf = Buffer.alloc(2);
    lenBuf.writeUInt16BE(len, 0);
    return Buffer.concat([SIGNATURE, verCmd, famProto, lenBuf, ...tlvBufs]);
  }

  const family: 'TCP4' | 'TCP6' = effectiveFamily(input.source.address);

  const verCmd = Buffer.from([PP2_VERSION | COMMAND_BITS.PROXY]);
  const famProto = Buffer.from([FAM_BITS[family] | PROTO_STREAM]);

  const srcAddr = encodeEndpointAddress(family, input.source);
  const dstAddr = encodeEndpointAddress(family, input.destination);
  const srcPort = encodePort(input.source.port);
  const dstPort = encodePort(input.destination.port);
  const tlvBufs = tlvs.map(encodeTlv);

  const body = Buffer.concat([srcAddr, dstAddr, srcPort, dstPort, ...tlvBufs]);

  const lenBuf = Buffer.alloc(2);
  lenBuf.writeUInt16BE(body.length, 0);

  return Buffer.concat([SIGNATURE, verCmd, famProto, lenBuf, body]);
}

export type DecodeProxyV2Result =
  | { readonly kind: 'incomplete' }
  | { readonly kind: 'ok'; readonly header: ProxyHeader; readonly bytesConsumed: number }
  | { readonly kind: 'error'; readonly reason: string };

function formatIPv4(buf: Buffer, offset: number): string {
  return `${buf[offset]}.${buf[offset + 1]}.${buf[offset + 2]}.${buf[offset + 3]}`;
}

function formatIPv6(buf: Buffer, offset: number): string {
  const groups: string[] = [];
  for (let i = 0; i < 8; i += 1) {
    groups.push(buf.readUInt16BE(offset + i * 2).toString(16));
  }
  // Collapse the longest run of zero groups into "::", per RFC 5952 (best-effort, not
  // canonical-shortest in every tie case, but always round-trippable).
  let bestStart = -1;
  let bestLen = 0;
  let curStart = -1;
  let curLen = 0;
  for (let i = 0; i < groups.length; i += 1) {
    if (groups[i] === '0') {
      if (curStart === -1) curStart = i;
      curLen += 1;
      if (curLen > bestLen) {
        bestLen = curLen;
        bestStart = curStart;
      }
    } else {
      curStart = -1;
      curLen = 0;
    }
  }
  if (bestLen > 1) {
    const before = groups.slice(0, bestStart);
    const after = groups.slice(bestStart + bestLen);
    return `${before.join(':')}::${after.join(':')}`;
  }
  return groups.join(':');
}

/**
 * Decode a PROXY protocol v2 header from the start of `buffer`. Never throws: malformed input,
 * a v1 text header, or an unknown signature all come back as `{ kind: 'error' }`. A buffer that
 * is a strict prefix of a valid header comes back as `{ kind: 'incomplete' }`.
 */
export function decodeProxyV2(buffer: Buffer): DecodeProxyV2Result {
  if (buffer.length === 0) return { kind: 'incomplete' };

  const sigLen = Math.min(buffer.length, SIGNATURE.length);
  if (!buffer.subarray(0, sigLen).equals(SIGNATURE.subarray(0, sigLen))) {
    return { kind: 'error', reason: 'bad signature' };
  }
  if (buffer.length < SIGNATURE.length + 4) {
    return { kind: 'incomplete' };
  }

  const verCmd = buffer.readUInt8(SIGNATURE.length);
  const version = verCmd & 0xf0;
  const cmdBits = verCmd & 0x0f;
  if (version !== PP2_VERSION) {
    return { kind: 'error', reason: `unsupported version 0x${version.toString(16)}` };
  }
  const command = COMMAND_BY_BITS[cmdBits];
  if (command === undefined) {
    return { kind: 'error', reason: `unknown command bits 0x${cmdBits.toString(16)}` };
  }

  const famProto = buffer.readUInt8(SIGNATURE.length + 1);
  const famBits = famProto & 0xf0;
  const family = FAM_BY_BITS[famBits];
  if (family === undefined) {
    return { kind: 'error', reason: `unknown family bits 0x${famBits.toString(16)}` };
  }

  const lenOffset = SIGNATURE.length + 2;
  const len = buffer.readUInt16BE(lenOffset);
  const headerEnd = lenOffset + 2 + len;
  if (len > 0xffff) {
    return { kind: 'error', reason: 'length overflow' };
  }
  if (buffer.length < headerEnd) {
    return { kind: 'incomplete' };
  }

  let cursor = lenOffset + 2;
  const bodyEnd = headerEnd;

  let source: ProxyEndpoint | undefined;
  let destination: ProxyEndpoint | undefined;

  if (family === 'TCP4') {
    const need = 4 + 4 + 2 + 2;
    if (bodyEnd - cursor < need) {
      return { kind: 'error', reason: 'body too short for TCP4 addresses' };
    }
    const srcAddr = formatIPv4(buffer, cursor);
    const dstAddr = formatIPv4(buffer, cursor + 4);
    const srcPort = buffer.readUInt16BE(cursor + 8);
    const dstPort = buffer.readUInt16BE(cursor + 10);
    source = { address: srcAddr, port: srcPort };
    destination = { address: dstAddr, port: dstPort };
    cursor += need;
  } else if (family === 'TCP6') {
    const need = 16 + 16 + 2 + 2;
    if (bodyEnd - cursor < need) {
      return { kind: 'error', reason: 'body too short for TCP6 addresses' };
    }
    const srcAddr = formatIPv6(buffer, cursor);
    const dstAddr = formatIPv6(buffer, cursor + 16);
    const srcPort = buffer.readUInt16BE(cursor + 32);
    const dstPort = buffer.readUInt16BE(cursor + 34);
    source = { address: srcAddr, port: srcPort };
    destination = { address: dstAddr, port: dstPort };
    cursor += need;
  }
  // UNSPEC: no addresses to read; whatever bytes remain up to bodyEnd are TLVs (or padding we
  // treat as opaque TLVs — if they don't parse as TLVs we still succeed with an empty TLV list
  // by stopping consumption at bodyEnd).

  const tlvs: ProxyTlv[] = [];
  while (cursor < bodyEnd) {
    if (bodyEnd - cursor < 3) {
      return { kind: 'error', reason: 'truncated TLV header' };
    }
    const type = buffer.readUInt8(cursor);
    const tlvLen = buffer.readUInt16BE(cursor + 1);
    const valueStart = cursor + 3;
    const valueEnd = valueStart + tlvLen;
    if (valueEnd > bodyEnd) {
      return { kind: 'error', reason: 'TLV length overflow' };
    }
    tlvs.push({ type, value: Buffer.from(buffer.subarray(valueStart, valueEnd)) });
    cursor = valueEnd;
  }

  const header: ProxyHeader = { command, family, tlvs, ...(source && { source }), ...(destination && { destination }) };

  return { kind: 'ok', header, bytesConsumed: headerEnd };
}

export interface ReadProxyHeaderOptions {
  readonly timeoutMs: number;
  readonly maxBytes: number;
}

export interface ReadProxyHeaderResult {
  readonly header: ProxyHeader;
  readonly rest: Buffer;
}

/**
 * Read exactly a PROXY protocol v2 header off `socket`, accumulating chunks until the header is
 * complete, then resolve with the header and any bytes already read past it (which belong to the
 * forwarded stream, not the header, and must not be discarded).
 */
export function readProxyHeader(
  socket: Socket,
  options: ReadProxyHeaderOptions,
): Promise<ReadProxyHeaderResult> {
  return new Promise((resolve, reject) => {
    let buffer = Buffer.alloc(0);
    let settled = false;

    const timer = setTimeout(() => {
      finish(() => {
        reject(new Error('timed out waiting for PROXY protocol header'));
      });
    }, options.timeoutMs);

    function cleanup(): void {
      clearTimeout(timer);
      socket.off('data', onData);
      socket.off('error', onError);
      socket.off('close', onClose);
    }

    function finish(action: () => void): void {
      if (settled) return;
      settled = true;
      cleanup();
      action();
    }

    function onData(chunk: Buffer): void {
      buffer = Buffer.concat([buffer, chunk]);
      if (buffer.length > options.maxBytes) {
        finish(() => {
          reject(new Error('PROXY protocol header exceeded maxBytes'));
        });
        return;
      }
      const result = decodeProxyV2(buffer);
      if (result.kind === 'ok') {
        const rest = Buffer.from(buffer.subarray(result.bytesConsumed));
        finish(() => {
          socket.pause();
          resolve({ header: result.header, rest });
        });
        return;
      }
      if (result.kind === 'error') {
        finish(() => {
          reject(new Error(`invalid PROXY protocol header: ${result.reason}`));
        });
      }
      // incomplete: keep reading
    }

    function onError(err: Error): void {
      finish(() => {
        reject(err);
      });
    }

    function onClose(): void {
      finish(() => {
        reject(new Error('socket closed before PROXY protocol header completed'));
      });
    }

    socket.on('data', onData);
    socket.on('error', onError);
    socket.on('close', onClose);
  });
}

/**
 * True when `remoteAddress` (after normalising an "::ffff:" IPv4-mapped prefix) exactly matches
 * one of `trustedPeers`. Used by the home side (PST-T-0.14 / PST-REQ-016) to accept PROXY v2 only
 * from the edge's WireGuard peer.
 */
export function isTrustedProxyPeer(remoteAddress: string, trustedPeers: readonly string[]): boolean {
  const normalized = normalizeAddress(remoteAddress);
  return trustedPeers.some((peer) => normalizeAddress(peer) === normalized);
}
