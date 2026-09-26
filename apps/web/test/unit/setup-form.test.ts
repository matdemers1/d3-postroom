// PST-T-11.6 — the setup form marks the field the server refused, and a login is only a local part.
import { describe, expect, it } from 'vitest';
import { ApiError } from '../../src/api';
import { localPartOf, loginProblem, serverFieldErrors } from '../../src/setup-login';

describe('setup login', () => {
  it('takes a full address at our own domain as its local part', () => {
    expect(localPartOf('Matthew@D3cloud.io')).toBe('matthew');
    expect(localPartOf('matthew')).toBe('matthew');
    expect(loginProblem('matthew@d3cloud.io')).toBeNull();
  });

  it('refuses another domain by name, before anything is sent', () => {
    expect(loginProblem('matthew@demers.dev')).toMatch(/Just the name — it becomes name@d3cloud\.io/);
  });

  it('refuses characters a local part cannot hold', () => {
    expect(loginProblem('matt hew')).toMatch(/letters, digits/);
    expect(loginProblem('')).toBeNull();
  });
});

describe('serverFieldErrors', () => {
  it('maps each refused path to its field', () => {
    const err = new ApiError(400, 'invalid_request', {
      error: 'invalid_request',
      fields: [
        { path: 'login', message: 'foreign_domain' },
        { path: 'password', message: 'Too small' },
      ],
    });
    const fields = serverFieldErrors(err);
    expect(fields.login).toMatch(/Other domains are not hosted here/);
    expect(fields.password).toMatch(/at least 12/);
  });

  it('marks nothing for other errors, so the banner never points at an unmarked field', () => {
    expect(serverFieldErrors(new ApiError(403, 'setup_token_required', {}))).toEqual({});
    expect(serverFieldErrors(new ApiError(400, 'invalid_request', { error: 'invalid_request' }))).toEqual({});
    expect(serverFieldErrors(new Error('x'))).toEqual({});
  });
});
