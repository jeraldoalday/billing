import { describe, expect, it } from 'vitest';
import { loginSchema, signupSchema, updateProfileSchema } from './auth';

describe('signupSchema', () => {
  it('trims and lowercases the email', () => {
    const result = signupSchema.parse({
      organizationName: 'Acme Corp',
      email: '  Founder@Acme.TEST  ',
      password: 'super-secret-1',
    });

    expect(result.email).toBe('founder@acme.test');
  });

  it('trims the organization name and display name', () => {
    const result = signupSchema.parse({
      organizationName: '  Acme Corp  ',
      email: 'founder@acme.test',
      password: 'super-secret-1',
      name: '  Jamie  ',
    });

    expect(result.organizationName).toBe('Acme Corp');
    expect(result.name).toBe('Jamie');
  });

  it('rejects a password below the minimum length', () => {
    expect(() =>
      signupSchema.parse({
        organizationName: 'Acme Corp',
        email: 'founder@acme.test',
        password: 'short1',
      }),
    ).toThrow();
  });

  it('rejects a password above the bcrypt-safe maximum length', () => {
    expect(() =>
      signupSchema.parse({
        organizationName: 'Acme Corp',
        email: 'founder@acme.test',
        password: 'a'.repeat(73),
      }),
    ).toThrow();
  });

  it('accepts a password at the boundary lengths', () => {
    expect(() =>
      signupSchema.parse({
        organizationName: 'Acme Corp',
        email: 'founder@acme.test',
        password: 'a'.repeat(8),
      }),
    ).not.toThrow();

    expect(() =>
      signupSchema.parse({
        organizationName: 'Acme Corp',
        email: 'founder@acme.test',
        password: 'a'.repeat(72),
      }),
    ).not.toThrow();
  });

  it('rejects a malformed email', () => {
    expect(() =>
      signupSchema.parse({
        organizationName: 'Acme Corp',
        email: 'not-an-email',
        password: 'super-secret-1',
      }),
    ).toThrow();
  });
});

describe('loginSchema', () => {
  it('normalizes the email the same way as signup', () => {
    const result = loginSchema.parse({ email: '  User@Example.com  ', password: 'anything' });

    expect(result.email).toBe('user@example.com');
  });

  it('rejects an empty password', () => {
    expect(() => loginSchema.parse({ email: 'user@example.com', password: '' })).toThrow();
  });
});

describe('updateProfileSchema', () => {
  it('allows updating just the name', () => {
    expect(() => updateProfileSchema.parse({ name: 'New Name' })).not.toThrow();
  });

  it('allows an empty payload', () => {
    expect(() => updateProfileSchema.parse({})).not.toThrow();
  });

  it('requires currentPassword when newPassword is set', () => {
    expect(() => updateProfileSchema.parse({ newPassword: 'brand-new-secret' })).toThrow();
  });

  it('accepts newPassword alongside currentPassword', () => {
    expect(() =>
      updateProfileSchema.parse({ currentPassword: 'old-secret', newPassword: 'brand-new-secret' }),
    ).not.toThrow();
  });

  it('rejects a newPassword below the minimum length', () => {
    expect(() =>
      updateProfileSchema.parse({ currentPassword: 'old-secret', newPassword: 'short1' }),
    ).toThrow();
  });
});
