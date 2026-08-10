import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { prisma } from '../lib/prisma';
import * as passwordLib from '../lib/password';
import { login, signup } from './auth.service';

vi.mock('../lib/password', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/password')>();
  return { ...actual, verifyPassword: vi.fn(actual.verifyPassword) };
});

async function resetDb() {
  await prisma.user.deleteMany();
  await prisma.organization.deleteMany();
}

beforeEach(resetDb);
afterAll(async () => {
  await resetDb();
  await prisma.$disconnect();
});

describe('signup', () => {
  it('creates an organization and user, returning a token', async () => {
    const result = await signup({
      organizationName: 'Acme Corp',
      email: 'founder@acme.test',
      password: 'super-secret-1',
    });

    expect(result.token).toBeTruthy();
    expect(result.user.email).toBe('founder@acme.test');
    expect(result.organization.name).toBe('Acme Corp');
    expect(result.organization.slug).toBe('acme-corp');
  });

  it('gives two organizations with the same name distinct slugs', async () => {
    const first = await signup({
      organizationName: 'Acme Corp',
      email: 'a@acme.test',
      password: 'super-secret-1',
    });
    const second = await signup({
      organizationName: 'Acme Corp',
      email: 'b@acme.test',
      password: 'super-secret-1',
    });

    expect(first.organization.slug).not.toBe(second.organization.slug);
  });

  it('rejects signup with an email already in use', async () => {
    await signup({
      organizationName: 'Acme Corp',
      email: 'dupe@acme.test',
      password: 'super-secret-1',
    });

    await expect(
      signup({
        organizationName: 'Other Corp',
        email: 'dupe@acme.test',
        password: 'another-secret',
      }),
    ).rejects.toMatchObject({ status: 409 });
  });
});

describe('login', () => {
  it('logs in with correct credentials', async () => {
    await signup({
      organizationName: 'Acme Corp',
      email: 'user@acme.test',
      password: 'super-secret-1',
    });

    const result = await login({ email: 'user@acme.test', password: 'super-secret-1' });

    expect(result.user.email).toBe('user@acme.test');
    expect(result.token).toBeTruthy();
  });

  it('rejects an unknown email', async () => {
    await expect(
      login({ email: 'nobody@acme.test', password: 'whatever' }),
    ).rejects.toMatchObject({ status: 401 });
  });

  it('rejects the wrong password', async () => {
    await signup({
      organizationName: 'Acme Corp',
      email: 'user2@acme.test',
      password: 'super-secret-1',
    });

    await expect(
      login({ email: 'user2@acme.test', password: 'wrong-password' }),
    ).rejects.toMatchObject({ status: 401 });
  });

  it('runs a password comparison even when the email is unregistered, to avoid leaking account existence via timing', async () => {
    const verifyPasswordSpy = vi.mocked(passwordLib.verifyPassword);
    verifyPasswordSpy.mockClear();

    await expect(
      login({ email: 'nobody-at-all@acme.test', password: 'whatever' }),
    ).rejects.toMatchObject({ status: 401 });

    expect(verifyPasswordSpy).toHaveBeenCalledTimes(1);
  });
});
