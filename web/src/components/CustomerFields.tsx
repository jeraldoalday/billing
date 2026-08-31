import type { CustomerFieldErrors, CustomerFormState } from '../lib/customerForm';
import { CheckboxField } from './SelectField';
import { TextField } from './TextField';

export interface CustomerFieldsProps {
  state: CustomerFormState;
  errors: CustomerFieldErrors;
  onChange: (patch: Partial<CustomerFormState>) => void;
  disabled?: boolean;
  /** The active toggle only makes sense once a customer exists. */
  includeActive?: boolean;
}

/**
 * The customer fields, shared by the create dialog and the edit form.
 *
 * Stateless on purpose: both callers already own a `CustomerFormState` for
 * their own reasons (one starts empty, the other starts from a loaded
 * customer and diffs against it), so this renders what it is given and
 * reports edits back as a patch.
 */
export function CustomerFields({
  state,
  errors,
  onChange,
  disabled,
  includeActive,
}: CustomerFieldsProps) {
  return (
    <div className="space-y-4">
      <TextField
        label="Name"
        name="name"
        autoComplete="off"
        value={state.name}
        error={errors.name}
        disabled={disabled}
        onChange={(event) => onChange({ name: event.target.value })}
      />

      <TextField
        label="Email"
        name="email"
        type="email"
        autoComplete="off"
        value={state.email}
        error={errors.email}
        disabled={disabled}
        onChange={(event) => onChange({ email: event.target.value })}
      />

      <div className="grid gap-4 sm:grid-cols-2">
        <TextField
          label="Country"
          name="country"
          value={state.country}
          error={errors.country}
          disabled={disabled}
          hint="2-letter code, e.g. GB. Sets the tax jurisdiction."
          onChange={(event) => onChange({ country: event.target.value })}
        />

        <TextField
          label="Tax ID"
          name="taxId"
          value={state.taxId}
          error={errors.taxId}
          disabled={disabled}
          hint="VAT or GST registration, if they have one."
          onChange={(event) => onChange({ taxId: event.target.value })}
        />
      </div>

      <CheckboxField
        label="Tax exempt"
        checked={state.taxExempt}
        disabled={disabled}
        hint="No tax is charged on this customer's invoices."
        onChange={(event) => onChange({ taxExempt: event.target.checked })}
      />

      {includeActive ? (
        <CheckboxField
          label="Active"
          checked={state.active}
          disabled={disabled}
          hint="Inactive customers keep their invoices but are hidden from the active list."
          onChange={(event) => onChange({ active: event.target.checked })}
        />
      ) : null}
    </div>
  );
}
