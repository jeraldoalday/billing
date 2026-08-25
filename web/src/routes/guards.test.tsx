import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { ApiError } from '../api/client';
import { AppRoutes } from '../App';
import { TEST_SESSION, renderApp } from '../test/renderApp';

const ME_OK = { user: TEST_SESSION.user, organization: TEST_SESSION.organization };

describe('route guards', () => {
  it('sends an anonymous visitor from a protected page to /login', async () => {
    renderApp(<AppRoutes />, { route: '/customers' });

    expect(await screen.findByRole('heading', { name: 'Sign in' })).toBeInTheDocument();
  });

  // Redirecting while the stored session is still being revalidated would
  // bounce a returning user to /login on every refresh.
  it('waits for revalidation instead of redirecting a returning user', async () => {
    renderApp(<AppRoutes />, {
      route: '/customers',
      session: TEST_SESSION,
      responses: { 'GET /auth/me': ME_OK },
    });

    expect(screen.getByRole('status')).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Sign in' })).not.toBeInTheDocument();

    await waitFor(() => expect(screen.queryByRole('status')).not.toBeInTheDocument());
  });

  it('renders the app shell once the session checks out', async () => {
    renderApp(<AppRoutes />, {
      route: '/',
      session: TEST_SESSION,
      responses: { 'GET /auth/me': ME_OK, 'GET /reports/summary': {} },
    });

    expect(await screen.findByRole('navigation', { name: 'Main' })).toBeInTheDocument();
    // The org name renders twice: the sidebar and the mobile header.
    expect(screen.getAllByText('Acme Inc').length).toBeGreaterThan(0);
    expect(screen.getByText('owner@acme.test')).toBeInTheDocument();
  });

  it('falls back to /login when the stored token has expired', async () => {
    const { store } = renderApp(<AppRoutes />, {
      route: '/',
      session: TEST_SESSION,
      responses: {
        'GET /auth/me': new ApiError(401, 'UNAUTHORIZED', 'Invalid or expired token'),
      },
    });

    expect(await screen.findByRole('heading', { name: 'Sign in' })).toBeInTheDocument();
    expect(store.read()).toBeNull();
  });

  it('returns the user to the page they were sent away from', async () => {
    renderApp(<AppRoutes />, {
      route: '/no-such-page',
      responses: {
        'POST /auth/login': {
          token: 'tok_fresh',
          user: TEST_SESSION.user,
          organization: TEST_SESSION.organization,
        },
      },
    });

    await screen.findByRole('heading', { name: 'Sign in' });
    await userEvent.type(screen.getByLabelText('Email'), 'owner@acme.test');
    await userEvent.type(screen.getByLabelText('Password'), 'secret123');
    await userEvent.click(screen.getByRole('button', { name: 'Sign in' }));

    // Back to the requested path, which happens to be a 404 inside the shell
    // — the point is that it is not the dashboard.
    expect(await screen.findByRole('heading', { name: 'Page not found' })).toBeInTheDocument();
  });

  it('signs the user out from the shell', async () => {
    const { store } = renderApp(<AppRoutes />, {
      route: '/',
      session: TEST_SESSION,
      responses: { 'GET /auth/me': ME_OK, 'GET /reports/summary': {} },
    });
    await screen.findByRole('navigation', { name: 'Main' });

    await userEvent.click(screen.getByRole('button', { name: 'Sign out' }));

    expect(await screen.findByRole('heading', { name: 'Sign in' })).toBeInTheDocument();
    expect(store.read()).toBeNull();
  });

  it('shows a 404 page for an unknown path inside the shell', async () => {
    renderApp(<AppRoutes />, {
      route: '/nowhere',
      session: TEST_SESSION,
      responses: { 'GET /auth/me': ME_OK },
    });

    expect(await screen.findByRole('heading', { name: 'Page not found' })).toBeInTheDocument();
  });
});
