import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { TextField } from './TextField';

describe('TextField', () => {
  it('ties the label to the input so it is found by its label text', () => {
    render(<TextField label="Email" value="" onChange={() => {}} />);
    expect(screen.getByLabelText('Email')).toBeInTheDocument();
  });

  it('renders a hint but leaves the input valid', () => {
    render(<TextField label="Name" hint="As it appears on invoices" value="" onChange={() => {}} />);
    const input = screen.getByLabelText('Name');
    expect(screen.getByText('As it appears on invoices')).toBeInTheDocument();
    expect(input).not.toHaveAttribute('aria-invalid');
  });

  it('marks the input invalid and describes it by the error message', () => {
    render(<TextField label="Email" error="Email is required" value="" onChange={() => {}} />);
    const input = screen.getByLabelText('Email');
    const message = screen.getByText('Email is required');

    expect(input).toHaveAttribute('aria-invalid', 'true');
    expect(input.getAttribute('aria-describedby')).toContain(message.id);
  });

  it('describes the input by both the hint and the error when both are present', () => {
    render(
      <TextField
        label="Tax ID"
        hint="Starts with your country code"
        error="Tax ID does not match the country on file"
        value=""
        onChange={() => {}}
      />,
    );
    const input = screen.getByLabelText('Tax ID');
    const describedBy = input.getAttribute('aria-describedby') ?? '';

    expect(describedBy).toContain(screen.getByText(/Starts with your country code/).id);
    expect(describedBy).toContain(screen.getByText(/does not match the country on file/).id);
  });
});
