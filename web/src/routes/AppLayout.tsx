import { NavLink, Outlet } from 'react-router-dom';
import { useAuth } from '../auth/AuthContext';
import { initialsFor } from '../lib/format';

const NAV_ITEMS = [
  { to: '/', label: 'Dashboard', end: true },
  { to: '/customers', label: 'Customers', end: false },
  { to: '/plans', label: 'Plans', end: false },
  { to: '/invoices', label: 'Invoices', end: false },
] as const;

function navLinkClass({ isActive }: { isActive: boolean }): string {
  return [
    'block rounded-lg px-3 py-2 text-sm font-medium transition',
    isActive ? 'bg-brand-50 text-brand-800' : 'text-slate-600 hover:bg-slate-100',
  ].join(' ');
}

/** The chrome around every signed-in page: sidebar, org header, sign out. */
export function AppLayout() {
  const { user, organization, logout } = useAuth();

  return (
    <div className="flex min-h-screen bg-slate-50">
      <aside className="hidden w-60 shrink-0 border-r border-slate-200 bg-white p-4 md:block">
        <div className="mb-6 px-1">
          <p className="text-xs font-semibold uppercase tracking-wide text-slate-400">
            Organization
          </p>
          <p className="truncate text-sm font-semibold text-slate-900">
            {organization?.name ?? '—'}
          </p>
        </div>

        <nav aria-label="Main">
          <ul className="space-y-1">
            {NAV_ITEMS.map((item) => (
              <li key={item.to}>
                <NavLink to={item.to} end={item.end} className={navLinkClass}>
                  {item.label}
                </NavLink>
              </li>
            ))}
          </ul>
        </nav>
      </aside>

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex items-center justify-between border-b border-slate-200 bg-white px-6 py-3">
          <span className="text-sm font-semibold text-slate-900 md:hidden">
            {organization?.name ?? 'Billing'}
          </span>
          <span className="hidden text-sm text-slate-500 md:block">Billing console</span>

          <div className="flex items-center gap-3">
            <span
              aria-hidden="true"
              className="flex h-8 w-8 items-center justify-center rounded-full bg-brand-100 text-xs font-semibold text-brand-800"
            >
              {user ? initialsFor(user.name, user.email) : '?'}
            </span>
            <span className="hidden text-sm text-slate-600 sm:block">{user?.email}</span>
            <button
              type="button"
              onClick={logout}
              className="rounded-lg border border-slate-300 px-3 py-1.5 text-sm font-medium text-slate-700 transition hover:bg-slate-100"
            >
              Sign out
            </button>
          </div>
        </header>

        <main className="flex-1 p-6">
          <Outlet />
        </main>
      </div>
    </div>
  );
}
