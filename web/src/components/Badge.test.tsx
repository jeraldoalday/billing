import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { Badge, StatusBadge } from './Badge';

describe('Badge', () => {
  it('renders its children', () => {
    render(<Badge>Active</Badge>);
    expect(screen.getByText('Active')).toBeInTheDocument();
  });

  it('applies the tone it was given', () => {
    render(<Badge tone="danger">Failed</Badge>);
    expect(screen.getByText('Failed').className).toContain('red');
  });
});

describe('StatusBadge', () => {
  // The API speaks SCREAMING_SNAKE; a person reading a table should not
  // have to.
  it('humanizes the status the API returned', () => {
    render(<StatusBadge status="PAST_DUE" />);
    expect(screen.getByText('Past due')).toBeInTheDocument();
  });

  it('colours the status by what it means', () => {
    const { rerender } = render(<StatusBadge status="ACTIVE" />);
    expect(screen.getByText('Active').className).toContain('emerald');

    rerender(<StatusBadge status="CANCELED" />);
    expect(screen.getByText('Canceled').className).toContain('slate');
  });
});
