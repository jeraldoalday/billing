import { useMemo, useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import type { Customer } from '../api/types';
import { useAuth } from '../auth/AuthContext';
import { Alert } from '../components/Alert';
import { Badge } from '../components/Badge';
import { CustomerFields } from '../components/CustomerFields';
import { Card, DataTable, type Column } from '../components/DataTable';
import { EmptyState } from '../components/EmptyState';
import { ErrorState } from '../components/ErrorState';
import { Modal } from '../components/Modal';
import { PageHeader } from '../components/PageHeader';
import { SelectField } from '../components/SelectField';
import { Spinner } from '../components/Spinner';
import { TextField } from '../components/TextField';
import { formErrorMessage, useApiMutation } from '../hooks/useApiMutation';
import { useApiQuery } from '../hooks/useApiQuery';
import { formatDate, pluralize } from '../lib/format';
import {
  customerFieldErrorsFrom,
  emptyCustomerForm,
  filterCustomers,
  toCreateCustomerInput,
  type CustomerFieldErrors,
  type CustomerFormState,
} from '../lib/customerForm';
import { activeLabel, activeTone } from '../lib/status';

type StatusFilter = 'all' | 'active' | 'inactive';

const STATUS_OPTIONS = [
  { value: 'all', label: 'All customers' },
  { value: 'active', label: 'Active only' },
  { value: 'inactive', label: 'Inactive only' },
];

/** The `active` query the API takes, or nothing at all for "all". */
function activeQuery(filter: StatusFilter): { active?: boolean } | undefined {
  if (filter === 'all') {
    return undefined;
  }
  return { active: filter === 'active' };
}

/**
 * Everyone this organization bills.
 *
 * The status filter is a server-side query (it is a real column, and the
 * list can be long), while the search box filters what came back in the
 * browser — the API's `email` filter is an exact match, which is no use
 * for typing three letters of someone's name.
 */
export function CustomersPage() {
  const { api } = useAuth();
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('all');
  const [search, setSearch] = useState('');
  const [isCreating, setCreating] = useState(false);

  const customers = useApiQuery(
    (signal) => api.listCustomers(activeQuery(statusFilter), signal),
    [api, statusFilter],
  );

  const rows = useMemo(
    () => filterCustomers(customers.data ?? [], search),
    [customers.data, search],
  );

  const columns: Column<Customer>[] = [
    {
      key: 'name',
      header: 'Name',
      render: (customer) => (
        <Link className="link" to={`/customers/${customer.id}`}>
          {customer.name}
        </Link>
      ),
    },
    { key: 'email', header: 'Email', render: (customer) => customer.email },
    { key: 'country', header: 'Country', render: (customer) => customer.country ?? '—' },
    {
      key: 'status',
      header: 'Status',
      render: (customer) => (
        <Badge tone={activeTone(customer.active)}>{activeLabel(customer.active)}</Badge>
      ),
    },
    {
      key: 'created',
      header: 'Added',
      align: 'right',
      render: (customer) => formatDate(customer.createdAt),
    },
  ];

  return (
    <div className="space-y-6">
      <PageHeader
        title="Customers"
        description="Everyone this organization bills."
        actions={
          <button type="button" className="btn-action" onClick={() => setCreating(true)}>
            New customer
          </button>
        }
      />

      <div className="flex flex-wrap items-end gap-3">
        <TextField
          label="Search"
          className="w-full sm:w-72"
          placeholder="Name or email"
          value={search}
          onChange={(event) => setSearch(event.target.value)}
        />
        <SelectField
          label="Status"
          className="w-full sm:w-48"
          options={STATUS_OPTIONS}
          value={statusFilter}
          onChange={(event) => setStatusFilter(event.target.value as StatusFilter)}
        />
      </div>

      {customers.isLoading ? (
        <div className="flex min-h-[30vh] items-center justify-center">
          <Spinner label="Loading customers" />
        </div>
      ) : customers.error ? (
        <ErrorState error={customers.error} onRetry={customers.refetch} />
      ) : (
        <Card title="Customers" aside={pluralize(rows.length, 'customer')}>
          <DataTable
            caption="Customers"
            columns={columns}
            rows={rows}
            rowKey={(customer) => customer.id}
            empty={
              search.trim() === '' ? (
                <EmptyState
                  title="No customers yet"
                  description="Add the first customer, then subscribe them to a plan to start billing."
                  action={
                    <button type="button" className="btn-action" onClick={() => setCreating(true)}>
                      New customer
                    </button>
                  }
                />
              ) : (
                <EmptyState
                  title="No matching customers"
                  description={`Nothing here matches “${search.trim()}”.`}
                />
              )
            }
          />
        </Card>
      )}

      {isCreating ? (
        <NewCustomerDialog
          onClose={() => setCreating(false)}
          onCreated={() => {
            setCreating(false);
            customers.refetch();
          }}
        />
      ) : null}
    </div>
  );
}

interface NewCustomerDialogProps {
  onClose: () => void;
  onCreated: (customer: Customer) => void;
}

function NewCustomerDialog({ onClose, onCreated }: NewCustomerDialogProps) {
  const { api } = useAuth();
  const [state, setState] = useState<CustomerFormState>(emptyCustomerForm);
  const [localErrors, setLocalErrors] = useState<CustomerFieldErrors>({});
  const create = useApiMutation((input: Parameters<typeof api.createCustomer>[0]) =>
    api.createCustomer(input),
  );

  // What the browser caught, over what the server said about the same
  // field: the local message is about what is in the box right now.
  const errors: CustomerFieldErrors = {
    ...customerFieldErrorsFrom(create.fieldErrors),
    ...localErrors,
  };
  const formError = formErrorMessage(create.error);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();

    const built = toCreateCustomerInput(state);
    if (!built.ok) {
      setLocalErrors(built.fieldErrors);
      return;
    }

    setLocalErrors({});
    const created = await create.mutate(built.value);
    if (created) {
      onCreated(created);
    }
  }

  return (
    <Modal
      title="New customer"
      description="They can be subscribed to a plan as soon as they exist."
      onClose={onClose}
    >
      {/*
        The buttons live inside the form rather than in the modal's footer
        slot so that Enter in any field submits, and so the submit button
        needs no `form` attribute to find the form it belongs to.
      */}
      <form onSubmit={handleSubmit} noValidate className="space-y-4">
        {formError ? <Alert>{formError}</Alert> : null}
        <CustomerFields
          state={state}
          errors={errors}
          disabled={create.isPending}
          onChange={(patch) => setState((current) => ({ ...current, ...patch }))}
        />
        <div className="flex justify-end gap-2 border-t border-slate-200 pt-4">
          <button type="button" className="btn-secondary" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className="btn-action" disabled={create.isPending}>
            {create.isPending ? 'Creating…' : 'Create customer'}
          </button>
        </div>
      </form>
    </Modal>
  );
}
