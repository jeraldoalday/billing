import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { ApiClient, resolveApiBaseUrl } from '../api/client';
import type { Organization, User } from '../api/types';
import { createSessionStore, type SessionStore, type StoredSession } from './sessionStorage';

/**
 * Holds the signed-in session and the one `ApiClient` every page uses.
 *
 * The client is built once and reads its token through a ref, so a login
 * does not rebuild it — which matters because rebuilding it would change
 * the identity of the object components list in their effect dependencies
 * and re-fire every request in the app.
 *
 * On mount a stored session is revalidated against `GET /auth/me`. A token
 * in localStorage proves only that a login happened at some point; it may
 * have expired, or the account may be gone. Until that call settles the
 * app renders nothing routable, so a protected page never flashes for a
 * session that turns out to be dead.
 */

export type AuthStatus = 'loading' | 'authenticated' | 'anonymous';

export interface AuthContextValue {
  status: AuthStatus;
  user: User | null;
  organization: Organization | null;
  api: ApiClient;
  login(input: { email: string; password: string }): Promise<void>;
  signup(input: {
    organizationName: string;
    email: string;
    password: string;
    name?: string;
  }): Promise<void>;
  logout(): void;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export interface AuthProviderProps {
  children: ReactNode;
  /** Injectable for tests; defaults to localStorage with a memory fallback. */
  store?: SessionStore;
  /** Injectable for tests; defaults to a client pointed at VITE_API_BASE_URL. */
  createClient?: (options: {
    getToken: () => string | null;
    onUnauthorized: () => void;
  }) => ApiClient;
}

export function AuthProvider({ children, store, createClient }: AuthProviderProps) {
  const sessionStore = useMemo(() => store ?? createSessionStore(), [store]);
  const [session, setSession] = useState<StoredSession | null>(() => sessionStore.read());
  const [status, setStatus] = useState<AuthStatus>(() =>
    sessionStore.read() ? 'loading' : 'anonymous',
  );

  // The client reads the token through this ref rather than through state,
  // so it always sees the current value without being rebuilt.
  const tokenRef = useRef<string | null>(session?.token ?? null);
  tokenRef.current = session?.token ?? null;

  const clearSession = useCallback(() => {
    tokenRef.current = null;
    sessionStore.clear();
    setSession(null);
    setStatus('anonymous');
  }, [sessionStore]);

  const api = useMemo(() => {
    const options = {
      getToken: () => tokenRef.current,
      onUnauthorized: () => {
        // Any request rejecting the token means the session is over,
        // wherever in the app it happened.
        clearSession();
      },
    };
    if (createClient) {
      return createClient(options);
    }
    return new ApiClient({
      baseUrl: resolveApiBaseUrl(import.meta.env as unknown as Record<string, string | undefined>),
      ...options,
    });
  }, [createClient, clearSession]);

  useEffect(() => {
    const stored = sessionStore.read();
    if (!stored) {
      setStatus('anonymous');
      return;
    }

    const controller = new AbortController();
    let active = true;

    api
      .me(controller.signal)
      .then((fresh) => {
        if (!active) return;
        // Take the server's copy: the name or the org may have changed
        // since the session was written.
        const refreshed: StoredSession = {
          token: stored.token,
          user: fresh.user,
          organization: fresh.organization,
        };
        sessionStore.write(refreshed);
        setSession(refreshed);
        setStatus('authenticated');
      })
      .catch((error: unknown) => {
        if (!active) return;
        if (error instanceof DOMException && error.name === 'AbortError') {
          return;
        }
        // A 401 already cleared the session through onUnauthorized. Any
        // other failure (the API being down) must not silently sign the
        // user out of a session that may still be good — but there is
        // nothing to render against either, so treat it as anonymous and
        // let them sign in again once the API is back.
        clearSession();
      });

    return () => {
      active = false;
      controller.abort();
    };
    // Runs once for the client this provider built; login/logout drive the
    // session directly rather than through this effect.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [api]);

  const adoptSession = useCallback(
    (next: StoredSession) => {
      tokenRef.current = next.token;
      sessionStore.write(next);
      setSession(next);
      setStatus('authenticated');
    },
    [sessionStore],
  );

  const login = useCallback(
    async (input: { email: string; password: string }) => {
      const result = await api.login(input);
      adoptSession({
        token: result.token,
        user: result.user,
        organization: result.organization,
      });
    },
    [api, adoptSession],
  );

  const signup = useCallback(
    async (input: { organizationName: string; email: string; password: string; name?: string }) => {
      const result = await api.signup(input);
      adoptSession({
        token: result.token,
        user: result.user,
        organization: result.organization,
      });
    },
    [api, adoptSession],
  );

  const value = useMemo<AuthContextValue>(
    () => ({
      status,
      user: session?.user ?? null,
      organization: session?.organization ?? null,
      api,
      login,
      signup,
      logout: clearSession,
    }),
    [status, session, api, login, signup, clearSession],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const value = useContext(AuthContext);
  if (!value) {
    throw new Error('useAuth must be used inside an <AuthProvider>');
  }
  return value;
}
