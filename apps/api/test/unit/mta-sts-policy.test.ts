// PST-T-4.12, PST-REQ-094: the pure policy builder. No db, no network.
import { describe, expect, it } from 'vitest';
import { MtaStsConfigError, mtaStsEnvConfig, mtaStsPolicyId, renderMtaStsPolicy } from '../../src/mta-sts/policy.js';

describe('mtaStsEnvConfig', () => {
  it('defaults to testing mode, the given mx host and an 86400s max_age', () => {
    const config = mtaStsEnvConfig({}, 'mx.d3cloud.io');
    expect(config).toEqual({ mode: 'testing', mxHost: 'mx.d3cloud.io', maxAge: 86_400 });
  });

  it('accepts enforce and none', () => {
    expect(mtaStsEnvConfig({ MTA_STS_MODE: 'enforce' }, 'mx.d3cloud.io').mode).toBe('enforce');
    expect(mtaStsEnvConfig({ MTA_STS_MODE: 'none' }, 'mx.d3cloud.io').mode).toBe('none');
  });

  it('rejects an unknown mode', () => {
    expect(() => mtaStsEnvConfig({ MTA_STS_MODE: 'strict' }, 'mx.d3cloud.io')).toThrow(MtaStsConfigError);
  });

  it('reads MTA_STS_MAX_AGE', () => {
    expect(mtaStsEnvConfig({ MTA_STS_MAX_AGE: '3600' }, 'mx.d3cloud.io').maxAge).toBe(3600);
  });

  it('rejects a non-integer max_age', () => {
    expect(() => mtaStsEnvConfig({ MTA_STS_MAX_AGE: 'soon' }, 'mx.d3cloud.io')).toThrow(MtaStsConfigError);
  });

  it('rejects a max_age of zero or below', () => {
    expect(() => mtaStsEnvConfig({ MTA_STS_MAX_AGE: '0' }, 'mx.d3cloud.io')).toThrow(MtaStsConfigError);
    expect(() => mtaStsEnvConfig({ MTA_STS_MAX_AGE: '-1' }, 'mx.d3cloud.io')).toThrow(MtaStsConfigError);
  });

  it('rejects a max_age over the RFC 8461 ceiling', () => {
    expect(() => mtaStsEnvConfig({ MTA_STS_MAX_AGE: '31557601' }, 'mx.d3cloud.io')).toThrow(MtaStsConfigError);
  });

  it('MX_HOSTNAME overrides the default mx host', () => {
    expect(mtaStsEnvConfig({ MX_HOSTNAME: 'mx.example.test' }, 'mx.d3cloud.io').mxHost).toBe('mx.example.test');
  });
});

describe('renderMtaStsPolicy', () => {
  it('renders version, mode, mx and max_age as RFC 8461 §3.2 lines', () => {
    const text = renderMtaStsPolicy({ mode: 'testing', mxHost: 'mx.d3cloud.io', maxAge: 86_400 });
    expect(text).toBe('version: STSv1\nmode: testing\nmx: mx.d3cloud.io\nmax_age: 86400\n');
  });
});

describe('mtaStsPolicyId', () => {
  it('is deterministic and 1-32 alphanumeric characters (RFC 8461 §3.1)', () => {
    const text = renderMtaStsPolicy({ mode: 'testing', mxHost: 'mx.d3cloud.io', maxAge: 86_400 });
    const id = mtaStsPolicyId(text);
    expect(id).toMatch(/^[A-Za-z0-9]{1,32}$/);
    expect(mtaStsPolicyId(text)).toBe(id);
  });

  it('changes when the policy body changes', () => {
    const testing = renderMtaStsPolicy({ mode: 'testing', mxHost: 'mx.d3cloud.io', maxAge: 86_400 });
    const enforce = renderMtaStsPolicy({ mode: 'enforce', mxHost: 'mx.d3cloud.io', maxAge: 86_400 });
    expect(mtaStsPolicyId(testing)).not.toBe(mtaStsPolicyId(enforce));
  });

  it('does not change when the policy body does not', () => {
    const a = renderMtaStsPolicy({ mode: 'testing', mxHost: 'mx.d3cloud.io', maxAge: 86_400 });
    const b = renderMtaStsPolicy({ mode: 'testing', mxHost: 'mx.d3cloud.io', maxAge: 86_400 });
    expect(mtaStsPolicyId(a)).toBe(mtaStsPolicyId(b));
  });
});
