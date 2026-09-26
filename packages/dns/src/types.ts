// Shared wire-format and API types for the stub DNS resolver client (PST-REQ-031, PST-REQ-064).

export const RRType = {
  A: 1,
  NS: 2,
  CNAME: 5,
  SOA: 6,
  PTR: 12,
  MX: 15,
  TXT: 16,
  AAAA: 28,
  OPT: 41,
  TLSA: 52,
} as const;

export type RRTypeValue = (typeof RRType)[keyof typeof RRType];

export const RCode = {
  NOERROR: 0,
  FORMERR: 1,
  SERVFAIL: 2,
  NXDOMAIN: 3,
  NOTIMP: 4,
  REFUSED: 5,
} as const;

export const DNS_CLASS_IN = 1;

export interface DnsQuestion {
  name: string;
  type: number;
  class: number;
}

interface BaseAnswer {
  name: string;
  ttl: number;
  type: number;
  class: number;
}

export type DnsAnswer =
  | (BaseAnswer & { kind: 'A'; address: string })
  | (BaseAnswer & { kind: 'AAAA'; address: string })
  | (BaseAnswer & { kind: 'MX'; preference: number; exchange: string })
  | (BaseAnswer & { kind: 'TXT'; strings: string[]; text: string })
  | (BaseAnswer & { kind: 'CNAME'; target: string })
  | (BaseAnswer & { kind: 'PTR'; target: string })
  | (BaseAnswer & {
      kind: 'TLSA';
      usage: number;
      selector: number;
      matchingType: number;
      certData: Uint8Array;
    })
  | (BaseAnswer & { kind: 'UNKNOWN'; raw: Uint8Array });

export interface DnsMessage {
  id: number;
  qr: boolean;
  opcode: number;
  aa: boolean;
  tc: boolean;
  rd: boolean;
  ra: boolean;
  ad: boolean;
  cd: boolean;
  rcode: number;
  questions: DnsQuestion[];
  answers: DnsAnswer[];
  authority: DnsAnswer[];
  additional: DnsAnswer[];
}

export type DecodeResult = { ok: true; message: DnsMessage } | { ok: false; error: string };

export interface ResolverResult {
  rcode: number;
  ad: boolean;
  answers: DnsAnswer[];
  authority: DnsAnswer[];
}

export interface Resolver {
  query: (name: string, type: number) => Promise<ResolverResult>;
  a: (name: string) => Promise<ResolverResult>;
  aaaa: (name: string) => Promise<ResolverResult>;
  mx: (name: string) => Promise<ResolverResult>;
  txt: (name: string) => Promise<ResolverResult>;
  tlsa: (name: string) => Promise<ResolverResult>;
  ptr: (ip: string) => Promise<ResolverResult>;
}
