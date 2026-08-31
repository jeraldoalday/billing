import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { ApiError } from '../api/client';
import type { Plan, Product } from '../api/types';
import { AppRoutes } from '../App';
import { TEST_SESSION, renderApp, validationError, type Responses } from '../test/renderApp';

const ME_OK = { user: TEST_SESSION.user, organization: TEST_SESSION.organization };

function makeProduct(overrides: Partial<Product> = {}): Product {
  return {
    id: 'prod_1',
    organizationId: 'org_1',
    name: 'API access',
    description: 'Metered API calls',
    active: true,
    createdAt: '2026-06-01T00:00:00.000Z',
    updatedAt: '2026-06-01T00:00:00.000Z',
    ...overrides,
  };
}

function makePlan(overrides: Partial<Plan> = {}): Plan {
  return {
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
    ...overrides,
  };
}

const TIERED_PLAN = makePlan({
  id: 'plan_2',
  name: 'Metered',
  pricingModel: 'TIERED',
  flatAmount: null,
  usageMetric: 'api_call',
  tiers: [
    { id: 'tier_1', planId: 'plan_2', order: 0, upTo: 1000, unitAmount: 5, flatFee: 0 },
    { id: 'tier_2', planId: 'plan_2', order: 1, upTo: null, unitAmount: 3, flatFee: 0 },
  ],
});

function renderPlans(responses: Responses = {}) {
  return renderApp(<AppRoutes />, {
    route: '/plans',
    session: TEST_SESSION,
    responses: {
      'GET /auth/me': ME_OK,
      'GET /products': { products: [makeProduct()] },
      'GET /plans': { plans: [makePlan(), TIERED_PLAN] },
      ...responses,
    },
  });
}

async function openNewPlan() {
  await screen.findByRole('table', { name: 'Plans for API access' });
  await userEvent.click(screen.getByRole('button', { name: 'New plan' }));
  return screen.getByRole('dialog', { name: 'New plan' });
}

async function fillFlatPlan(dialog: HTMLElement) {
  await userEvent.type(within(dialog).getByLabelText('Name'), 'Starter monthly');
  await userEvent.type(within(dialog).getByLabelText('Amount'), '9.99');
}

describe('PlansPage', () => {
  it('groups the plans under the product they price', async () => {
    renderPlans();

    const card = await screen.findByRole('region', { name: 'API access' });
    expect(within(card).getByText('Metered API calls')).toBeInTheDocument();
    expect(within(card).getByText('2 plans')).toBeInTheDocument();
    expect(within(card).getByText('Pro monthly')).toBeInTheDocument();
  });

  it('quotes a flat plan against its interval', async () => {
    renderPlans();

    const table = await screen.findByRole('table', { name: 'Plans for API access' });
    expect(within(table).getByText('$19.99 / month')).toBeInTheDocument();
  });

  it('spells out the bands of a tiered plan', async () => {
    renderPlans();

    const table = await screen.findByRole('table', { name: 'Plans for API access' });
    expect(within(table).getByText('Tiered on api_call · 2 tiers')).toBeInTheDocument();
    expect(within(table).getByText('1 – 1,000: $0.05 each')).toBeInTheDocument();
    expect(within(table).getByText('1,001 and above: $0.03 each')).toBeInTheDocument();
  });

  it('offers to start the catalogue when there are no products', async () => {
    renderPlans({ 'GET /products': { products: [] }, 'GET /plans': { plans: [] } });

    expect(await screen.findByText('No products yet')).toBeInTheDocument();
    // Nothing to hang a plan on yet, so creating one is not offered.
    expect(screen.getByRole('button', { name: 'New plan' })).toBeDisabled();
  });

  it('prompts for a plan on a product that has none', async () => {
    renderPlans({ 'GET /plans': { plans: [] } });

    expect(await screen.findByText('No plans on this product')).toBeInTheDocument();
  });

  it('reports a failed load and retries both reads', async () => {
    const { requests } = renderPlans({ 'GET /plans': new ApiError(500, 'ERROR', 'Server error') });

    await screen.findByText('Could not load this page');
    await userEvent.click(screen.getByRole('button', { name: 'Try again' }));

    await waitFor(() => {
      expect(requests.filter((request) => request.path === '/plans')).toHaveLength(2);
      expect(requests.filter((request) => request.path === '/products')).toHaveLength(2);
    });
  });

  it('archives a plan and reloads the catalogue', async () => {
    const { requests } = renderPlans({
      'PATCH /plans/plan_1': { plan: makePlan({ active: false }) },
    });

    await screen.findByRole('table', { name: 'Plans for API access' });
    await userEvent.click(screen.getByRole('button', { name: 'Archive Pro monthly' }));

    await waitFor(() => {
      expect(requests.filter((request) => request.path === '/plans')).toHaveLength(2);
    });
    expect(requests.find((request) => request.method === 'PATCH')?.body).toEqual({ active: false });
  });

  it('restores an archived plan', async () => {
    const { requests } = renderPlans({
      'GET /plans': { plans: [makePlan({ active: false })] },
      'PATCH /plans/plan_1': { plan: makePlan() },
    });

    await screen.findByRole('table', { name: 'Plans for API access' });
    await userEvent.click(screen.getByRole('button', { name: 'Restore Pro monthly' }));

    await waitFor(() => {
      expect(requests.find((request) => request.method === 'PATCH')?.body).toEqual({ active: true });
    });
  });

  it('creates a product', async () => {
    const { requests } = renderPlans({
      'POST /products': { product: makeProduct({ id: 'prod_2', name: 'Support' }) },
    });

    await screen.findByRole('table', { name: 'Plans for API access' });
    await userEvent.click(screen.getByRole('button', { name: 'New product' }));

    const dialog = screen.getByRole('dialog', { name: 'New product' });
    await userEvent.type(within(dialog).getByLabelText('Name'), 'Support');
    await userEvent.type(within(dialog).getByLabelText('Description'), 'Human help');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Create product' }));

    await waitFor(() => {
      expect(screen.queryByRole('dialog', { name: 'New product' })).not.toBeInTheDocument();
    });
    expect(requests.find((request) => request.path === '/products' && request.method === 'POST')?.body).toEqual({
      name: 'Support',
      description: 'Human help',
    });
  });

  it('creates a flat plan on the selected product', async () => {
    const { requests } = renderPlans({ 'POST /plans': { plan: makePlan({ id: 'plan_3' }) } });

    const dialog = await openNewPlan();
    await fillFlatPlan(dialog);
    await userEvent.click(within(dialog).getByRole('button', { name: 'Create plan' }));

    await waitFor(() => {
      expect(screen.queryByRole('dialog', { name: 'New plan' })).not.toBeInTheDocument();
    });
    expect(requests.find((request) => request.method === 'POST')?.body).toEqual({
      productId: 'prod_1',
      name: 'Starter monthly',
      interval: 'MONTH',
      currency: 'usd',
      pricingModel: 'FLAT',
      // 9.99 as the integer minor units the API stores.
      flatAmount: 999,
    });
  });

  it('creates a usage plan once the pricing model is switched', async () => {
    const { requests } = renderPlans({ 'POST /plans': { plan: makePlan({ id: 'plan_3' }) } });

    const dialog = await openNewPlan();
    await userEvent.type(within(dialog).getByLabelText('Name'), 'Metered calls');
    await userEvent.selectOptions(within(dialog).getByLabelText('Pricing model'), 'USAGE');
    await userEvent.type(within(dialog).getByLabelText('Usage metric'), 'api_call');
    await userEvent.type(within(dialog).getByLabelText('Price per unit'), '0.05');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Create plan' }));

    await waitFor(() => {
      expect(requests.find((request) => request.method === 'POST')?.body).toMatchObject({
        pricingModel: 'USAGE',
        usageMetric: 'api_call',
        usageUnitAmount: 5,
      });
    });
  });

  it('builds a tiered plan from the bands that were entered', async () => {
    const { requests } = renderPlans({ 'POST /plans': { plan: TIERED_PLAN } });

    const dialog = await openNewPlan();
    await userEvent.type(within(dialog).getByLabelText('Name'), 'Metered');
    await userEvent.selectOptions(within(dialog).getByLabelText('Pricing model'), 'TIERED');
    await userEvent.type(within(dialog).getByLabelText('Usage metric'), 'api_call');

    // The form starts with one open-ended band; a second is added above it.
    await userEvent.type(within(dialog).getByLabelText('Price per unit (tier 1)'), '0.05');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Add tier' }));
    await userEvent.type(within(dialog).getByLabelText('Up to (tier 1)'), '1000');
    await userEvent.type(within(dialog).getByLabelText('Price per unit (tier 2)'), '0.03');

    await userEvent.click(within(dialog).getByRole('button', { name: 'Create plan' }));

    await waitFor(() => {
      expect(requests.find((request) => request.method === 'POST')?.body).toMatchObject({
        pricingModel: 'TIERED',
        usageMetric: 'api_call',
        tiers: [
          { upTo: 1000, unitAmount: 5, flatFee: 0 },
          { upTo: null, unitAmount: 3, flatFee: 0 },
        ],
      });
    });
  });

  it('drops a tier that was added by mistake', async () => {
    renderPlans();

    const dialog = await openNewPlan();
    await userEvent.selectOptions(within(dialog).getByLabelText('Pricing model'), 'TIERED');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Add tier' }));
    expect(within(dialog).getByLabelText('Price per unit (tier 2)')).toBeInTheDocument();

    await userEvent.click(within(dialog).getByRole('button', { name: 'Remove tier 2' }));

    expect(within(dialog).queryByLabelText('Price per unit (tier 2)')).not.toBeInTheDocument();
  });

  it('reports a bad tier bound against the band that caused it', async () => {
    const { requests } = renderPlans();

    const dialog = await openNewPlan();
    await userEvent.type(within(dialog).getByLabelText('Name'), 'Metered');
    await userEvent.selectOptions(within(dialog).getByLabelText('Pricing model'), 'TIERED');
    await userEvent.type(within(dialog).getByLabelText('Usage metric'), 'api_call');
    await userEvent.type(within(dialog).getByLabelText('Price per unit (tier 1)'), '0.05');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Add tier' }));
    await userEvent.type(within(dialog).getByLabelText('Up to (tier 1)'), '1000');
    await userEvent.type(within(dialog).getByLabelText('Up to (tier 2)'), '500');
    await userEvent.type(within(dialog).getByLabelText('Price per unit (tier 2)'), '0.03');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Create plan' }));

    expect(await within(dialog).findByText('Must be greater than 1000')).toBeInTheDocument();
    expect(requests.some((request) => request.method === 'POST')).toBe(false);
  });

  it('requires a name and an amount before calling the API', async () => {
    const { requests } = renderPlans();

    const dialog = await openNewPlan();
    await userEvent.click(within(dialog).getByRole('button', { name: 'Create plan' }));

    expect(await within(dialog).findByText('Enter a name')).toBeInTheDocument();
    expect(within(dialog).getByText('Enter an amount')).toBeInTheDocument();
    expect(requests.some((request) => request.method === 'POST')).toBe(false);
  });

  it('shows what the server rejected against the offending field', async () => {
    renderPlans({ 'POST /plans': validationError({ name: ['Name is already taken'] }) });

    const dialog = await openNewPlan();
    await fillFlatPlan(dialog);
    await userEvent.click(within(dialog).getByRole('button', { name: 'Create plan' }));

    expect(await within(dialog).findByText('Name is already taken')).toBeInTheDocument();
    expect(screen.getByRole('dialog', { name: 'New plan' })).toBeInTheDocument();
  });
});
