import { describe, expect, it } from 'vitest';
import { INSECURE_DEFAULT_JWT_SECRET, parseEnv } from './env';

// A minimal valid source, so each test only has to override what it's
// actually exercising.
function baseEnv(overrides: Partial<NodeJS.ProcessEnv> = {}): NodeJS.ProcessEnv {
  return {
    NODE_ENV: 'development',
    JWT_SECRET: 'a-sufficiently-long-test-secret',
    ...overrides,
  } as NodeJS.ProcessEnv;
}

describe('parseEnv', () => {
  it('falls back to the insecure default secret outside production', () => {
    const env = parseEnv(baseEnv({ JWT_SECRET: undefined }));
    expect(env.JWT_SECRET).toBe(INSECURE_DEFAULT_JWT_SECRET);
  });

  it('refuses to start in production with no JWT_SECRET set', () => {
    expect(() => parseEnv(baseEnv({ NODE_ENV: 'production', JWT_SECRET: undefined }))).toThrow();
  });

  it('refuses to start in production if JWT_SECRET is still the checked-in default', () => {
    expect(() =>
      parseEnv(baseEnv({ NODE_ENV: 'production', JWT_SECRET: INSECURE_DEFAULT_JWT_SECRET })),
    ).toThrow();
  });

  it('starts in production once a real secret is set', () => {
    const env = parseEnv(baseEnv({ NODE_ENV: 'production', JWT_SECRET: 'a-real-production-secret' }));
    expect(env.JWT_SECRET).toBe('a-real-production-secret');
    expect(env.NODE_ENV).toBe('production');
  });

  it('defaults NODE_ENV to development', () => {
    const env = parseEnv(baseEnv({ NODE_ENV: undefined }));
    expect(env.NODE_ENV).toBe('development');
  });

  it('rejects a secret shorter than 16 characters', () => {
    expect(() => parseEnv(baseEnv({ JWT_SECRET: 'too-short' }))).toThrow();
  });
});
