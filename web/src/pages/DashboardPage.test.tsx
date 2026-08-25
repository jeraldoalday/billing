import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { ApiError } from '../api/client';
import type { SummaryReport } from '../api/types';
import { AppRoutes } from '../App';
import { EMPTY_SUMMARY, TEST_SESSION, renderApp } from '../test/renderApp';

const ME_OK = { user: TEST_SESSION.user, organization: TEST_SESSION.organization };

const SUMMARY: SummaryReport = {
  mrr: {
    mrr: 249_900,
    subscriptions: 12,
    customers: 9,
    arpu: 27_766,
    groupBy: 'plan',
    breakdown: [
      { key: 'plan_pro', label: 'Pro monthly', mrr: 199_900, subscriptions: 8 },
      { key: 'plan_starter', label: 'Starter monthly', mrr: 50_000, subscriptions: 4 },
    ],
  },
  churn: {
    from: '2026-07-26T00:00:00.000Z',
    to: '2026-08-25T00:00:00.000Z',
    subscriptions: { atStart: 14, churned: 2, churnRate: 0.1429, retentionRate: 0.8571 },
    customers: { atStart: 11, churned: 1, churnRate: 0.0909 },
  },
  revenue: {
    from: '2026-07-26T00:00:00.000Z',
    to: '2026-08-25T00:00:00.000Z',
    invoices: 17,
    grossRevenue: 310_000,
    discounts: 15_000,
    tax: 29_500,
    netRevenue: 295_000,
    outstanding: 48_000,
  },
};

function renderDashboard(summary: unknown = SUMMARY) {
  return renderApp(<AppRoutes />, {
    route: '/',
    session: TEST_SESSION,
    responses: { 'GET /auth/me': ME_OK, 'GET /reports/summary': summary },
  });
}

describe('DashboardPage', () => {
  it('loads the summary report once the session is valid', async () => {
    const { requests } = renderDashboard();

    await screen.findByRole('heading', { name: 'Acme Inc' });
    // One request, not three: the server computes all three figures from a
    // single snapshot on /reports/summary.
    const reportRequests = requests.filter((r) => r.path.startsWith('/reports'));
    expect(reportRequests).toHaveLength(1);
    expect(reportRequests[0]?.path).toBe('/reports/summary');
  });

  it('shows MRR, ARPU, churn, and net revenue', async () => {
    renderDashboard();

    const metrics = await screen.findByRole('region', { name: 'Key metrics' });

    expect(within(metrics).getByText('$2,499.00')).toBeInTheDocument();
    expect(within(metrics).getByText('$277.66')).toBeInTheDocument();
    expect(within(metrics).getByText('14.29%')).toBeInTheDocument();
    expect(within(metrics).getByText('$2,950.00')).toBeInTheDocument();
  });

  it('describes what each figure is drawn from', async () => {
    renderDashboard();

    const metrics = await screen.findByRole('region', { name: 'Key metrics' });

    expect(within(metrics).getByText('12 active subscriptions')).toBeInTheDocument();
    expect(within(metrics).getByText('9 paying customers')).toBeInTheDocument();
    expect(within(metrics).getByText('2 of 14 lost')).toBeInTheDocument();
    expect(within(metrics).getByText('17 paid invoices')).toBeInTheDocument();
  });

  it('breaks MRR down by plan', async () => {
    renderDashboard();

    const breakdown = await screen.findByRole('region', { name: 'MRR by plan' });
    const rows = within(breakdown).getAllByRole('row');

    // Header plus one row per plan.
    expect(rows).toHaveLength(3);
    expect(within(rows[1] as HTMLElement).getByText('Pro monthly')).toBeInTheDocument();
    expect(within(rows[1] as HTMLElement).getByText('$1,999.00')).toBeInTheDocument();
    expect(within(rows[2] as HTMLElement).getByText('Starter monthly')).toBeInTheDocument();
  });

  it('shows discounts as the reduction they are', async () => {
    renderDashboard();

    const revenue = await screen.findByRole('region', { name: 'Collected revenue' });

    expect(within(revenue).getByText('$3,100.00')).toBeInTheDocument();
    expect(within(revenue).getByText('-$150.00')).toBeInTheDocument();
    expect(within(revenue).getByText('$480.00')).toBeInTheDocument();
  });

  it('reports the window the figures cover', async () => {
    renderDashboard();

    expect(
      await screen.findByText('Revenue between 26 Jul 2026 and 25 Aug 2026'),
    ).toBeInTheDocument();
  });

  it('explains an empty organization instead of showing an empty table', async () => {
    renderDashboard(EMPTY_SUMMARY);

    expect(await screen.findByText(/No active subscriptions yet/)).toBeInTheDocument();
    expect(screen.queryByRole('table')).not.toBeInTheDocument();
  });

  it('shows a spinner while the report is loading', async () => {
    renderDashboard(new Promise(() => undefined));

    // The session check resolves first, then the report keeps loading.
    await waitFor(() =>
      expect(screen.getByRole('status')).toHaveTextContent('Loading your revenue summary'),
    );
  });

  it('offers a retry when the report fails to load', async () => {
    const { requests } = renderApp(<AppRoutes />, {
      route: '/',
      session: TEST_SESSION,
      responses: {
        'GET /auth/me': ME_OK,
        'GET /reports/summary': new ApiError(500, 'INTERNAL_ERROR', 'Something went wrong'),
      },
    });

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('Could not load this page');

    const before = requests.filter((r) => r.path === '/reports/summary').length;
    await userEvent.click(screen.getByRole('button', { name: 'Try again' }));

    await waitFor(() =>
      expect(requests.filter((r) => r.path === '/reports/summary').length).toBe(before + 1),
    );
  });

  it('translates an unreachable API into something actionable', async () => {
    renderApp(<AppRoutes />, {
      route: '/',
      session: TEST_SESSION,
      responses: {
        'GET /auth/me': ME_OK,
        'GET /reports/summary': new TypeError('Failed to fetch'),
      },
    });

    expect(await screen.findByRole('alert')).toHaveTextContent('Could not reach the billing API');
  });
});
