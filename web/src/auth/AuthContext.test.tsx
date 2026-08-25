import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { ApiClient, ApiError } from '../api/client';
import { AuthProvider, useAuth } from './AuthContext';
import { createMemorySessionStore, type StoredSession } from './sessionStorage';

const SESSION: StoredSession = {
  token: 'tok_abc',
  user: { id: 'usr_1', email: 'owner@acme.test', name: 'Owner' },
  organization: { id: 'org_1', name: 'Acme', slug: 'acme' },
};

/**
 * Builds a provider whose client answers from a queue of canned responses,
 * keyed by "METHOD /path", and records what was asked for.
 */
function harness(responses: Record<string, unknown>) {
  const requests: Array<{ method: string; path: string; token: string | null }> = [];

  const createClient = (options: { getToken: () => string | null; onUnauthorized: () => void }) => {
    const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input));
      const method = init?.method ?? 'GET';
      const key = `${method} ${url.pathname}`;
      requests.push({ method, path: url.pathname, token: options.getToken() });

      const canned = responses[key];
      if (canned instanceof ApiError) {
        return {
          ok: false,
          status: canned.status,
          text: async () =>
            JSON.stringify({ error: { code: canned.code, message: canned.message } }),
        } as Response;
      }
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify(canned ?? {}),
      } as Response;
    }) as unknown as typeof fetch;

    return new ApiClient({ baseUrl: 'http://api.test', fetchImpl, ...options });
  };

  return { createClient, requests };
}

function Probe() {
  const { status, user, organization, login, signup, logout } = useAuth();

  return (
    <div>
      <p data-testid="status">{status}</p>
      <p data-testid="user">{user?.email ?? 'none'}</p>
      <p data-testid="org">{organization?.name ?? 'none'}</p>
      <button
        onClick={() => {
          void login({ email: 'owner@acme.test', password: 'secret123' }).catch(() => undefined);
        }}
      >
        log in
      </button>
      <button
        onClick={() => {
          void signup({
            organizationName: 'Acme',
            email: 'owner@acme.test',
            password: 'secret123',
          }).catch(() => undefined);
        }}
      >
        sign up
      </button>
      <button onClick={logout}>log out</button>
    </div>
  );
}

describe('AuthProvider', () => {
  it('settles as anonymous when there is no stored session', async () => {
    const { createClient, requests } = harness({});

    render(
      <AuthProvider store={createMemorySessionStore()} createClient={createClient}>
        <Probe />
      </AuthProvider>,
    );

    await waitFor(() => expect(screen.getByTestId('status')).toHaveTextContent('anonymous'));
    // Nothing to revalidate, so no request is made at all.
    expect(requests).toHaveLength(0);
  });

  it('revalidates a stored session against /auth/me', async () => {
    const { createClient, requests } = harness({
      'GET /auth/me': { user: SESSION.user, organization: SESSION.organization },
    });

    render(
      <AuthProvider store={createMemorySessionStore(SESSION)} createClient={createClient}>
        <Probe />
      </AuthProvider>,
    );

    await waitFor(() => expect(screen.getByTestId('status')).toHaveTextContent('authenticated'));
    expect(screen.getByTestId('user')).toHaveTextContent('owner@acme.test');
    expect(screen.getByTestId('org')).toHaveTextContent('Acme');
    expect(requests[0]).toMatchObject({ path: '/auth/me', token: 'tok_abc' });
  });

  // The stored copy of the user can be stale — a rename in another tab, or
  // an organization renamed since the token was issued.
  it('takes the server copy of the user over the stored one', async () => {
    const stale = { ...SESSION, user: { ...SESSION.user, name: 'Old Name' } };
    const store = createMemorySessionStore(stale);
    const { createClient } = harness({
      'GET /auth/me': {
        user: { ...SESSION.user, name: 'New Name' },
        organization: { ...SESSION.organization, name: 'Acme Inc' },
      },
    });

    render(
      <AuthProvider store={store} createClient={createClient}>
        <Probe />
      </AuthProvider>,
    );

    await waitFor(() => expect(screen.getByTestId('org')).toHaveTextContent('Acme Inc'));
    expect(store.read()?.user.name).toBe('New Name');
  });

  it('drops a stored session the API rejects', async () => {
    const store = createMemorySessionStore(SESSION);
    const { createClient } = harness({
      'GET /auth/me': new ApiError(401, 'UNAUTHORIZED', 'Invalid or expired token'),
    });

    render(
      <AuthProvider store={store} createClient={createClient}>
        <Probe />
      </AuthProvider>,
    );

    await waitFor(() => expect(screen.getByTestId('status')).toHaveTextContent('anonymous'));
    expect(store.read()).toBeNull();
  });

  it('stores the session a login returns', async () => {
    const store = createMemorySessionStore();
    const { createClient, requests } = harness({
      'POST /auth/login': {
        token: 'tok_fresh',
        user: SESSION.user,
        organization: SESSION.organization,
      },
    });

    render(
      <AuthProvider store={store} createClient={createClient}>
        <Probe />
      </AuthProvider>,
    );
    await waitFor(() => expect(screen.getByTestId('status')).toHaveTextContent('anonymous'));

    await userEvent.click(screen.getByRole('button', { name: 'log in' }));

    await waitFor(() => expect(screen.getByTestId('status')).toHaveTextContent('authenticated'));
    expect(store.read()?.token).toBe('tok_fresh');
    expect(requests.at(-1)).toMatchObject({ method: 'POST', path: '/auth/login' });
  });

  it('stores the session a signup returns', async () => {
    const store = createMemorySessionStore();
    const { createClient } = harness({
      'POST /auth/signup': {
        token: 'tok_new_org',
        user: SESSION.user,
        organization: { id: 'org_2', name: 'Acme', slug: 'acme-2' },
      },
    });

    render(
      <AuthProvider store={store} createClient={createClient}>
        <Probe />
      </AuthProvider>,
    );

    await userEvent.click(screen.getByRole('button', { name: 'sign up' }));

    await waitFor(() => expect(screen.getByTestId('status')).toHaveTextContent('authenticated'));
    expect(store.read()?.organization.slug).toBe('acme-2');
  });

  it('keeps the session when a login fails', async () => {
    const store = createMemorySessionStore();
    const { createClient } = harness({
      'POST /auth/login': new ApiError(401, 'UNAUTHORIZED', 'Invalid email or password'),
    });

    render(
      <AuthProvider store={store} createClient={createClient}>
        <Probe />
      </AuthProvider>,
    );

    await userEvent.click(screen.getByRole('button', { name: 'log in' }));

    await waitFor(() => expect(screen.getByTestId('status')).toHaveTextContent('anonymous'));
    expect(store.read()).toBeNull();
  });

  it('clears everything on logout', async () => {
    const store = createMemorySessionStore(SESSION);
    const { createClient } = harness({
      'GET /auth/me': { user: SESSION.user, organization: SESSION.organization },
    });

    render(
      <AuthProvider store={store} createClient={createClient}>
        <Probe />
      </AuthProvider>,
    );
    await waitFor(() => expect(screen.getByTestId('status')).toHaveTextContent('authenticated'));

    await userEvent.click(screen.getByRole('button', { name: 'log out' }));

    expect(screen.getByTestId('status')).toHaveTextContent('anonymous');
    expect(screen.getByTestId('user')).toHaveTextContent('none');
    expect(store.read()).toBeNull();
  });

  // The token is read per request through a ref, so a request made after a
  // login carries the new token without the client being rebuilt.
  it('sends the new token on requests made after logging in', async () => {
    const { createClient, requests } = harness({
      'POST /auth/login': {
        token: 'tok_fresh',
        user: SESSION.user,
        organization: SESSION.organization,
      },
      'GET /customers': { customers: [] },
    });

    function AfterLogin() {
      const { api, status } = useAuth();
      return (
        <button
          onClick={() => {
            void api.listCustomers().catch(() => undefined);
          }}
        >
          load {status}
        </button>
      );
    }

    render(
      <AuthProvider store={createMemorySessionStore()} createClient={createClient}>
        <Probe />
        <AfterLogin />
      </AuthProvider>,
    );

    await userEvent.click(screen.getByRole('button', { name: 'log in' }));
    await waitFor(() => expect(screen.getByTestId('status')).toHaveTextContent('authenticated'));
    await userEvent.click(screen.getByRole('button', { name: /^load/ }));

    await waitFor(() =>
      expect(requests.find((r) => r.path === '/customers')?.token).toBe('tok_fresh'),
    );
  });

  // Any 401 anywhere in the app means the session is over, not just one on
  // /auth/me during startup.
  it('signs out when any later request is rejected', async () => {
    const store = createMemorySessionStore(SESSION);
    const { createClient } = harness({
      'GET /auth/me': { user: SESSION.user, organization: SESSION.organization },
      'GET /customers': new ApiError(401, 'UNAUTHORIZED', 'Invalid or expired token'),
    });

    function LoadCustomers() {
      const { api } = useAuth();
      return (
        <button
          onClick={() => {
            void api.listCustomers().catch(() => undefined);
          }}
        >
          load customers
        </button>
      );
    }

    render(
      <AuthProvider store={store} createClient={createClient}>
        <Probe />
        <LoadCustomers />
      </AuthProvider>,
    );
    await waitFor(() => expect(screen.getByTestId('status')).toHaveTextContent('authenticated'));

    await userEvent.click(screen.getByRole('button', { name: 'load customers' }));

    await waitFor(() => expect(screen.getByTestId('status')).toHaveTextContent('anonymous'));
    expect(store.read()).toBeNull();
  });

  it('throws a useful error when useAuth is used outside the provider', () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    expect(() => render(<Probe />)).toThrow(/must be used inside an <AuthProvider>/);

    consoleError.mockRestore();
  });
});
