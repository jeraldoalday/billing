import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { ApiError } from '../api/client';
import type { Customer, Invoice, Subscription } from '../api/types';
import { AppRoutes } from '../App';
import { TEST_SESSION, renderApp, validationError, type Responses } from '../test/renderApp';
import { summarizeInvoices } from './CustomerDetailPage';

const ME_OK = { user: TEST_SESSION.user, organization: TEST_SESSION.organization };

const CUSTOMER: Customer = {
  id: 'cus_1',
  organizationId: 'org_1',
  name: 'Ada Lovelace',
  email: 'ada@analytical.test',
  active: true,
  country: 'GB',
  taxId: 'GB123456789',
  taxExempt: false,
  createdAt: '2026-06-01T00:00:00.000Z',
  updatedAt: '2026-08-01T00:00:00.000Z',
};

function makeInvoice(overrides: Partial<Invoice> = {}): Invoice {
  return {
    id: 'in_1',
    organizationId: 'org_1',
    customerId: 'cus_1',
    subscriptionId: 'sub_1',
    number: 'INV-0001',
    status: 'PAID',
    currency: 'usd',
    periodStart: '2026-07-01T00:00:00.000Z',
    periodEnd: '2026-08-01T00:00:00.000Z',
    subtotal: 1999,
    discountAmount: 0,
    taxAmount: 0,
    total: 1999,
    issuedAt: '2026-07-01T00:00:00.000Z',
    paidAt: '2026-07-02T00:00:00.000Z',
    voidedAt: null,
    createdAt: '2026-07-01T00:00:00.000Z',
    updatedAt: '2026-07-02T00:00:00.000Z',
    ...overrides,
  };
}

const SUBSCRIPTION: Subscription = {
  id: 'sub_1',
  organizationId: 'org_1',
  customerId: 'cus_1',
  planId: 'plan_1',
  status: 'ACTIVE',
  currentPeriodStart: '2026-08-01T00:00:00.000Z',
  currentPeriodEnd: '2026-09-01T00:00:00.000Z',
  trialEnd: null,
  cancelAt: null,
  canceledAt: null,
  createdAt: '2026-06-01T00:00:00.000Z',
  updatedAt: '2026-08-01T00:00:00.000Z',
  plan: {
    id: 'plan_1',
    organizationId: 'org_1',
    productId: 'prod_1',
    name: 'Pro monthly',
    pricingModel: 'FLAT',
    interval: 'MONTH',
    currency: 'usd',
    flatAmount: 1999,
    usageMetric: null,
    usageUnitAmount: null,
    active: true,
    createdAt: '2026-06-01T00:00:00.000Z',
    updatedAt: '2026-06-01T00:00:00.000Z',
  },
};

function renderDetail(responses: Responses = {}) {
  return renderApp(<AppRoutes />, {
    route: '/customers/cus_1',
    session: TEST_SESSION,
    responses: {
      'GET /auth/me': ME_OK,
      'GET /customers/cus_1': { customer: CUSTOMER },
      'GET /subscriptions': { subscriptions: [SUBSCRIPTION] },
      'GET /invoices': {
        invoices: [
          makeInvoice(),
          makeInvoice({ id: 'in_2', number: 'INV-0002', status: 'OPEN', total: 2500, paidAt: null }),
        ],
      },
      ...responses,
    },
  });
}

async function openEditor() {
  await screen.findByRole('heading', { name: 'Ada Lovelace' });
  await userEvent.click(screen.getByRole('button', { name: 'Edit customer' }));
  return screen.getByRole('dialog', { name: 'Edit customer' });
}

describe('summarizeInvoices', () => {
  it('separates what was collected from what is still owed', () => {
    const totals = summarizeInvoices([
      makeInvoice({ status: 'PAID', total: 1999 }),
      makeInvoice({ id: 'in_2', status: 'OPEN', total: 2500 }),
      makeInvoice({ id: 'in_3', status: 'PAID', total: 1000 }),
    ]);

    expect(totals).toMatchObject({ paid: 2999, paidCount: 2, outstanding: 2500, openCount: 1 });
  });

  // A void invoice was cancelled and a draft was never issued; counting
  // either would overstate the customer's balance.
  it('ignores void and draft invoices', () => {
    const totals = summarizeInvoices([
      makeInvoice({ status: 'VOID', total: 9999 }),
      makeInvoice({ id: 'in_2', status: 'DRAFT', total: 8888 }),
    ]);

    expect(totals).toMatchObject({ paid: 0, outstanding: 0, paidCount: 0, openCount: 0 });
  });

  it('takes the currency from the invoices rather than assuming dollars', () => {
    expect(summarizeInvoices([makeInvoice({ currency: 'eur' })]).currency).toBe('eur');
    expect(summarizeInvoices([]).currency).toBe('usd');
  });
});

describe('CustomerDetailPage', () => {
  it('loads the customer, their subscriptions, and their invoices', async () => {
    const { requests } = renderDetail();

    await screen.findByRole('heading', { name: 'Ada Lovelace' });

    expect(requests.map((request) => `${request.path}${request.query}`)).toEqual(
      expect.arrayContaining([
        '/customers/cus_1',
        '/subscriptions?customerId=cus_1',
        '/invoices?customerId=cus_1',
      ]),
    );
  });

  it('shows who the customer is', async () => {
    renderDetail();

    await screen.findByRole('heading', { name: 'Ada Lovelace' });
    const details = screen.getByRole('region', { name: 'Details' });

    expect(within(details).getByText('GB')).toBeInTheDocument();
    expect(within(details).getByText('GB123456789')).toBeInTheDocument();
    expect(within(details).getByText('01 Jun 2026')).toBeInTheDocument();
  });

  it('totals what has been paid and what is outstanding', async () => {
    renderDetail();

    const totals = await screen.findByRole('region', { name: 'Customer totals' });
    expect(within(totals).getByText('$19.99')).toBeInTheDocument();
    expect(within(totals).getByText('$25.00')).toBeInTheDocument();
    expect(within(totals).getByText('1 subscription in total')).toBeInTheDocument();
  });

  it('lists the subscriptions with their plan and status', async () => {
    renderDetail();

    const table = await screen.findByRole('table', { name: 'Subscriptions' });
    expect(within(table).getByText('Pro monthly')).toBeInTheDocument();
    expect(within(table).getByText('Active')).toBeInTheDocument();
    expect(within(table).getByText(/01 Aug 2026 – 01 Sept? 2026/)).toBeInTheDocument();
  });

  it('lists the invoices with their totals', async () => {
    renderDetail();

    const table = await screen.findByRole('table', { name: 'Invoices' });
    expect(within(table).getByText('INV-0001')).toBeInTheDocument();
    expect(within(table).getByText('INV-0002')).toBeInTheDocument();
    expect(within(table).getByText('$25.00')).toBeInTheDocument();
  });

  it('says so when there is nothing to show yet', async () => {
    renderDetail({ 'GET /subscriptions': { subscriptions: [] }, 'GET /invoices': { invoices: [] } });

    expect(await screen.findByText('No subscriptions')).toBeInTheDocument();
    expect(screen.getByText('No invoices')).toBeInTheDocument();
  });

  // The identity panel is what says whose page this is; a failed invoice
  // read must not take it down with it.
  it('keeps the customer on screen when a secondary read fails', async () => {
    renderDetail({ 'GET /invoices': new ApiError(500, 'ERROR', 'Server error') });

    await screen.findByRole('heading', { name: 'Ada Lovelace' });
    const invoices = screen.getByRole('region', { name: 'Invoices' });
    expect(within(invoices).getByText('Could not load this page')).toBeInTheDocument();
    expect(screen.getByRole('table', { name: 'Subscriptions' })).toBeInTheDocument();
  });

  it('reports a customer that does not exist', async () => {
    renderDetail({ 'GET /customers/cus_1': new ApiError(404, 'NOT_FOUND', 'Customer not found') });

    expect(await screen.findByText('Customer not found')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: '← Customers' })).toHaveAttribute(
      'href',
      '/customers',
    );
  });

  it('saves only the fields that were edited', async () => {
    const { requests } = renderDetail({
      'PATCH /customers/cus_1': { customer: { ...CUSTOMER, name: 'Ada King' } },
    });

    const dialog = await openEditor();
    const name = within(dialog).getByLabelText('Name');
    await userEvent.clear(name);
    await userEvent.type(name, 'Ada King');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Save changes' }));

    await waitFor(() => {
      expect(screen.queryByRole('dialog', { name: 'Edit customer' })).not.toBeInTheDocument();
    });

    const patch = requests.find((request) => request.method === 'PATCH');
    expect(patch?.body).toEqual({ name: 'Ada King' });
  });

  // Omitting a field means "leave it alone", so clearing the box has to
  // send an explicit null or the tax id would survive the edit.
  it('clears a tax id with an explicit null', async () => {
    const { requests } = renderDetail({
      'PATCH /customers/cus_1': { customer: { ...CUSTOMER, taxId: null } },
    });

    const dialog = await openEditor();
    await userEvent.clear(within(dialog).getByLabelText('Tax ID'));
    await userEvent.click(within(dialog).getByRole('button', { name: 'Save changes' }));

    await waitFor(() => {
      expect(requests.find((request) => request.method === 'PATCH')?.body).toEqual({ taxId: null });
    });
  });

  it('deactivates a customer through the active toggle', async () => {
    const { requests } = renderDetail({
      'PATCH /customers/cus_1': { customer: { ...CUSTOMER, active: false } },
    });

    const dialog = await openEditor();
    await userEvent.click(within(dialog).getByLabelText('Active'));
    await userEvent.click(within(dialog).getByRole('button', { name: 'Save changes' }));

    await waitFor(() => {
      expect(requests.find((request) => request.method === 'PATCH')?.body).toEqual({
        active: false,
      });
    });
  });

  // The update schema rejects an empty body, so an untouched form is
  // answered here rather than with a 400 from the server.
  it('does not send an empty update', async () => {
    const { requests } = renderDetail();

    const dialog = await openEditor();
    await userEvent.click(within(dialog).getByRole('button', { name: 'Save changes' }));

    expect(await within(dialog).findByText('Nothing has changed yet.')).toBeInTheDocument();
    expect(requests.some((request) => request.method === 'PATCH')).toBe(false);
  });

  it('shows what the server rejected against the offending field', async () => {
    renderDetail({
      'PATCH /customers/cus_1': validationError({ email: ['Invalid email'] }),
    });

    const dialog = await openEditor();
    const email = within(dialog).getByLabelText('Email');
    await userEvent.clear(email);
    await userEvent.type(email, 'ada@other.test');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Save changes' }));

    expect(await within(dialog).findByText('Invalid email')).toBeInTheDocument();
  });

  it('reloads the customer after a successful save', async () => {
    const { requests } = renderDetail({
      'PATCH /customers/cus_1': { customer: { ...CUSTOMER, name: 'Ada King' } },
    });

    const dialog = await openEditor();
    const name = within(dialog).getByLabelText('Name');
    await userEvent.clear(name);
    await userEvent.type(name, 'Ada King');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Save changes' }));

    await waitFor(() => {
      expect(requests.filter((request) => request.path === '/customers/cus_1')).toHaveLength(3);
    });
  });
});
