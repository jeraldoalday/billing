import { useState, type FormEvent } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { ApiError } from '../api/client';
import { useAuth } from '../auth/AuthContext';
import { Alert } from '../components/Alert';
import { TextField } from '../components/TextField';
import { AuthLayout } from './AuthLayout';

/** Matches the server's `z.string().min(8)` on the signup password. */
const MIN_PASSWORD_LENGTH = 8;

export function SignupPage() {
  const { signup } = useAuth();
  const navigate = useNavigate();

  const [organizationName, setOrganizationName] = useState('');
  const [name, setName] = useState('');
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

    // The server enforces this too — checking here just saves a round trip
    // and puts the message under the field instead of at the top.
    if (password.length < MIN_PASSWORD_LENGTH) {
      setFieldErrors({
        password: [`Password must be at least ${MIN_PASSWORD_LENGTH} characters`],
      });
      return;
    }

    setSubmitting(true);

    try {
      await signup({
        organizationName,
        email,
        password,
        // An empty optional field must be omitted, not sent as "", which
        // the server's min(1) would reject.
        ...(name.trim() ? { name: name.trim() } : {}),
      });
      navigate('/', { replace: true });
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
      title="Create your organization"
      subtitle="Start billing customers in a few minutes"
      footer={
        <>
          Already have an account?{' '}
          <Link to="/login" className="font-semibold text-brand-700 hover:underline">
            Sign in
          </Link>
        </>
      }
    >
      <form onSubmit={handleSubmit} noValidate className="space-y-4">
        {formError ? <Alert>{formError}</Alert> : null}

        <TextField
          label="Organization name"
          name="organizationName"
          autoComplete="organization"
          required
          value={organizationName}
          error={fieldErrors.organizationName?.[0]}
          onChange={(event) => setOrganizationName(event.target.value)}
        />

        <TextField
          label="Your name"
          name="name"
          autoComplete="name"
          hint="Optional"
          value={name}
          error={fieldErrors.name?.[0]}
          onChange={(event) => setName(event.target.value)}
        />

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
          autoComplete="new-password"
          required
          hint={`At least ${MIN_PASSWORD_LENGTH} characters`}
          value={password}
          error={fieldErrors.password?.[0]}
          onChange={(event) => setPassword(event.target.value)}
        />

        <button type="submit" className="btn-primary" disabled={submitting}>
          {submitting ? 'Creating your organization…' : 'Create organization'}
        </button>
      </form>
    </AuthLayout>
  );
}
