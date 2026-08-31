import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { CheckboxField, SelectField } from './SelectField';

const OPTIONS = [
  { value: 'MONTH', label: 'Monthly' },
  { value: 'YEAR', label: 'Yearly' },
];

describe('SelectField', () => {
  it('ties its label to the select', () => {
    render(<SelectField label="Interval" options={OPTIONS} defaultValue="MONTH" />);

    expect(screen.getByLabelText('Interval')).toHaveValue('MONTH');
  });

  it('reports a change to its owner', async () => {
    const onChange = vi.fn();
    render(<SelectField label="Interval" options={OPTIONS} value="MONTH" onChange={onChange} />);

    await userEvent.selectOptions(screen.getByLabelText('Interval'), 'YEAR');

    expect(onChange).toHaveBeenCalled();
  });

  it('marks itself invalid and describes the error', () => {
    render(<SelectField label="Interval" options={OPTIONS} error="Pick an interval" />);

    const select = screen.getByLabelText('Interval');
    expect(select).toHaveAttribute('aria-invalid', 'true');
    expect(select).toHaveAccessibleDescription('Pick an interval');
  });

  it('describes itself with a hint when there is no error', () => {
    render(<SelectField label="Interval" options={OPTIONS} hint="How often it bills" />);

    expect(screen.getByLabelText('Interval')).toHaveAccessibleDescription('How often it bills');
  });
});

describe('CheckboxField', () => {
  it('toggles through its label', async () => {
    const onChange = vi.fn();
    render(<CheckboxField label="Tax exempt" checked={false} onChange={onChange} />);

    await userEvent.click(screen.getByLabelText('Tax exempt'));

    expect(onChange).toHaveBeenCalledTimes(1);
  });

  it('carries its hint as an accessible description', () => {
    render(<CheckboxField label="Tax exempt" hint="No tax is charged" readOnly checked />);

    expect(screen.getByLabelText('Tax exempt')).toHaveAccessibleDescription('No tax is charged');
  });
});
