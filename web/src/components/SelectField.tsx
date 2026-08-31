import { useId, type InputHTMLAttributes, type SelectHTMLAttributes } from 'react';

export interface SelectOption {
  value: string;
  label: string;
}

export interface SelectFieldProps extends Omit<SelectHTMLAttributes<HTMLSelectElement>, 'id'> {
  label: string;
  options: readonly SelectOption[];
  error?: string | undefined;
  hint?: string | undefined;
}

/**
 * A labelled `<select>`, tied to its label the same way `TextField` is so
 * `getByLabelText` and a screen reader both find it.
 */
export function SelectField({
  label,
  options,
  error,
  hint,
  className,
  ...selectProps
}: SelectFieldProps) {
  const id = useId();
  const errorId = `${id}-error`;
  const hintId = `${id}-hint`;
  const describedBy = [error ? errorId : null, hint ? hintId : null].filter(Boolean).join(' ');

  return (
    <div className={className}>
      <label className="field-label" htmlFor={id}>
        {label}
      </label>
      <select
        id={id}
        aria-invalid={error ? true : undefined}
        aria-describedby={describedBy || undefined}
        className={`field-input ${error ? 'field-input-invalid' : ''}`}
        {...selectProps}
      >
        {options.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
      {hint ? (
        <p id={hintId} className="mt-1.5 text-xs text-slate-500">
          {hint}
        </p>
      ) : null}
      {error ? (
        <p id={errorId} className="mt-1.5 text-xs font-medium text-red-600">
          {error}
        </p>
      ) : null}
    </div>
  );
}

export interface CheckboxFieldProps extends Omit<InputHTMLAttributes<HTMLInputElement>, 'id' | 'type'> {
  label: string;
  hint?: string | undefined;
}

/** A labelled checkbox, for the booleans the API takes (`taxExempt`). */
export function CheckboxField({ label, hint, className, ...inputProps }: CheckboxFieldProps) {
  const id = useId();
  const hintId = `${id}-hint`;

  return (
    <div className={`flex items-start gap-2.5 ${className ?? ''}`}>
      <input
        id={id}
        type="checkbox"
        aria-describedby={hint ? hintId : undefined}
        className="mt-0.5 h-4 w-4 rounded border-slate-300 text-brand-600 focus:ring-brand-500"
        {...inputProps}
      />
      <div className="min-w-0">
        <label htmlFor={id} className="text-sm font-medium text-slate-700">
          {label}
        </label>
        {hint ? (
          <p id={hintId} className="text-xs text-slate-500">
            {hint}
          </p>
        ) : null}
      </div>
    </div>
  );
}
