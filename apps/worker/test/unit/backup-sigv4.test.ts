// SigV4 against AWS's published examples (PST-T-0.16). The suite vectors use the documentation
// credentials AKIDEXAMPLE / wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY at 20150830T123600Z; the S3
// examples are the ones on "Signature Calculations for the Authorization Header" in the S3 API docs.
import { describe, expect, it } from 'vitest';
import { amzDate, canonicalQuery, EMPTY_SHA256, parseAuthorization, sha256Hex, sign, signingKey, uriEncode } from '../../src/backup/sigv4.js';

const suite = {
  credentials: { accessKeyId: 'AKIDEXAMPLE', secretAccessKey: 'wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY' },
  region: 'us-east-1',
  service: 'service',
  amzDate: '20150830T123600Z',
};

const s3docs = {
  credentials: { accessKeyId: 'AKIAIOSFODNN7EXAMPLE', secretAccessKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY' },
  region: 'us-east-1',
  service: 's3',
  amzDate: '20130524T000000Z',
  s3: true,
};

describe('SigV4 signing key', () => {
  it('derives the documented key (IAM example, 20120215)', () => {
    expect(signingKey('wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY', '20120215', 'us-east-1', 'iam').toString('hex'))
      .toBe('f4780e2d9f65fa895f9c67b32ce1baf0b0d8a43505a000a1a9e090d414db404d');
  });
});

describe('SigV4 test suite: get-vanilla', () => {
  const sig = sign(
    { method: 'GET', path: '/', headers: { Host: 'example.amazonaws.com', 'X-Amz-Date': '20150830T123600Z' }, payloadHash: EMPTY_SHA256 },
    suite,
  );
  it('builds the canonical request', () => {
    expect(sig.canonicalRequest).toBe(
      'GET\n/\n\nhost:example.amazonaws.com\nx-amz-date:20150830T123600Z\n\nhost;x-amz-date\n' + EMPTY_SHA256,
    );
  });
  it('builds the string to sign', () => {
    expect(sig.stringToSign).toBe(
      'AWS4-HMAC-SHA256\n20150830T123600Z\n20150830/us-east-1/service/aws4_request\nbb579772317eb040ac9ed261061d46c1f17a8133879d6129b6e1c25292927e63',
    );
  });
  it('signs', () => {
    expect(sig.signature).toBe('5fa00fa31553b73ebf1942676e86291e8372ff2a2260956d9b8aae1d763fbf31');
    expect(sig.authorization).toBe(
      'AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE/20150830/us-east-1/service/aws4_request, SignedHeaders=host;x-amz-date, Signature=5fa00fa31553b73ebf1942676e86291e8372ff2a2260956d9b8aae1d763fbf31',
    );
  });
});

describe('SigV4 test suite: post-x-www-form-urlencoded', () => {
  const body = 'Param1=value1';
  const sig = sign(
    {
      method: 'POST',
      path: '/',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Host: 'example.amazonaws.com', 'X-Amz-Date': '20150830T123600Z' },
      payloadHash: sha256Hex(body),
    },
    suite,
  );
  it('signs the content-type header and hashes the form body', () => {
    expect(sig.signedHeaders).toBe('content-type;host;x-amz-date');
    expect(sig.canonicalRequest).toBe(
      'POST\n/\n\ncontent-type:application/x-www-form-urlencoded\nhost:example.amazonaws.com\nx-amz-date:20150830T123600Z\n\n' +
        'content-type;host;x-amz-date\n9095672bbd1f56dfc5b65f3e153adc8731a4a654192329106275f4c7b24d0b6e',
    );
  });
});

describe('S3 docs: GET Object', () => {
  const sig = sign(
    {
      method: 'GET',
      path: '/test.txt',
      headers: { Host: 'examplebucket.s3.amazonaws.com', Range: 'bytes=0-9', 'x-amz-content-sha256': EMPTY_SHA256, 'x-amz-date': '20130524T000000Z' },
      payloadHash: EMPTY_SHA256,
    },
    s3docs,
  );
  it('matches the documented canonical request hash and signature', () => {
    expect(sha256Hex(sig.canonicalRequest)).toBe('7344ae5b7ee6c3e7e6b0fe0640412a37625d1fbfff95c48bbb2dc43964946972');
    expect(sig.signature).toBe('f0e8bdb87c964420e857bd35b5d6ed310bd44f0170aba48dd91039c6036bdb41');
  });
});

describe('S3 docs: PUT Object', () => {
  const body = 'Welcome to Amazon S3.';
  const sig = sign(
    {
      method: 'PUT',
      path: '/test$file.text',
      headers: {
        Host: 'examplebucket.s3.amazonaws.com',
        Date: 'Fri, 24 May 2013 00:00:00 GMT',
        'x-amz-date': '20130524T000000Z',
        'x-amz-storage-class': 'REDUCED_REDUNDANCY',
        'x-amz-content-sha256': sha256Hex(body),
      },
      payloadHash: sha256Hex(body),
    },
    s3docs,
  );
  it('encodes $ once in the path and signs', () => {
    expect(sha256Hex(body)).toBe('44ce7dd67c959e0d3524ffac1771dfbba87d2b6b4b4e99e42034a8b803f8b072');
    expect(sig.canonicalRequest.split('\n')[1]).toBe('/test%24file.text');
    expect(sig.signature).toBe('98ad721746da40c64f1a55b78f14c238d841ea1380cd77a1b5971af0ece108bd');
  });
});

describe('S3 docs: GET Bucket lifecycle and list objects', () => {
  const headers = { Host: 'examplebucket.s3.amazonaws.com', 'x-amz-date': '20130524T000000Z', 'x-amz-content-sha256': EMPTY_SHA256 };
  it('signs a value-less subresource (?lifecycle)', () => {
    const sig = sign({ method: 'GET', path: '/', query: [['lifecycle', '']], headers, payloadHash: EMPTY_SHA256 }, s3docs);
    expect(sig.canonicalRequest.split('\n')[2]).toBe('lifecycle=');
    expect(sig.signature).toBe('fea454ca298b7da1c68078a5d1bdbfbbe0d65c699e0f91ac7a200a0136783543');
  });
  it('sorts query parameters (?max-keys=2&prefix=J)', () => {
    const sig = sign({ method: 'GET', path: '/', query: [['prefix', 'J'], ['max-keys', '2']], headers, payloadHash: EMPTY_SHA256 }, s3docs);
    expect(sig.canonicalRequest.split('\n')[2]).toBe('max-keys=2&prefix=J');
    expect(sig.signature).toBe('34b48302e7b5fa45bde8084f4b7868a86f0a534bc59db6670ed5711ef69dc6f7');
  });
});

describe('helpers', () => {
  it('encodes per RFC 3986 with uppercase hex', () => {
    expect(uriEncode('a b/c~d*é')).toBe('a%20b%2Fc~d%2A%C3%A9');
    expect(canonicalQuery([['continuation-token', 'a+b='], ['list-type', '2']])).toBe('continuation-token=a%2Bb%3D&list-type=2');
  });
  it('formats x-amz-date', () => {
    expect(amzDate(new Date('2013-05-24T00:00:00.000Z'))).toBe('20130524T000000Z');
  });
  it('parses an Authorization header back into its parts', () => {
    const sig = sign({ method: 'GET', path: '/', headers: { host: 'h' }, payloadHash: EMPTY_SHA256 }, suite);
    expect(parseAuthorization(sig.authorization)).toEqual({
      accessKeyId: 'AKIDEXAMPLE', date: '20150830', region: 'us-east-1', service: 'service', signedHeaders: ['host'], signature: sig.signature,
    });
    expect(parseAuthorization('Bearer x')).toBeNull();
  });
});
