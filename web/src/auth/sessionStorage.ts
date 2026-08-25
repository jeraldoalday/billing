import type { Organization, User } from '../api/types';

/**
 * Where the signed-in session lives between page loads.
 *
 * The access token is kept in `localStorage` rather than a cookie on
 * purpose: the API authenticates with an `Authorization` header, so no
 * credential is ever attached to a cross-site request automatically and
 * there is nothing for a CSRF attack to ride on. The trade-off is that a
 * script running on this origin could read it, which is the same trade-off
 * every token-in-JS client makes.
 *
 * Every access is wrapped, because `localStorage` is not merely empty in a
 * hardened browser — reading it *throws* when site data is blocked, and an
 * unguarded read would take the whole app down at startup. When it is
 * unavailable the session simply lives in memory for the tab's lifetime.
 */

export const SESSION_STORAGE_KEY = 'billing.session';

export interface StoredSession {
  token: string;
  user: User;
  organization: Organization;
}

export interface SessionStore {
  read(): StoredSession | null;
  write(session: StoredSession): void;
  clear(): void;
}

function isStoredSession(value: unknown): value is StoredSession {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const candidate = value as Partial<StoredSession>;
  return (
    typeof candidate.token === 'string' &&
    candidate.token.length > 0 &&
    typeof candidate.user?.id === 'string' &&
    typeof candidate.organization?.id === 'string'
  );
}

/** A store backed by `localStorage`, degrading to memory if it is unusable. */
export function createSessionStore(storage: Storage | null = safeLocalStorage()): SessionStore {
  if (!storage) {
    return createMemorySessionStore();
  }

  return {
    read() {
      let raw: string | null;
      try {
        raw = storage.getItem(SESSION_STORAGE_KEY);
      } catch {
        return null;
      }
      if (!raw) {
        return null;
      }

      let parsed: unknown;
      try {
        parsed = JSON.parse(raw);
      } catch {
        // Something else wrote to our key, or an older shape is left over.
        // Drop it rather than crashing on every subsequent read.
        this.clear();
        return null;
      }

      if (!isStoredSession(parsed)) {
        this.clear();
        return null;
      }

      return parsed;
    },

    write(session) {
      try {
        storage.setItem(SESSION_STORAGE_KEY, JSON.stringify(session));
      } catch {
        // Quota exhausted or storage disabled mid-session: the session stays
        // valid for this tab, it just won't survive a reload.
      }
    },

    clear() {
      try {
        storage.removeItem(SESSION_STORAGE_KEY);
      } catch {
        // Nothing to do — there is no way to clear what we cannot touch.
      }
    },
  };
}

/** An in-memory store, used as the fallback and directly by tests. */
export function createMemorySessionStore(initial: StoredSession | null = null): SessionStore {
  let current = initial;
  return {
    read: () => current,
    write: (session) => {
      current = session;
    },
    clear: () => {
      current = null;
    },
  };
}

/**
 * `window.localStorage` when it is actually usable. Merely checking that
 * the property exists is not enough: Safari in private mode and browsers
 * configured to block site data expose it and throw on use, so this probes
 * a real write.
 */
export function safeLocalStorage(): Storage | null {
  try {
    const probeKey = '__billing_probe__';
    window.localStorage.setItem(probeKey, '1');
    window.localStorage.removeItem(probeKey);
    return window.localStorage;
  } catch {
    return null;
  }
}
