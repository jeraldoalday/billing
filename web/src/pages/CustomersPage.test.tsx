import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { ApiError } from '../api/client';
import type { Customer } from '../api/types';
import { AppRoutes } from '../App';
import { TEST_SESSION, renderApp, validationError, type Responses } from '../test/renderApp';

const ME_OK = { user: TEST_SESSION.user, organization: TEST_SESSION.organization };

function makeCustomer(overrides: Partial<Customer> = {}): Customer {
  return {
    id: 'cus_1',
    organizationId: 'org_1',
    name: 'Ada Lovelace',
    email: 'ada@analytical.test',
    active: true,
    country: 'GB',
    taxId: null,
    taxExempt: false,
    createdAt: '2026-08-01T00:00:00.000Z',
    updatedAt: '2026-08-01T00:00:00.000Z',
    ...overrides,
  };
}

const CUSTOMERS = [
  makeCustomer(),
  makeCustomer({
    id: 'cus_2',
    name: 'Grace Hopper',
    email: 'grace@navy.test',
    active: false,
    country: 'US',
  }),
];

function renderCustomers(responses: Responses = {}) {
  return renderApp(<AppRoutes />, {
    route: '/customers',
    session: TEST_SESSION,
    responses: {
      'GET /auth/me': ME_OK,
      'GET /customers': { customers: CUSTOMERS },
      ...responses,
    },
  });
}

async function openNewCustomer() {
  await screen.findByRole('table', { name: 'Customers' });
  await userEvent.click(screen.getByRole('button', { name: 'New customer' }));
  return screen.getByRole('dialog', { name: 'New customer' });
}

describe('CustomersPage', () => {
  it('lists the organization customers', async () => {
    renderCustomers();

    const table = await screen.findByRole('table', { name: 'Customers' });
    expect(within(table).getByText('ada@analytical.test')).toBeInTheDocument();
    expect(within(table).getByText('grace@navy.test')).toBeInTheDocument();
    expect(within(table).getByRole('link', { name: 'Ada Lovelace' })).toHaveAttribute(
      'href',
      '/customers/cus_1',
    );
  });

  it('shows whether each customer is active', async () => {
    renderCustomers();

    const table = await screen.findByRole('table', { name: 'Customers' });
    expect(within(table).getByText('Active')).toBeInTheDocument();
    expect(within(table).getByText('Archived')).toBeInTheDocument();
  });

  it('asks the API for the whole list before any filter is chosen', async () => {
    const { requests } = renderCustomers();

    await screen.findByRole('table', { name: 'Customers' });
    const list = requests.filter((request) => request.path === '/customers');
    expect(list).toHaveLength(1);
    expect(list[0]?.query).toBe('');
  });

  // The status filter is a real column, so it is a server-side query rather
  // than something filtered out of a page of results in the browser.
  it('re-queries the API when the status filter changes', async () => {
    const { requests } = renderCustomers();

    await screen.findByRole('table', { name: 'Customers' });
    await userEvent.selectOptions(screen.getByLabelText('Status'), 'inactive');

    await waitFor(() => {
      const list = requests.filter((request) => request.path === '/customers');
      expect(list).toHaveLength(2);
      expect(list[1]?.query).toBe('?active=false');
    });
  });

  // Search is client-side: the API's email filter is an exact match, which
  // is useless for typing three letters of a name.
  it('filters the loaded rows by name or email without another request', async () => {
    const { requests } = renderCustomers();

    await screen.findByRole('table', { name: 'Customers' });
    await userEvent.type(screen.getByLabelText('Search'), 'grace');

    await waitFor(() => {
      expect(screen.queryByText('ada@analytical.test')).not.toBeInTheDocument();
    });
    expect(screen.getByText('grace@navy.test')).toBeInTheDocument();
    expect(requests.filter((request) => request.path === '/customers')).toHaveLength(1);
  });

  it('says when a search matched nothing', async () => {
    renderCustomers();

    await screen.findByRole('table', { name: 'Customers' });
    await userEvent.type(screen.getByLabelText('Search'), 'zzz');

    expect(await screen.findByText('No matching customers')).toBeInTheDocument();
  });

  it('invites the first customer when there are none', async () => {
    renderCustomers({ 'GET /customers': { customers: [] } });

    expect(await screen.findByText('No customers yet')).toBeInTheDocument();
  });

  it('reports a failed load and retries', async () => {
    const { requests } = renderCustomers({
      'GET /customers': new ApiError(500, 'ERROR', 'Server error'),
    });

    await screen.findByText('Could not load this page');
    await userEvent.click(screen.getByRole('button', { name: 'Try again' }));

    await waitFor(() => {
      expect(requests.filter((request) => request.path === '/customers')).toHaveLength(2);
    });
  });

  it('creates a customer and reloads the list', async () => {
    const created = makeCustomer({ id: 'cus_3', name: 'Alan Turing', email: 'alan@bletchley.test' });
    const { requests } = renderCustomers({ 'POST /customers': { customer: created } });

    const dialog = await openNewCustomer();
    await userEvent.type(within(dialog).getByLabelText('Name'), 'Alan Turing');
    await userEvent.type(within(dialog).getByLabelText('Email'), 'alan@bletchley.test');
    await userEvent.type(within(dialog).getByLabelText('Country'), 'gb');
    await userEvent.click(within(dialog).getByLabelText('Tax exempt'));
    await userEvent.click(within(dialog).getByRole('button', { name: 'Create customer' }));

    await waitFor(() => {
      expect(screen.queryByRole('dialog', { name: 'New customer' })).not.toBeInTheDocument();
    });

    const post = requests.find((request) => request.method === 'POST');
    expect(post?.body).toEqual({
      name: 'Alan Turing',
      email: 'alan@bletchley.test',
      country: 'GB',
      taxExempt: true,
    });
    // The list is re-read rather than patched in memory, so what is on
    // screen is what the server actually has.
    expect(requests.filter((request) => request.path === '/customers')).toHaveLength(3);
  });

  it('reports a missing name and email without calling the API', async () => {
    const { requests } = renderCustomers();

    const dialog = await openNewCustomer();
    await userEvent.click(within(dialog).getByRole('button', { name: 'Create customer' }));

    expect(await within(dialog).findByText('Enter a name')).toBeInTheDocument();
    expect(within(dialog).getByText('Enter an email address')).toBeInTheDocument();
    expect(requests.some((request) => request.method === 'POST')).toBe(false);
  });

  it('keeps the dialog open and shows what the server rejected', async () => {
    renderCustomers({
      'POST /customers': validationError({ email: ['A customer with this email already exists'] }),
    });

    const dialog = await openNewCustomer();
    await userEvent.type(within(dialog).getByLabelText('Name'), 'Ada');
    await userEvent.type(within(dialog).getByLabelText('Email'), 'ada@analytical.test');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Create customer' }));

    expect(
      await within(dialog).findByText('A customer with this email already exists'),
    ).toBeInTheDocument();
    expect(screen.getByRole('dialog', { name: 'New customer' })).toBeInTheDocument();
  });

  it('shows a conflict from the server above the form', async () => {
    renderCustomers({
      'POST /customers': new ApiError(409, 'CONFLICT', 'A customer with this email already exists'),
    });

    const dialog = await openNewCustomer();
    await userEvent.type(within(dialog).getByLabelText('Name'), 'Ada');
    await userEvent.type(within(dialog).getByLabelText('Email'), 'ada@analytical.test');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Create customer' }));

    expect(await within(dialog).findByRole('alert')).toHaveTextContent(
      'A customer with this email already exists',
    );
  });

  it('closes the dialog without creating anything on cancel', async () => {
    const { requests } = renderCustomers();

    const dialog = await openNewCustomer();
    await userEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));

    await waitFor(() => {
      expect(screen.queryByRole('dialog', { name: 'New customer' })).not.toBeInTheDocument();
    });
    expect(requests.some((request) => request.method === 'POST')).toBe(false);
  });
});
