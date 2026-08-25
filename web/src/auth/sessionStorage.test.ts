import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  SESSION_STORAGE_KEY,
  createMemorySessionStore,
  createSessionStore,
  safeLocalStorage,
  type StoredSession,
} from './sessionStorage';

const SESSION: StoredSession = {
  token: 'tok_abc',
  user: { id: 'usr_1', email: 'owner@acme.test', name: 'Owner' },
  organization: { id: 'org_1', name: 'Acme', slug: 'acme' },
};

describe('createSessionStore', () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  it('round-trips a session through localStorage', () => {
    const store = createSessionStore(window.localStorage);

    store.write(SESSION);

    expect(createSessionStore(window.localStorage).read()).toEqual(SESSION);
  });

  it('reads null when nothing is stored', () => {
    expect(createSessionStore(window.localStorage).read()).toBeNull();
  });

  it('clears the stored session', () => {
    const store = createSessionStore(window.localStorage);
    store.write(SESSION);

    store.clear();

    expect(store.read()).toBeNull();
    expect(window.localStorage.getItem(SESSION_STORAGE_KEY)).toBeNull();
  });

  // Left-over data from an older build of the app, or another script
  // writing to the key, must not make every startup throw.
  it('discards a value that is not JSON', () => {
    window.localStorage.setItem(SESSION_STORAGE_KEY, 'not-json{');
    const store = createSessionStore(window.localStorage);

    expect(store.read()).toBeNull();
    expect(window.localStorage.getItem(SESSION_STORAGE_KEY)).toBeNull();
  });

  it('discards JSON that is not a session', () => {
    window.localStorage.setItem(SESSION_STORAGE_KEY, JSON.stringify({ token: '' }));
    const store = createSessionStore(window.localStorage);

    expect(store.read()).toBeNull();
  });

  it('discards a session missing its user or organization', () => {
    window.localStorage.setItem(SESSION_STORAGE_KEY, JSON.stringify({ token: 'tok', user: {} }));

    expect(createSessionStore(window.localStorage).read()).toBeNull();
  });

  it('survives storage that throws on read', () => {
    const hostile = {
      getItem: () => {
        throw new Error('SecurityError');
      },
      setItem: () => undefined,
      removeItem: () => undefined,
    } as unknown as Storage;

    expect(createSessionStore(hostile).read()).toBeNull();
  });

  it('survives storage that throws on write', () => {
    const full = {
      getItem: () => null,
      setItem: () => {
        throw new Error('QuotaExceededError');
      },
      removeItem: () => undefined,
    } as unknown as Storage;

    expect(() => createSessionStore(full).write(SESSION)).not.toThrow();
  });

  it('falls back to memory when there is no storage at all', () => {
    const store = createSessionStore(null);

    store.write(SESSION);

    expect(store.read()).toEqual(SESSION);
    expect(window.localStorage.getItem(SESSION_STORAGE_KEY)).toBeNull();
  });
});

describe('createMemorySessionStore', () => {
  it('starts from the session it is seeded with', () => {
    expect(createMemorySessionStore(SESSION).read()).toEqual(SESSION);
  });

  it('starts empty by default', () => {
    expect(createMemorySessionStore().read()).toBeNull();
  });

  it('overwrites and clears', () => {
    const store = createMemorySessionStore(SESSION);

    store.write({ ...SESSION, token: 'tok_new' });
    expect(store.read()?.token).toBe('tok_new');

    store.clear();
    expect(store.read()).toBeNull();
  });
});

describe('safeLocalStorage', () => {
  it('returns the real storage when it works', () => {
    expect(safeLocalStorage()).toBe(window.localStorage);
  });

  it('returns null when a probe write throws', () => {
    const spy = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('site data blocked');
    });

    expect(safeLocalStorage()).toBeNull();

    spy.mockRestore();
  });

  // The probe must not leave its own key behind in a working browser.
  it('cleans up after its probe', () => {
    safeLocalStorage();

    expect(window.localStorage.length).toBe(0);
  });
});
