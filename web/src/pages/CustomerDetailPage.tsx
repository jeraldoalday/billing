import { useMemo, useState, type FormEvent, type ReactNode } from 'react';
import { Link, useParams } from 'react-router-dom';
import type { Customer, Invoice, Subscription } from '../api/types';
import { useAuth } from '../auth/AuthContext';
import { Alert } from '../components/Alert';
import { Badge, StatusBadge } from '../components/Badge';
import { CustomerFields } from '../components/CustomerFields';
import { Card, DataTable, type Column } from '../components/DataTable';
import { EmptyState } from '../components/EmptyState';
import { ErrorState } from '../components/ErrorState';
import { Modal } from '../components/Modal';
import { PageHeader } from '../components/PageHeader';
import { Spinner } from '../components/Spinner';
import { StatCard } from '../components/StatCard';
import { formErrorMessage, useApiMutation } from '../hooks/useApiMutation';
import { useApiQuery } from '../hooks/useApiQuery';
import { formatDate, formatMoney, pluralize } from '../lib/format';
import {
  customerFieldErrorsFrom,
  customerFormFrom,
  isEmptyUpdate,
  toUpdateCustomerInput,
  type CustomerFieldErrors,
  type CustomerFormState,
} from '../lib/customerForm';
import { activeLabel, activeTone } from '../lib/status';

/**
 * One customer: who they are, what they are subscribed to, and what they
 * have been invoiced.
 *
 * The three reads are separate queries rather than one, because the API has
 * no endpoint that returns a customer with their subscriptions and invoices
 * attached — and because a failure to load invoices should not blank out
 * the identity panel that says who this page is even about.
 */
export function CustomerDetailPage() {
  const { customerId = '' } = useParams<{ customerId: string }>();
  const { api } = useAuth();
  const [isEditing, setEditing] = useState(false);

  const customer = useApiQuery(
    (signal) => api.getCustomer(customerId, signal),
    [api, customerId],
    { enabled: customerId !== '' },
  );
  const subscriptions = useApiQuery(
    (signal) => api.listSubscriptions({ customerId }, signal),
    [api, customerId],
    { enabled: customerId !== '' },
  );
  const invoices = useApiQuery(
    (signal) => api.listInvoices({ customerId }, signal),
    [api, customerId],
    { enabled: customerId !== '' },
  );

  const totals = useMemo(() => summarizeInvoices(invoices.data ?? []), [invoices.data]);
  const activeSubscriptions = (subscriptions.data ?? []).filter(
    (subscription) => subscription.status === 'ACTIVE' || subscription.status === 'TRIALING',
  ).length;

  if (customer.isLoading) {
    return (
      <div className="flex min-h-[40vh] items-center justify-center">
        <Spinner label="Loading customer" />
      </div>
    );
  }

  if (customer.error) {
    return (
      <div className="space-y-4">
        <BackLink />
        <ErrorState error={customer.error} onRetry={customer.refetch} />
      </div>
    );
  }

  const record = customer.data;
  if (!record) {
    return null;
  }

  return (
    <div className="space-y-6">
      <BackLink />

      <PageHeader
        title={record.name}
        description={
          <span className="flex flex-wrap items-center gap-2">
            <span>{record.email}</span>
            <Badge tone={activeTone(record.active)}>{activeLabel(record.active)}</Badge>
            {record.taxExempt ? <Badge tone="info">Tax exempt</Badge> : null}
          </span>
        }
        actions={
          <button type="button" className="btn-secondary" onClick={() => setEditing(true)}>
            Edit customer
          </button>
        }
      />

      <section aria-label="Customer totals" className="grid gap-4 sm:grid-cols-3">
        <StatCard
          label="Active subscriptions"
          value={String(activeSubscriptions)}
          detail={`${pluralize(subscriptions.data?.length ?? 0, 'subscription')} in total`}
        />
        <StatCard
          label="Paid to date"
          value={formatMoney(totals.paid, totals.currency)}
          detail={pluralize(totals.paidCount, 'paid invoice')}
        />
        <StatCard
          label="Outstanding"
          value={formatMoney(totals.outstanding, totals.currency)}
          detail={pluralize(totals.openCount, 'open invoice')}
        />
      </section>

      <div className="grid gap-6 lg:grid-cols-2">
        <Card title="Details">
          <dl className="divide-y divide-slate-100 text-sm">
            <DetailRow label="Email" value={record.email} />
            <DetailRow label="Country" value={record.country ?? '—'} />
            <DetailRow label="Tax ID" value={record.taxId ?? '—'} />
            <DetailRow label="Tax exempt" value={record.taxExempt ? 'Yes' : 'No'} />
            <DetailRow label="Status" value={activeLabel(record.active)} />
            <DetailRow label="Customer since" value={formatDate(record.createdAt)} />
          </dl>
        </Card>

        <Card title="Subscriptions" aside={pluralize(subscriptions.data?.length ?? 0, 'total')}>
          {subscriptions.isLoading ? (
            <div className="px-4 py-8 text-center">
              <Spinner label="Loading subscriptions" />
            </div>
          ) : subscriptions.error ? (
            <ErrorState error={subscriptions.error} onRetry={subscriptions.refetch} />
          ) : (
            <DataTable
              caption="Subscriptions"
              columns={SUBSCRIPTION_COLUMNS}
              rows={subscriptions.data ?? []}
              rowKey={(subscription) => subscription.id}
              empty={
                <EmptyState
                  title="No subscriptions"
                  description="This customer is not subscribed to a plan yet."
                />
              }
            />
          )}
        </Card>
      </div>

      <Card title="Invoices" aside={pluralize(invoices.data?.length ?? 0, 'total')}>
        {invoices.isLoading ? (
          <div className="px-4 py-8 text-center">
            <Spinner label="Loading invoices" />
          </div>
        ) : invoices.error ? (
          <ErrorState error={invoices.error} onRetry={invoices.refetch} />
        ) : (
          <DataTable
            caption="Invoices"
            columns={INVOICE_COLUMNS}
            rows={invoices.data ?? []}
            rowKey={(invoice) => invoice.id}
            empty={
              <EmptyState
                title="No invoices"
                description="Invoices appear here once a billing period closes or one is generated."
              />
            }
          />
        )}
      </Card>

      {isEditing ? (
        <EditCustomerDialog
          customer={record}
          onClose={() => setEditing(false)}
          onSaved={() => {
            setEditing(false);
            customer.refetch();
          }}
        />
      ) : null}
    </div>
  );
}

function BackLink() {
  return (
    <Link to="/customers" className="text-sm font-medium text-slate-500 hover:text-slate-800">
      ← Customers
    </Link>
  );
}

function DetailRow({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-4 px-4 py-2.5">
      <dt className="text-slate-500">{label}</dt>
      <dd className="text-right font-medium text-slate-900">{value}</dd>
    </div>
  );
}

const SUBSCRIPTION_COLUMNS: Column<Subscription>[] = [
  {
    key: 'plan',
    header: 'Plan',
    render: (subscription) => subscription.plan?.name ?? 'Unknown plan',
  },
  {
    key: 'status',
    header: 'Status',
    render: (subscription) => <StatusBadge status={subscription.status} />,
  },
  {
    key: 'period',
    header: 'Current period',
    render: (subscription) =>
      `${formatDate(subscription.currentPeriodStart)} – ${formatDate(subscription.currentPeriodEnd)}`,
  },
  {
    key: 'trial',
    header: 'Trial ends',
    align: 'right',
    render: (subscription) => formatDate(subscription.trialEnd),
  },
];

const INVOICE_COLUMNS: Column<Invoice>[] = [
  { key: 'number', header: 'Invoice', render: (invoice) => invoice.number },
  { key: 'status', header: 'Status', render: (invoice) => <StatusBadge status={invoice.status} /> },
  {
    key: 'period',
    header: 'Period',
    render: (invoice) => `${formatDate(invoice.periodStart)} – ${formatDate(invoice.periodEnd)}`,
  },
  { key: 'issued', header: 'Issued', render: (invoice) => formatDate(invoice.issuedAt) },
  {
    key: 'total',
    header: 'Total',
    align: 'right',
    render: (invoice) => formatMoney(invoice.total, invoice.currency),
  },
];

export interface InvoiceTotals {
  paid: number;
  paidCount: number;
  outstanding: number;
  openCount: number;
  currency: string;
}

/**
 * What this customer has paid and what they still owe.
 *
 * A voided invoice counts as neither: it was cancelled, so including it
 * would overstate both what was collected and what is owed. A draft is not
 * outstanding either — it has not been issued to anyone yet.
 */
export function summarizeInvoices(invoices: Invoice[]): InvoiceTotals {
  const totals: InvoiceTotals = {
    paid: 0,
    paidCount: 0,
    outstanding: 0,
    openCount: 0,
    // Every invoice for one customer bills in one currency in practice;
    // the first invoice's is a better guess than a hardcoded default.
    currency: invoices[0]?.currency ?? 'usd',
  };

  for (const invoice of invoices) {
    if (invoice.status === 'PAID') {
      totals.paid += invoice.total;
      totals.paidCount += 1;
    } else if (invoice.status === 'OPEN') {
      totals.outstanding += invoice.total;
      totals.openCount += 1;
    }
  }

  return totals;
}

interface EditCustomerDialogProps {
  customer: Customer;
  onClose: () => void;
  onSaved: (customer: Customer) => void;
}

function EditCustomerDialog({ customer, onClose, onSaved }: EditCustomerDialogProps) {
  const { api } = useAuth();
  const [state, setState] = useState<CustomerFormState>(() => customerFormFrom(customer));
  const [localErrors, setLocalErrors] = useState<CustomerFieldErrors>({});
  const [notice, setNotice] = useState<string | null>(null);
  const save = useApiMutation((input: Parameters<typeof api.updateCustomer>[1]) =>
    api.updateCustomer(customer.id, input),
  );

  const errors: CustomerFieldErrors = {
    ...customerFieldErrorsFrom(save.fieldErrors),
    ...localErrors,
  };
  const formError = formErrorMessage(save.error);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setNotice(null);

    const built = toUpdateCustomerInput(state, customer);
    if (!built.ok) {
      setLocalErrors(built.fieldErrors);
      return;
    }

    setLocalErrors({});
    // The update schema rejects an empty body, so an untouched form is
    // answered here rather than with a 400 from the server.
    if (isEmptyUpdate(built.value)) {
      setNotice('Nothing has changed yet.');
      return;
    }

    const updated = await save.mutate(built.value);
    if (updated) {
      onSaved(updated);
    }
  }

  return (
    <Modal title="Edit customer" description={customer.email} onClose={onClose}>
      <form onSubmit={handleSubmit} noValidate className="space-y-4">
        {formError ? <Alert>{formError}</Alert> : null}
        {notice ? <Alert tone="info">{notice}</Alert> : null}
        <CustomerFields
          state={state}
          errors={errors}
          disabled={save.isPending}
          includeActive
          onChange={(patch) => setState((current) => ({ ...current, ...patch }))}
        />
        <div className="flex justify-end gap-2 border-t border-slate-200 pt-4">
          <button type="button" className="btn-secondary" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className="btn-action" disabled={save.isPending}>
            {save.isPending ? 'Saving…' : 'Save changes'}
          </button>
        </div>
      </form>
    </Modal>
  );
}
