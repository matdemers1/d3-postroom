// PST-T-14.9: the webmail's calls for sorting corrections and sender routing, through the app's one
// door (api.ts's `call`: same origin, cookies, the CSRF header on every write).
import { call, type MessageSummary } from '../../api';
import type { FilingBucket } from './sorting';

export interface SortingCorrection {
  id: string;
  scope: 'sender' | 'domain';
  target: string;
  fromBucket: string | null;
  toBucket: string;
  messageId: string | null;
  moved: boolean;
  subject: string | null;
  fromAddress: string | null;
  source: 'chip' | 'card';
  createdAt: string;
  undoneAt: string | null;
}

export interface CorrectionResult {
  correction: SortingCorrection;
  message: MessageSummary;
}

export interface UndoResult {
  correction: SortingCorrection;
  movedBack: boolean;
  message: MessageSummary | null;
  preferenceRestored: boolean;
}

export const sortingApi = {
  corrections: () => call<{ corrections: SortingCorrection[] }>('GET', '/api/sorting/corrections'),
  correct: (input: { messageId: string; bucket: FilingBucket; scope: 'sender' | 'domain'; source?: 'chip' | 'card' }) =>
    call<CorrectionResult>('POST', '/api/sorting/corrections', input),
  undo: (id: string) => call<UndoResult>('POST', `/api/sorting/corrections/${encodeURIComponent(id)}/undo`),
  /** The Person card's "Their mail goes to" (PST-REQ-105's pin, audited server-side). */
  setPin: (address: string, bucket: FilingBucket) => call<{ address: string; bucket: string | null }>('PUT', `/api/senders/${encodeURIComponent(address)}/pin`, { bucket }),
  clearPin: (address: string) => call<{ ok: true }>('DELETE', `/api/senders/${encodeURIComponent(address)}/pin`),
};
