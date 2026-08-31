import { useMemo, useState, type FormEvent } from 'react';
import type { CreatePlanInput, Plan, Product } from '../api/types';
import { useAuth } from '../auth/AuthContext';
import { Alert } from '../components/Alert';
import { Badge } from '../components/Badge';
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
import { formatDate } from '../lib/format';
import {
  BILLING_INTERVALS,
  PRICING_MODELS,
  describePlanPrice,
  describePricingModel,
  describeTiers,
  formatInterval,
  formatPricingModel,
  groupPlansByProduct,
} from '../lib/plan';
import {
  emptyPlanForm,
  emptyTierRow,
  planFieldErrorsFrom,
  tierFieldKey,
  toCreatePlanInput,
  type PlanFieldErrors,
  type PlanFormState,
} from '../lib/planForm';
import { activeLabel, activeTone } from '../lib/status';

/**
 * The catalogue: every product with the plans that price it.
 *
 * Plans are grouped under their product because that is the relationship
 * that matters when you are deciding what to sell — "Pro monthly" and "Pro
 * yearly" are two prices for one thing, and a flat alphabetical list hides
 * that. Both reads are unfiltered so archived plans stay visible; hiding
 * them would leave someone wondering where a plan went.
 */
export function PlansPage() {
  const { api } = useAuth();
  const [creatingPlan, setCreatingPlan] = useState(false);
  const [creatingProduct, setCreatingProduct] = useState(false);

  const plans = useApiQuery((signal) => api.listPlans(undefined, signal), [api]);
  const products = useApiQuery((signal) => api.listProducts(undefined, signal), [api]);

  const archive = useApiMutation((input: { id: string; active: boolean }) =>
    api.updatePlan(input.id, { active: input.active }),
  );

  const groups = useMemo(
    () => groupPlansByProduct(plans.data ?? [], products.data ?? []),
    [plans.data, products.data],
  );

  function reload() {
    plans.refetch();
    products.refetch();
  }

  async function toggleArchived(plan: Plan) {
    const updated = await archive.mutate({ id: plan.id, active: !plan.active });
    if (updated) {
      plans.refetch();
    }
  }

  const columns: Column<Plan>[] = [
    {
      key: 'name',
      header: 'Plan',
      render: (plan) => <span className="font-medium text-slate-900">{plan.name}</span>,
    },
    {
      key: 'pricing',
      header: 'Pricing',
      render: (plan) => (
        <div>
          <p>{describePlanPrice(plan)}</p>
          {plan.pricingModel === 'TIERED' && (plan.tiers?.length ?? 0) > 0 ? (
            <ul className="mt-1 space-y-0.5 text-xs text-slate-500">
              {describeTiers(plan).map((row) => (
                <li key={row.tier.id}>
                  {row.range}: {row.rate}
                </li>
              ))}
            </ul>
          ) : null}
        </div>
      ),
    },
    {
      key: 'model',
      header: 'Model',
      render: (plan) => (
        <span className="text-slate-500">
          {formatPricingModel(plan.pricingModel)} · {formatInterval(plan.interval)}
        </span>
      ),
    },
    {
      key: 'status',
      header: 'Status',
      render: (plan) => <Badge tone={activeTone(plan.active)}>{activeLabel(plan.active)}</Badge>,
    },
    { key: 'created', header: 'Added', render: (plan) => formatDate(plan.createdAt) },
    {
      key: 'actions',
      header: <span className="sr-only">Actions</span>,
      align: 'right',
      render: (plan) => (
        <button
          type="button"
          className={plan.active ? 'btn-danger' : 'btn-secondary'}
          disabled={archive.isPending}
          onClick={() => void toggleArchived(plan)}
        >
          {plan.active ? `Archive ${plan.name}` : `Restore ${plan.name}`}
        </button>
      ),
    },
  ];

  const isLoading = plans.isLoading || products.isLoading;
  const loadError = plans.error ?? products.error;

  return (
    <div className="space-y-6">
      <PageHeader
        title="Plans"
        description="What you sell, and what each thing costs."
        actions={
          <>
            <button
              type="button"
              className="btn-secondary"
              onClick={() => setCreatingProduct(true)}
            >
              New product
            </button>
            <button
              type="button"
              className="btn-action"
              disabled={(products.data ?? []).length === 0}
              onClick={() => setCreatingPlan(true)}
            >
              New plan
            </button>
          </>
        }
      />

      {archive.error ? <Alert>{formErrorMessage(archive.error)}</Alert> : null}

      {isLoading ? (
        <div className="flex min-h-[30vh] items-center justify-center">
          <Spinner label="Loading the catalogue" />
        </div>
      ) : loadError ? (
        <ErrorState error={loadError} onRetry={reload} />
      ) : groups.length === 0 ? (
        <Card title="Catalogue">
          <EmptyState
            title="No products yet"
            description="A product is the thing you sell; a plan is what it costs. Start with a product."
            action={
              <button type="button" className="btn-action" onClick={() => setCreatingProduct(true)}>
                New product
              </button>
            }
          />
        </Card>
      ) : (
        <div className="space-y-6">
          {groups.map((group) => (
            <Card
              key={group.productId}
              title={group.productName}
              aside={
                <span className="flex items-center gap-2">
                  {group.productActive ? null : <Badge>Archived product</Badge>}
                  <span>{group.plans.length === 1 ? '1 plan' : `${group.plans.length} plans`}</span>
                </span>
              }
            >
              {group.productDescription ? (
                <p className="border-b border-slate-100 px-4 py-2 text-sm text-slate-500">
                  {group.productDescription}
                </p>
              ) : null}
              <DataTable
                caption={`Plans for ${group.productName}`}
                columns={columns}
                rows={group.plans}
                rowKey={(plan) => plan.id}
                empty={
                  <EmptyState
                    title="No plans on this product"
                    description="Add a plan to make it sellable."
                    action={
                      <button
                        type="button"
                        className="btn-action"
                        onClick={() => setCreatingPlan(true)}
                      >
                        New plan
                      </button>
                    }
                  />
                }
              />
            </Card>
          ))}
        </div>
      )}

      {creatingProduct ? (
        <NewProductDialog
          onClose={() => setCreatingProduct(false)}
          onCreated={() => {
            setCreatingProduct(false);
            products.refetch();
          }}
        />
      ) : null}

      {creatingPlan ? (
        <NewPlanDialog
          products={products.data ?? []}
          onClose={() => setCreatingPlan(false)}
          onCreated={() => {
            setCreatingPlan(false);
            plans.refetch();
          }}
        />
      ) : null}
    </div>
  );
}

interface NewProductDialogProps {
  onClose: () => void;
  onCreated: (product: Product) => void;
}

function NewProductDialog({ onClose, onCreated }: NewProductDialogProps) {
  const { api } = useAuth();
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [nameError, setNameError] = useState<string | undefined>(undefined);
  const create = useApiMutation((input: { name: string; description?: string }) =>
    api.createProduct(input),
  );

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();

    if (name.trim() === '') {
      setNameError('Enter a name');
      return;
    }
    setNameError(undefined);

    const input: { name: string; description?: string } = { name: name.trim() };
    if (description.trim() !== '') {
      input.description = description.trim();
    }

    const created = await create.mutate(input);
    if (created) {
      onCreated(created);
    }
  }

  const formError = formErrorMessage(create.error);

  return (
    <Modal
      title="New product"
      description="A product is the thing you sell. Its plans carry the prices."
      onClose={onClose}
    >
      <form onSubmit={handleSubmit} noValidate className="space-y-4">
        {formError ? <Alert>{formError}</Alert> : null}
        <TextField
          label="Name"
          value={name}
          error={nameError ?? create.fieldErrors.name?.[0]}
          disabled={create.isPending}
          onChange={(event) => setName(event.target.value)}
        />
        <TextField
          label="Description"
          value={description}
          error={create.fieldErrors.description?.[0]}
          disabled={create.isPending}
          hint="Optional. Shown above this product's plans."
          onChange={(event) => setDescription(event.target.value)}
        />
        <div className="flex justify-end gap-2 border-t border-slate-200 pt-4">
          <button type="button" className="btn-secondary" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className="btn-action" disabled={create.isPending}>
            {create.isPending ? 'Creating…' : 'Create product'}
          </button>
        </div>
      </form>
    </Modal>
  );
}

interface NewPlanDialogProps {
  products: Product[];
  onClose: () => void;
  onCreated: (plan: Plan) => void;
}

function NewPlanDialog({ products, onClose, onCreated }: NewPlanDialogProps) {
  const { api } = useAuth();
  const [state, setState] = useState<PlanFormState>(() => emptyPlanForm(products[0]?.id ?? ''));
  const [localErrors, setLocalErrors] = useState<PlanFieldErrors>({});
  const create = useApiMutation((input: CreatePlanInput) => api.createPlan(input));

  const errors: PlanFieldErrors = { ...planFieldErrorsFrom(create.fieldErrors), ...localErrors };
  const formError = formErrorMessage(create.error);

  function update(patch: Partial<PlanFormState>) {
    setState((current) => ({ ...current, ...patch }));
  }

  function updateTier(index: number, patch: Partial<PlanFormState['tiers'][number]>) {
    setState((current) => ({
      ...current,
      tiers: current.tiers.map((tier, position) =>
        position === index ? { ...tier, ...patch } : tier,
      ),
    }));
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();

    const built = toCreatePlanInput(state);
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
      title="New plan"
      description="Pricing is fixed once a plan exists — archive and replace it to reprice."
      onClose={onClose}
    >
      <form onSubmit={handleSubmit} noValidate className="space-y-4">
        {formError ? <Alert>{formError}</Alert> : null}

        <SelectField
          label="Product"
          value={state.productId}
          error={errors.productId}
          disabled={create.isPending}
          options={products.map((product) => ({ value: product.id, label: product.name }))}
          onChange={(event) => update({ productId: event.target.value })}
        />

        <TextField
          label="Name"
          value={state.name}
          error={errors.name}
          disabled={create.isPending}
          onChange={(event) => update({ name: event.target.value })}
        />

        <div className="grid gap-4 sm:grid-cols-2">
          <SelectField
            label="Billing interval"
            value={state.interval}
            disabled={create.isPending}
            options={BILLING_INTERVALS.map((interval) => ({
              value: interval,
              label: `Every ${formatInterval(interval)}`,
            }))}
            onChange={(event) =>
              update({ interval: event.target.value as PlanFormState['interval'] })
            }
          />
          <TextField
            label="Currency"
            value={state.currency}
            error={errors.currency}
            disabled={create.isPending}
            hint="3-letter ISO code."
            onChange={(event) => update({ currency: event.target.value })}
          />
        </div>

        <SelectField
          label="Pricing model"
          value={state.pricingModel}
          disabled={create.isPending}
          hint={describePricingModel(state.pricingModel)}
          options={PRICING_MODELS.map((model) => ({
            value: model,
            label: formatPricingModel(model),
          }))}
          onChange={(event) =>
            update({ pricingModel: event.target.value as PlanFormState['pricingModel'] })
          }
        />

        {state.pricingModel === 'FLAT' ? (
          <TextField
            label="Amount"
            value={state.flatAmount}
            error={errors.flatAmount}
            disabled={create.isPending}
            hint={`Charged every ${formatInterval(state.interval)}, e.g. 19.99`}
            onChange={(event) => update({ flatAmount: event.target.value })}
          />
        ) : null}

        {state.pricingModel !== 'FLAT' ? (
          <TextField
            label="Usage metric"
            value={state.usageMetric}
            error={errors.usageMetric}
            disabled={create.isPending}
            hint="The metric usage events are recorded against, e.g. api_call."
            onChange={(event) => update({ usageMetric: event.target.value })}
          />
        ) : null}

        {state.pricingModel === 'USAGE' ? (
          <TextField
            label="Price per unit"
            value={state.usageUnitAmount}
            error={errors.usageUnitAmount}
            disabled={create.isPending}
            hint="e.g. 0.05 for five cents a unit."
            onChange={(event) => update({ usageUnitAmount: event.target.value })}
          />
        ) : null}

        {state.pricingModel === 'TIERED' ? (
          <fieldset className="space-y-3">
            <legend className="field-label">Tiers</legend>
            <p className="text-xs text-slate-500">
              Each band is priced up to and including its bound. Leave the last band&apos;s bound
              empty for “and above”.
            </p>
            {errors.tiers ? <Alert>{errors.tiers}</Alert> : null}

            {state.tiers.map((tier, index) => (
              <div
                key={index}
                className="grid gap-3 rounded-lg border border-slate-200 p-3 sm:grid-cols-3"
              >
                <TextField
                  label={`Up to (tier ${index + 1})`}
                  value={tier.upTo}
                  error={errors[tierFieldKey(index, 'upTo')]}
                  disabled={create.isPending}
                  placeholder="and above"
                  onChange={(event) => updateTier(index, { upTo: event.target.value })}
                />
                <TextField
                  label={`Price per unit (tier ${index + 1})`}
                  value={tier.unitAmount}
                  error={errors[tierFieldKey(index, 'unitAmount')]}
                  disabled={create.isPending}
                  onChange={(event) => updateTier(index, { unitAmount: event.target.value })}
                />
                <TextField
                  label={`Flat fee (tier ${index + 1})`}
                  value={tier.flatFee}
                  error={errors[tierFieldKey(index, 'flatFee')]}
                  disabled={create.isPending}
                  placeholder="0.00"
                  onChange={(event) => updateTier(index, { flatFee: event.target.value })}
                />
                {state.tiers.length > 1 ? (
                  <div className="sm:col-span-3">
                    <button
                      type="button"
                      className="btn-danger"
                      disabled={create.isPending}
                      onClick={() =>
                        update({ tiers: state.tiers.filter((_, position) => position !== index) })
                      }
                    >
                      Remove tier {index + 1}
                    </button>
                  </div>
                ) : null}
              </div>
            ))}

            <button
              type="button"
              className="btn-secondary"
              disabled={create.isPending}
              onClick={() => update({ tiers: [...state.tiers, emptyTierRow()] })}
            >
              Add tier
            </button>
          </fieldset>
        ) : null}

        <div className="flex justify-end gap-2 border-t border-slate-200 pt-4">
          <button type="button" className="btn-secondary" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className="btn-action" disabled={create.isPending}>
            {create.isPending ? 'Creating…' : 'Create plan'}
          </button>
        </div>
      </form>
    </Modal>
  );
}
