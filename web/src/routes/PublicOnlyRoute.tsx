import { Navigate, Outlet, useLocation } from 'react-router-dom';
import { FullPageSpinner } from '../components/Spinner';
import { useAuth } from '../auth/AuthContext';

interface RedirectState {
  from?: { pathname?: string };
}

/**
 * The mirror of ProtectedRoute, for /login and /signup: a signed-in user
 * has no business on them, so they are sent on to wherever they were
 * originally headed, or to the dashboard.
 */
export function PublicOnlyRoute() {
  const { status } = useAuth();
  const location = useLocation();

  if (status === 'loading') {
    return <FullPageSpinner label="Checking your session" />;
  }

  if (status === 'authenticated') {
    const state = location.state as RedirectState | null;
    return <Navigate to={state?.from?.pathname ?? '/'} replace />;
  }

  return <Outlet />;
}
