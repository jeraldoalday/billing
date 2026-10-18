import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { AuthLayout } from './AuthLayout';

describe('AuthLayout', () => {
  it('renders the title, subtitle, children, and footer it was given', () => {
    render(
      <AuthLayout title="Sign in" subtitle="Welcome back" footer={<span>Need an account?</span>}>
        <p>form goes here</p>
      </AuthLayout>,
    );

    expect(screen.getByRole('heading', { name: 'Sign in' })).toBeInTheDocument();
    expect(screen.getByText('Welcome back')).toBeInTheDocument();
    expect(screen.getByText('form goes here')).toBeInTheDocument();
    expect(screen.getByText('Need an account?')).toBeInTheDocument();
  });
});
