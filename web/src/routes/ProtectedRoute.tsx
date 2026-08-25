import { Navigate, Outlet, useLocation } from 'react-router-dom';
import { FullPageSpinner } from '../components/Spinner';
import { useAuth } from '../auth/AuthContext';

/**
 * Gate for everything behind a login.
 *
 * While the stored session is being revalidated the app renders a spinner
 * rather than either page: redirecting during `loading` would bounce a
 * returning user to /login on every refresh, and rendering the page would
 * fire its requests with a token that may already be dead.
 *
 * The attempted location rides along in the redirect's state so the login
 * page can return the user to where they were going.
 */
export function ProtectedRoute() {
  const { status } = useAuth();
  const location = useLocation();

  if (status === 'loading') {
    return <FullPageSpinner label="Checking your session" />;
  }

  if (status === 'anonymous') {
    return <Navigate to="/login" replace state={{ from: location }} />;
  }

  return <Outlet />;
}
