import { describe, expect, it } from 'vitest';
import { loadConfigFromEnv, roleForPort } from '../../src/config.js';

describe('roleForPort', () => {
  it('maps the canonical ports', () => {
    expect(roleForPort(25)).toBe('smtp');
    expect(roleForPort(587)).toBe('submission-starttls');
    expect(roleForPort(465)).toBe('implicit-tls');
    expect(roleForPort(993)).toBe('implicit-tls');
    expect(roleForPort(4190)).toBe('sieve');
  });

  it('throws for an unknown port', () => {
    expect(() => roleForPort(2525)).toThrow();
  });
});

describe('loadConfigFromEnv', () => {
  it('applies every default when env is empty', () => {
    const config = loadConfigFromEnv({});
    expect(config.listenHost).toBe('0.0.0.0');
    expect(config.listeners.map((l) => l.port)).toEqual([25, 465, 587, 993, 4190]);
    expect(config.listeners.map((l) => l.role)).toEqual([
      'smtp',
      'implicit-tls',
      'submission-starttls',
      'implicit-tls',
      'sieve',
    ]);
    expect(config.maxPerIp).toBe(20);
    expect(config.maxTotal).toBe(1000);
    expect(config.connectTimeoutMs).toBe(5000);
    expect(config.idleTimeoutMs).toBe(600_000);
  });

  it('treats a blank env value as unset', () => {
    const config = loadConfigFromEnv({
      EDGE_LISTEN_HOST: '',
      EDGE_PORTS: '  ',
      EDGE_MAX_PER_IP: '',
      HOME_HOST: '10.77.0.2',
    });
    expect(config.listenHost).toBe('0.0.0.0');
    expect(config.listeners.map((l) => l.port)).toEqual([25, 465, 587, 993, 4190]);
    expect(config.maxPerIp).toBe(20);
    expect(config.homeHost).toBe('10.77.0.2');
  });

  it('parses explicit overrides', () => {
    const config = loadConfigFromEnv({
      EDGE_LISTEN_HOST: '127.0.0.1',
      EDGE_PORTS: '25,587',
      EDGE_MAX_PER_IP: '5',
      EDGE_MAX_TOTAL: '50',
      EDGE_CONNECT_TIMEOUT_MS: '1000',
      EDGE_IDLE_TIMEOUT_MS: '2000',
      HOME_HOST: '10.77.0.2',
    });
    expect(config.listenHost).toBe('127.0.0.1');
    expect(config.listeners).toEqual([
      { port: 25, role: 'smtp', homePort: 25 },
      { port: 587, role: 'submission-starttls', homePort: 587 },
    ]);
    expect(config.maxPerIp).toBe(5);
    expect(config.maxTotal).toBe(50);
    expect(config.connectTimeoutMs).toBe(1000);
    expect(config.idleTimeoutMs).toBe(2000);
    expect(config.homeHost).toBe('10.77.0.2');
  });
});
