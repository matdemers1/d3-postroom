import { describe, expect, it } from 'vitest';
import { appTitle } from '../../src/title';

describe('web', () => {
  it('names the app', () => {
    expect(appTitle()).toBe('Postroom');
  });
});
