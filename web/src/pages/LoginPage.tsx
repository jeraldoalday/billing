import { useState, type FormEvent } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import { ApiError } from '../api/client';
import { useAuth } from '../auth/AuthContext';
import { Alert } from '../components/Alert';
import { TextField } from '../components/TextField';
import { AuthLayout } from './AuthLayout';

interface RedirectState {
  from?: { pathname?: string };
}

export function LoginPage() {
  const { login } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();

  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [formError, setFormError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string[] | undefined>>({});
  const [submitting, setSubmitting] = useState(false);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (submitting) {
      return;
    }

    setFormError(null);
    setFieldErrors({});
    setSubmitting(true);

    try {
      await login({ email, password });
      // Back to whatever the user was trying to reach before the guard sent
      // them here, or the dashboard if they came to /login directly.
      const state = location.state as RedirectState | null;
      navigate(state?.from?.pathname ?? '/', { replace: true });
    } catch (error) {
      if (error instanceof ApiError) {
        setFieldErrors(error.fieldErrors);
        setFormError(
          error.code === 'NETWORK_ERROR'
            ? 'Could not reach the billing API. Is the server running?'
            : error.message,
        );
      } else {
        setFormError('Something went wrong. Please try again.');
      }
      setSubmitting(false);
    }
  }

  return (
    <AuthLayout
      title="Sign in"
      subtitle="Manage your plans, customers, and invoices"
      footer={
        <>
          No account yet?{' '}
          <Link to="/signup" className="font-semibold text-brand-700 hover:underline">
            Create one
          </Link>
        </>
      }
    >
      <form onSubmit={handleSubmit} noValidate className="space-y-4">
        {formError ? <Alert>{formError}</Alert> : null}

        <TextField
          label="Email"
          type="email"
          name="email"
          autoComplete="email"
          required
          value={email}
          error={fieldErrors.email?.[0]}
          onChange={(event) => setEmail(event.target.value)}
        />

        <TextField
          label="Password"
          type="password"
          name="password"
          autoComplete="current-password"
          required
          value={password}
          error={fieldErrors.password?.[0]}
          onChange={(event) => setPassword(event.target.value)}
        />

        <button type="submit" className="btn-primary" disabled={submitting}>
          {submitting ? 'Signing in…' : 'Sign in'}
        </button>
      </form>
    </AuthLayout>
  );
}
