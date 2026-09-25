// Encrypted content-addressed blob store with refcounts and fsync-before-return.
export const PACKAGE = '@postroom/blobstore';

export { BlobNotFoundError, BlobStoreError, InvalidBlobNameError } from './errors.js';
export { assertBlobName, blobDir, blobPath, isBlobName, tmpDir } from './paths.js';
export {
  BLOB_AEAD,
  BLOB_STREAM_AAD,
  createBlobStore,
  DEFAULT_GC_AGE_MS,
  type BlobLogger,
  type BlobSource,
  type BlobStat,
  type BlobStore,
  type BlobStoreOptions,
  type GcOptions,
  type GcResult,
  type PutOptions,
  type PutResult,
  type ReleaseResult,
  type TxClient,
} from './store.js';
