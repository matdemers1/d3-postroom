// One compose attachment, uploaded (PST-T-15.11, PST-REQ-195, PST-ADR-013): POST
// /api/compose/uploads with the file's bytes as the raw request body — not multipart — its type as
// Content-Type and its name, URI-encoded, in X-Postroom-Filename. XMLHttpRequest rather than fetch,
// because only XHR reports upload progress. The CSRF header is the one `call()` sends (api.ts's
// CSRF_HEADER), and refusals become the same ApiError, so the composer reads them one way.
import { apiErrorOf, COMPOSE_UPLOADS_PATH, CSRF_HEADER, parseBody, type ComposeUpload } from '../../../api';

/** The slice of XMLHttpRequest this uses — so a test can hand in a fake. */
export interface XhrLike {
  open(method: string, url: string): void;
  setRequestHeader(name: string, value: string): void;
  send(body: Blob): void;
  abort(): void;
  readonly status: number;
  readonly responseText: string;
  withCredentials: boolean;
  onload: (() => void) | null;
  onerror: (() => void) | null;
  onabort: (() => void) | null;
  readonly upload: { onprogress: ((e: { loaded: number; total: number; lengthComputable: boolean }) => void) | null };
}

export interface UploadHandle {
  /** Resolves with the server's upload; rejects with an ApiError, an UploadAborted, or a network Error. */
  done: Promise<ComposeUpload>;
  abort(): void;
}

export class UploadAborted extends Error {
  constructor() {
    super('upload_aborted');
  }
}

/** The request's headers, exactly (exported for the unit test). */
export function uploadHeaders(file: Pick<File, 'name' | 'type'>): Record<string, string> {
  return {
    accept: 'application/json',
    [CSRF_HEADER.name]: CSRF_HEADER.value,
    'content-type': file.type === '' ? 'application/octet-stream' : file.type,
    'x-postroom-filename': encodeURIComponent(file.name),
  };
}

export function uploadAttachment(
  file: File,
  onProgress: (loaded: number) => void,
  makeXhr: () => XhrLike = () => new XMLHttpRequest() as unknown as XhrLike,
): UploadHandle {
  const xhr = makeXhr();
  const done = new Promise<ComposeUpload>((resolve, reject) => {
    xhr.open('POST', COMPOSE_UPLOADS_PATH);
    xhr.withCredentials = true;
    for (const [name, value] of Object.entries(uploadHeaders(file))) xhr.setRequestHeader(name, value);
    xhr.upload.onprogress = (e) => {
      onProgress(e.loaded);
    };
    xhr.onload = () => {
      const parsed = parseBody(xhr.responseText);
      if (xhr.status >= 200 && xhr.status < 300) resolve(parsed as ComposeUpload);
      else reject(apiErrorOf(xhr.status, parsed));
    };
    xhr.onerror = () => {
      reject(new Error('network'));
    };
    xhr.onabort = () => {
      reject(new UploadAborted());
    };
    xhr.send(file);
  });
  return {
    done,
    abort: () => {
      xhr.abort();
    },
  };
}
