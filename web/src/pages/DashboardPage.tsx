import { useAuth } from '../auth/AuthContext';
import { ErrorState } from '../components/ErrorState';
import { Spinner } from '../components/Spinner';
import { StatCard } from '../components/StatCard';
import { useApiQuery } from '../hooks/useApiQuery';
import { formatDate, formatMoney, formatPercent, pluralize } from '../lib/format';

/**
 * The signed-in landing page: the revenue picture from `GET /reports/summary`.
 *
 * One request rather than three, because the server computes MRR, churn,
 * and revenue from a single snapshot there — fanning out to the individual
 * endpoints would risk showing three figures taken at three slightly
 * different instants.
 */
export function DashboardPage() {
  const { api, organization } = useAuth();
  const summary = useApiQuery((signal) => api.getSummaryReport(undefined, signal), [api]);

  if (summary.isLoading) {
    return (
      <div className="flex min-h-[40vh] items-center justify-center">
        <Spinner label="Loading your revenue summary" />
      </div>
    );
  }

  if (summary.error) {
    return <ErrorState error={summary.error} onRetry={summary.refetch} />;
  }

  const report = summary.data;
  if (!report) {
    return null;
  }

  const { mrr, churn, revenue } = report;
  // Every plan in one organization bills in one currency in practice; the
  // breakdown carries no currency of its own, so the figures are shown in
  // the organization's default rather than guessed per row.
  const currency = 'usd';

  return (
    <div className="space-y-6">
      <header>
        <h1 className="text-xl font-semibold text-slate-900">
          {organization?.name ?? 'Your organization'}
        </h1>
        <p className="mt-1 text-sm text-slate-500">
          Revenue between {formatDate(churn.from)} and {formatDate(churn.to)}
        </p>
      </header>

      <section aria-label="Key metrics" className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <StatCard
          label="MRR"
          value={formatMoney(mrr.mrr, currency)}
          detail={pluralize(mrr.subscriptions, 'active subscription')}
        />
        <StatCard
          label="ARPU"
          value={formatMoney(mrr.arpu, currency)}
          detail={pluralize(mrr.customers, 'paying customer')}
        />
        <StatCard
          label="Subscription churn"
          value={formatPercent(churn.subscriptions.churnRate)}
          detail={`${churn.subscriptions.churned} of ${churn.subscriptions.atStart} lost`}
        />
        <StatCard
          label="Net revenue"
          value={formatMoney(revenue.netRevenue, currency)}
          detail={pluralize(revenue.invoices, 'paid invoice')}
        />
      </section>

      <div className="grid gap-6 lg:grid-cols-2">
        <section
          aria-label="MRR by plan"
          className="rounded-xl border border-slate-200 bg-white shadow-sm"
        >
          <h2 className="border-b border-slate-200 px-4 py-3 text-sm font-semibold text-slate-900">
            MRR by {mrr.groupBy}
          </h2>

          {mrr.breakdown.length === 0 ? (
            <p className="px-4 py-6 text-sm text-slate-500">
              No active subscriptions yet. MRR appears here once a customer subscribes to a plan.
            </p>
          ) : (
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-xs uppercase tracking-wide text-slate-500">
                  <th scope="col" className="px-4 py-2 font-semibold">
                    Plan
                  </th>
                  <th scope="col" className="px-4 py-2 text-right font-semibold">
                    Subscriptions
                  </th>
                  <th scope="col" className="px-4 py-2 text-right font-semibold">
                    MRR
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {mrr.breakdown.map((entry) => (
                  <tr key={entry.key}>
                    <td className="px-4 py-2 text-slate-700">{entry.label}</td>
                    <td className="px-4 py-2 text-right tabular-nums text-slate-600">
                      {entry.subscriptions}
                    </td>
                    <td className="px-4 py-2 text-right tabular-nums font-medium text-slate-900">
                      {formatMoney(entry.mrr, currency)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </section>

        <section
          aria-label="Collected revenue"
          className="rounded-xl border border-slate-200 bg-white shadow-sm"
        >
          <h2 className="border-b border-slate-200 px-4 py-3 text-sm font-semibold text-slate-900">
            Collected in this window
          </h2>
          <dl className="divide-y divide-slate-100 text-sm">
            <RevenueRow label="Gross revenue" value={formatMoney(revenue.grossRevenue, currency)} />
            <RevenueRow label="Discounts" value={formatMoney(-revenue.discounts, currency)} />
            <RevenueRow label="Tax" value={formatMoney(revenue.tax, currency)} />
            <RevenueRow label="Net revenue" value={formatMoney(revenue.netRevenue, currency)} />
            <RevenueRow
              label="Outstanding"
              value={formatMoney(revenue.outstanding, currency)}
              hint="Invoices issued in this window that are still unpaid"
            />
          </dl>
        </section>
      </div>
    </div>
  );
}

function RevenueRow({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="flex items-baseline justify-between gap-4 px-4 py-2.5">
      <dt className="text-slate-600">
        {label}
        {hint ? <span className="mt-0.5 block text-xs text-slate-400">{hint}</span> : null}
      </dt>
      <dd className="tabular-nums font-medium text-slate-900">{value}</dd>
    </div>
  );
}
