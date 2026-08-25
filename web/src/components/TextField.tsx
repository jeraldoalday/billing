import { useId, type InputHTMLAttributes } from 'react';

export interface TextFieldProps extends Omit<InputHTMLAttributes<HTMLInputElement>, 'id'> {
  label: string;
  /** Message shown under the input; also marks it invalid for assistive tech. */
  error?: string | undefined;
  hint?: string | undefined;
}

/**
 * A labelled text input.
 *
 * The label is tied to the input through a generated id rather than by
 * wrapping, so `getByLabelText` finds it and so does a screen reader. When
 * there is an error the input is marked `aria-invalid` and pointed at the
 * message through `aria-describedby`, which is what makes the message get
 * announced instead of just being red.
 */
export function TextField({ label, error, hint, className, ...inputProps }: TextFieldProps) {
  const id = useId();
  const errorId = `${id}-error`;
  const hintId = `${id}-hint`;
  const describedBy = [error ? errorId : null, hint ? hintId : null].filter(Boolean).join(' ');

  return (
    <div className={className}>
      <label className="field-label" htmlFor={id}>
        {label}
      </label>
      <input
        id={id}
        aria-invalid={error ? true : undefined}
        aria-describedby={describedBy || undefined}
        className={`field-input ${error ? 'field-input-invalid' : ''}`}
        {...inputProps}
      />
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
