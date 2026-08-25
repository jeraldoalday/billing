import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { ApiError } from '../api/client';
import { AppRoutes } from '../App';
import { EMPTY_SUMMARY, TEST_SESSION, renderApp, validationError } from '../test/renderApp';

const AUTH_OK = {
  token: 'tok_fresh',
  user: TEST_SESSION.user,
  organization: TEST_SESSION.organization,
};

async function fillLogin(email = 'owner@acme.test', password = 'secret123') {
  await userEvent.type(screen.getByLabelText('Email'), email);
  await userEvent.type(screen.getByLabelText('Password'), password);
  await userEvent.click(screen.getByRole('button', { name: 'Sign in' }));
}

describe('LoginPage', () => {
  it('renders the sign-in form', async () => {
    renderApp(<AppRoutes />, { route: '/login' });

    expect(await screen.findByRole('heading', { name: 'Sign in' })).toBeInTheDocument();
    expect(screen.getByLabelText('Email')).toBeInTheDocument();
    expect(screen.getByLabelText('Password')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Create one' })).toHaveAttribute('href', '/signup');
  });

  it('posts the credentials to /auth/login', async () => {
    const { requests } = renderApp(<AppRoutes />, {
      route: '/login',
      responses: { 'POST /auth/login': AUTH_OK },
    });

    await fillLogin();

    await waitFor(() => expect(requests).toHaveLength(1));
    expect(requests[0]).toMatchObject({
      method: 'POST',
      path: '/auth/login',
      body: { email: 'owner@acme.test', password: 'secret123' },
    });
  });

  it('stores the session and leaves the login page on success', async () => {
    const { store } = renderApp(<AppRoutes />, {
      route: '/login',
      responses: {
        'POST /auth/login': AUTH_OK,
        'GET /reports/summary': EMPTY_SUMMARY,
      },
    });

    await fillLogin();

    await waitFor(() => expect(store.read()?.token).toBe('tok_fresh'));
    expect(screen.queryByRole('heading', { name: 'Sign in' })).not.toBeInTheDocument();
  });

  it("shows the server's message when the credentials are wrong", async () => {
    renderApp(<AppRoutes />, {
      route: '/login',
      responses: {
        'POST /auth/login': new ApiError(401, 'UNAUTHORIZED', 'Invalid email or password'),
      },
    });

    await fillLogin('owner@acme.test', 'wrongpassword');

    expect(await screen.findByRole('alert')).toHaveTextContent('Invalid email or password');
    // Still on the form, with what was typed intact.
    expect(screen.getByLabelText('Email')).toHaveValue('owner@acme.test');
  });

  it('puts a validation message under the field it belongs to', async () => {
    renderApp(<AppRoutes />, {
      route: '/login',
      responses: {
        'POST /auth/login': validationError({ email: ['Invalid email'] }),
      },
    });

    await fillLogin('not-an-email', 'secret123');

    const emailInput = await screen.findByLabelText('Email');
    await waitFor(() => expect(emailInput).toHaveAttribute('aria-invalid', 'true'));
    expect(emailInput).toHaveAccessibleDescription('Invalid email');
  });

  it('explains an unreachable API instead of leaking a fetch failure', async () => {
    renderApp(<AppRoutes />, {
      route: '/login',
      responses: { 'POST /auth/login': new TypeError('Failed to fetch') },
    });

    await fillLogin();

    expect(await screen.findByRole('alert')).toHaveTextContent('Could not reach the billing API');
  });

  it('lets the user try again after a failure', async () => {
    const { requests } = renderApp(<AppRoutes />, {
      route: '/login',
      responses: {
        'POST /auth/login': new ApiError(401, 'UNAUTHORIZED', 'Invalid email or password'),
      },
    });

    await fillLogin();
    await screen.findByRole('alert');
    await userEvent.click(screen.getByRole('button', { name: 'Sign in' }));

    await waitFor(() => expect(requests).toHaveLength(2));
  });

  it('sends a signed-in visitor away from the login page', async () => {
    renderApp(<AppRoutes />, {
      route: '/login',
      session: TEST_SESSION,
      responses: {
        'GET /auth/me': { user: TEST_SESSION.user, organization: TEST_SESSION.organization },
        'GET /reports/summary': EMPTY_SUMMARY,
      },
    });

    await waitFor(() =>
      expect(screen.queryByRole('heading', { name: 'Sign in' })).not.toBeInTheDocument(),
    );
  });
});
