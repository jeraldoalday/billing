import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { ApiError } from '../api/client';
import { AppRoutes } from '../App';
import { EMPTY_SUMMARY, TEST_SESSION, renderApp, validationError } from '../test/renderApp';

const AUTH_OK = {
  token: 'tok_new_org',
  user: TEST_SESSION.user,
  organization: TEST_SESSION.organization,
};

async function fillSignup(
  overrides: { organizationName?: string; name?: string; email?: string; password?: string } = {},
) {
  await userEvent.type(
    screen.getByLabelText('Organization name'),
    overrides.organizationName ?? 'Acme Inc',
  );
  if (overrides.name) {
    await userEvent.type(screen.getByLabelText('Your name'), overrides.name);
  }
  await userEvent.type(screen.getByLabelText('Email'), overrides.email ?? 'owner@acme.test');
  await userEvent.type(screen.getByLabelText('Password'), overrides.password ?? 'secret123');
  await userEvent.click(screen.getByRole('button', { name: 'Create organization' }));
}

describe('SignupPage', () => {
  it('renders the signup form', async () => {
    renderApp(<AppRoutes />, { route: '/signup' });

    expect(
      await screen.findByRole('heading', { name: 'Create your organization' }),
    ).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Sign in' })).toHaveAttribute('href', '/login');
  });

  it('posts the new organization to /auth/signup', async () => {
    const { requests } = renderApp(<AppRoutes />, {
      route: '/signup',
      responses: { 'POST /auth/signup': AUTH_OK, 'GET /reports/summary': EMPTY_SUMMARY },
    });

    await fillSignup({ name: 'Ada Lovelace' });

    await waitFor(() => expect(requests.length).toBeGreaterThan(0));
    expect(requests[0]?.body).toEqual({
      organizationName: 'Acme Inc',
      name: 'Ada Lovelace',
      email: 'owner@acme.test',
      password: 'secret123',
    });
  });

  // The server's optional name is min(1); sending "" would be a 400.
  it('omits the optional name rather than sending an empty string', async () => {
    const { requests } = renderApp(<AppRoutes />, {
      route: '/signup',
      responses: { 'POST /auth/signup': AUTH_OK, 'GET /reports/summary': EMPTY_SUMMARY },
    });

    await fillSignup();

    await waitFor(() => expect(requests.length).toBeGreaterThan(0));
    expect(requests[0]?.body).not.toHaveProperty('name');
  });

  it('signs the new organization in', async () => {
    const { store } = renderApp(<AppRoutes />, {
      route: '/signup',
      responses: { 'POST /auth/signup': AUTH_OK, 'GET /reports/summary': EMPTY_SUMMARY },
    });

    await fillSignup();

    await waitFor(() => expect(store.read()?.token).toBe('tok_new_org'));
  });

  it('rejects a short password without calling the API', async () => {
    const { requests } = renderApp(<AppRoutes />, { route: '/signup' });

    await fillSignup({ password: 'short' });

    expect(await screen.findByText('Password must be at least 8 characters')).toBeInTheDocument();
    expect(requests).toHaveLength(0);
  });

  it('surfaces a duplicate email as the server phrased it', async () => {
    renderApp(<AppRoutes />, {
      route: '/signup',
      responses: {
        'POST /auth/signup': new ApiError(
          409,
          'CONFLICT',
          'An account with this email already exists',
        ),
      },
    });

    await fillSignup();

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'An account with this email already exists',
    );
  });

  it('places a field error from the server under its field', async () => {
    renderApp(<AppRoutes />, {
      route: '/signup',
      responses: {
        'POST /auth/signup': validationError({
          organizationName: ['String must contain at least 2 character(s)'],
        }),
      },
    });

    await fillSignup({ organizationName: 'A' });

    const input = await screen.findByLabelText('Organization name');
    await waitFor(() => expect(input).toHaveAttribute('aria-invalid', 'true'));
    expect(input).toHaveAccessibleDescription(/at least 2 character/);
  });

  it('re-enables the button after a failure', async () => {
    renderApp(<AppRoutes />, {
      route: '/signup',
      responses: {
        'POST /auth/signup': new ApiError(409, 'CONFLICT', 'An account with this email exists'),
      },
    });

    await fillSignup();
    await screen.findByRole('alert');

    expect(screen.getByRole('button', { name: 'Create organization' })).toBeEnabled();
  });
});
