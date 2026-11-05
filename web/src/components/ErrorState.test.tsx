import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { ApiError } from '../api/client';
import { ErrorState } from './ErrorState';

describe('ErrorState', () => {
  it('shows the server message for an ordinary API error', () => {
    render(<ErrorState error={new ApiError(404, 'NOT_FOUND', 'Customer not found')} />);
    expect(screen.getByRole('alert')).toBeInTheDocument();
    expect(screen.getByText('Customer not found')).toBeInTheDocument();
  });

  it('explains an unreachable server instead of the raw network error', () => {
    render(<ErrorState error={new ApiError(0, 'NETWORK_ERROR', 'Failed to fetch')} />);
    expect(screen.getByText('Could not reach the billing API. Is the server running?')).toBeInTheDocument();
    expect(screen.queryByText('Failed to fetch')).not.toBeInTheDocument();
  });

  it('omits the retry button when no handler is given', () => {
    render(<ErrorState error={new ApiError(500, 'INTERNAL', 'Something went wrong')} />);
    expect(screen.queryByRole('button', { name: 'Try again' })).not.toBeInTheDocument();
  });

  it('calls the retry handler when the button is clicked', async () => {
    const onRetry = vi.fn();
    render(<ErrorState error={new ApiError(500, 'INTERNAL', 'Something went wrong')} onRetry={onRetry} />);

    await userEvent.click(screen.getByRole('button', { name: 'Try again' }));

    expect(onRetry).toHaveBeenCalledTimes(1);
  });
});
