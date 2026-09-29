// PST-T-14.2: the summary sweep gives up on a row only for a failure that cannot pass on its own.
import { BlobNotFoundError } from '@postroom/blobstore';
import { DecryptError, KekLoadError } from '@postroom/crypto';
import { describe, expect, it } from 'vitest';
import { permanentFailure } from '../../src/sweep/summary-sweep.js';

const errno = (code: string): Error => Object.assign(new Error(code), { code });

describe('permanentFailure (PST-T-14.2)', () => {
  it('is permanent for a missing blob, a failed tag, and a parse error', () => {
    expect(permanentFailure(new BlobNotFoundError('a'.repeat(64)))).toBe('BlobNotFoundError');
    expect(permanentFailure(errno('ENOENT'))).toBe('ENOENT');
    expect(permanentFailure(new DecryptError('authentication failed'))).toBe('DecryptError');
    expect(permanentFailure(new Error('malformed MIME'))).toBe('ParseError');
  });

  it('is transient for the database, I/O pressure, timeouts and KEK configuration', () => {
    expect(permanentFailure(errno('ECONNRESET'))).toBeNull();
    expect(permanentFailure(errno('EMFILE'))).toBeNull();
    expect(permanentFailure(errno('P1001'))).toBeNull();
    expect(permanentFailure(Object.assign(new Error('db down'), { name: 'PrismaClientInitializationError' }))).toBeNull();
    expect(permanentFailure(Object.assign(new Error('slow'), { name: 'TimeoutError' }))).toBeNull();
    expect(permanentFailure(new KekLoadError('POSTROOM_KEK is not set'))).toBeNull();
    expect(permanentFailure(new DecryptError('blob is wrapped under a different KEK'))).toBeNull();
  });
});
