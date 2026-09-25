// Blob names and where they live on disk.
//
// A blob is named by the lowercase hex SHA-256 of its plaintext (PST-REQ-012) and stored at
// `<root>/<aa>/<bb>/<sha256>`, two levels of 256-way sharding so no directory grows past a few
// thousand entries. The name is validated before it is ever joined onto a path: a name that is not
// exactly 64 lowercase hex characters never reaches the filesystem, so `../etc/passwd` cannot.

import { isAbsolute, join } from 'node:path';
import { InvalidBlobNameError } from './errors.js';

const SHA256_HEX = /^[0-9a-f]{64}$/;

/** True when `name` is a valid blob name: exactly 64 lowercase hex characters. */
export function isBlobName(name: unknown): name is string {
  return typeof name === 'string' && SHA256_HEX.test(name);
}

/** Throws InvalidBlobNameError unless `name` is a valid blob name. */
export function assertBlobName(name: unknown): asserts name is string {
  if (!isBlobName(name)) throw new InvalidBlobNameError();
}

export function assertRoot(root: string): void {
  if (!isAbsolute(root)) throw new TypeError('blob store root must be an absolute path');
}

/** The directory a blob's file lives in: `<root>/<aa>/<bb>`. */
export function blobDir(root: string, sha256: string): string {
  assertRoot(root);
  assertBlobName(sha256);
  return join(root, sha256.slice(0, 2), sha256.slice(2, 4));
}

/** The on-disk path of a blob: `<root>/<aa>/<bb>/<sha256>`. */
export function blobPath(root: string, sha256: string): string {
  return join(blobDir(root, sha256), sha256);
}

/** Where in-flight writes go before they are named. Same filesystem as the tree, so rename is atomic. */
export function tmpDir(root: string): string {
  assertRoot(root);
  return join(root, 'tmp');
}
