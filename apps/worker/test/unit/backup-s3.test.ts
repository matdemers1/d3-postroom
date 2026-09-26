// PST-T-0.16: S3 request building, list parsing, backup config and the nightly schedule.
import { describe, expect, it } from 'vitest';
import { backupConfig } from '../../src/backup/config.js';
import { blobKey, dumpKey } from '../../src/backup/job.js';
import { buildRequest, parseListPage, type S3Config } from '../../src/backup/s3.js';
import { dueJobs, parseHhmm } from '../../src/backup/schedule.js';
import { parseAuthorization, sign, UNSIGNED_PAYLOAD } from '../../src/backup/sigv4.js';

const config: S3Config = {
  bucket: 'postroom-backups',
  region: 'us-east-1',
  kmsKeyId: 'arn:aws:kms:us-east-1:111122223333:key/k',
  credentials: { accessKeyId: 'AKIDEXAMPLE', secretAccessKey: 'secret' },
  now: () => new Date('2026-09-25T03:00:00Z'),
};

describe('buildRequest', () => {
  it('addresses AWS virtual-hosted and signs host, date and payload hash', () => {
    const req = buildRequest(config, 'PUT', 'db/2026-09-25/postroom.dump', { headers: { 'x-amz-server-side-encryption': 'aws:kms' }, payloadHash: UNSIGNED_PAYLOAD });
    expect(req.url.toString()).toBe('https://postroom-backups.s3.us-east-1.amazonaws.com/db/2026-09-25/postroom.dump');
    expect(req.headers['host']).toBe('postroom-backups.s3.us-east-1.amazonaws.com');
    expect(req.headers['x-amz-date']).toBe('20260925T030000Z');
    expect(req.headers['x-amz-content-sha256']).toBe(UNSIGNED_PAYLOAD);
    const auth = parseAuthorization(req.headers['authorization'] ?? '');
    expect(auth).toMatchObject({ accessKeyId: 'AKIDEXAMPLE', date: '20260925', region: 'us-east-1', service: 's3' });
    expect(auth?.signedHeaders).toEqual(['host', 'x-amz-content-sha256', 'x-amz-date', 'x-amz-server-side-encryption']);
  });

  it('goes path-style against a custom endpoint, and the signature verifies', () => {
    const req = buildRequest({ ...config, endpoint: 'http://127.0.0.1:9000' }, 'GET', '', { query: [['list-type', '2'], ['prefix', 'blobs/']] });
    expect(req.url.toString()).toBe('http://127.0.0.1:9000/postroom-backups?list-type=2&prefix=blobs%2F');
    const auth = parseAuthorization(req.headers['authorization'] ?? '');
    const headers: Record<string, string> = {};
    for (const h of auth?.signedHeaders ?? []) headers[h] = req.headers[h] ?? '';
    const again = sign(
      { method: 'GET', path: '/postroom-backups', query: [['prefix', 'blobs/'], ['list-type', '2']], headers, payloadHash: req.headers['x-amz-content-sha256'] ?? '' },
      { credentials: config.credentials, region: 'us-east-1', service: 's3', amzDate: '20260925T030000Z', s3: true },
    );
    expect(again.signature).toBe(auth?.signature);
  });

  it('carries a session token when one is configured', () => {
    const req = buildRequest({ ...config, credentials: { ...config.credentials, sessionToken: 'tok' } }, 'HEAD', 'kek/bundle.json');
    expect(req.headers['x-amz-security-token']).toBe('tok');
    expect(parseAuthorization(req.headers['authorization'] ?? '')?.signedHeaders).toContain('x-amz-security-token');
  });
});

describe('parseListPage', () => {
  it('reads keys, sizes, truncation and the continuation token, unescaping XML', () => {
    const page = parseListPage(
      '<ListBucketResult><IsTruncated>true</IsTruncated><NextContinuationToken>1ueGcxLPRx1Tr/XYExHnhbYLgveDs2J/wm36Hy4vbOwM=</NextContinuationToken>' +
        '<Contents><Key>blobs/ab/cd/x&amp;y</Key><Size>42</Size></Contents><Contents><Key>db/2026-09-25/manifest.json</Key><Size>7</Size></Contents></ListBucketResult>',
    );
    expect(page).toEqual({
      objects: [{ key: 'blobs/ab/cd/x&y', size: 42 }, { key: 'db/2026-09-25/manifest.json', size: 7 }],
      truncated: true,
      next: '1ueGcxLPRx1Tr/XYExHnhbYLgveDs2J/wm36Hy4vbOwM=',
    });
    expect(parseListPage('<ListBucketResult><IsTruncated>false</IsTruncated></ListBucketResult>')).toEqual({ objects: [], truncated: false, next: null });
  });
});

describe('keys', () => {
  it('lays the bucket out as db/<date>/ and blobs/<aa>/<bb>/<sha256>', () => {
    const sha = 'ab'.padEnd(64, 'c');
    expect(dumpKey('2026-09-25')).toBe('db/2026-09-25/postroom.dump');
    expect(blobKey(sha)).toBe(`blobs/ab/cc/${sha}`);
  });
});

describe('backupConfig', () => {
  it('is unconfigured without a bucket, and names what is missing', () => {
    expect(backupConfig({})).toMatchObject({ s3: null, missing: ['BACKUP_BUCKET'], backupDir: '/var/lib/postroom/backups', keepLocalDays: 7, kekPassphrase: null });
    expect(backupConfig({ BACKUP_BUCKET: 'b' }).missing).toEqual(['BACKUP_KMS_KEY_ID', 'AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY']);
  });
  it('is configured with bucket, key and credentials; region defaults to us-east-1', () => {
    const c = backupConfig({ BACKUP_BUCKET: 'b', BACKUP_KMS_KEY_ID: 'k', AWS_ACCESS_KEY_ID: 'a', AWS_SECRET_ACCESS_KEY: 's', BACKUP_KEK_PASSPHRASE: 'p' });
    expect(c.s3).toMatchObject({ bucket: 'b', region: 'us-east-1', kmsKeyId: 'k' });
    expect(c.s3?.endpoint).toBeUndefined();
    expect(c.kekPassphrase).toBe('p');
  });
});

describe('nightly schedule', () => {
  const times = { backupAt: '03:00', drillAt: '04:30' };
  it('nothing is due before the backup time', () => {
    expect(dueJobs(new Date('2026-09-25T02:59:00Z'), times)).toEqual([]);
  });
  it('the backup is due from its time, keyed by the UTC date', () => {
    expect(dueJobs(new Date('2026-09-25T03:00:00Z'), times)).toEqual([{ queue: 'backup', date: '2026-09-25', idempotencyKey: 'backup:2026-09-25' }]);
  });
  it('both are due after the drill time', () => {
    expect(dueJobs(new Date('2026-09-25T23:59:00Z'), times).map((j) => j.idempotencyKey)).toEqual(['backup:2026-09-25', 'drill:2026-09-25']);
  });
  it('refuses a malformed time', () => {
    expect(() => parseHhmm('3am')).toThrow(/HH:MM/);
    expect(parseHhmm('04:30')).toBe(270);
  });
});
