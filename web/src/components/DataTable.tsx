import type { ReactNode } from 'react';

export interface Column<T> {
  /** Stable identity for the column, used as the React key. */
  key: string;
  header: ReactNode;
  /** Numbers read better flushed right; text reads better flushed left. */
  align?: 'left' | 'right';
  render: (row: T) => ReactNode;
}

export interface DataTableProps<T> {
  /**
   * The table's accessible name. Rendered as a visually hidden caption so
   * a page with two tables on it (subscriptions and invoices, say) does not
   * present a screen reader with two anonymous grids.
   */
  caption: string;
  columns: readonly Column<T>[];
  rows: readonly T[];
  rowKey: (row: T) => string;
  /** Shown in place of the body when there are no rows. */
  empty?: ReactNode;
}

/**
 * The list rendering every table in the console shares.
 *
 * Generic over the row type rather than over `Record<string, unknown>`, so
 * a column's `render` receives the real `Customer` or `Invoice` and a typo
 * in a field name is a compile error rather than an empty cell.
 */
export function DataTable<T>({ caption, columns, rows, rowKey, empty }: DataTableProps<T>) {
  if (rows.length === 0 && empty) {
    return <>{empty}</>;
  }

  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <caption className="sr-only">{caption}</caption>
        <thead>
          <tr className="border-b border-slate-200 text-left text-xs uppercase tracking-wide text-slate-500">
            {columns.map((column) => (
              <th
                key={column.key}
                scope="col"
                className={`px-4 py-2 font-semibold ${column.align === 'right' ? 'text-right' : ''}`}
              >
                {column.header}
              </th>
            ))}
          </tr>
        </thead>
        <tbody className="divide-y divide-slate-100">
          {rows.map((row) => (
            <tr key={rowKey(row)} className="hover:bg-slate-50">
              {columns.map((column) => (
                <td
                  key={column.key}
                  className={`px-4 py-2.5 text-slate-700 ${
                    column.align === 'right' ? 'text-right tabular-nums' : ''
                  }`}
                >
                  {column.render(row)}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export interface CardProps {
  title: string;
  /** A count or a control that belongs with the title. */
  aside?: ReactNode;
  children: ReactNode;
}

/** The bordered panel a table or a definition list sits in. */
export function Card({ title, aside, children }: CardProps) {
  return (
    <section
      aria-label={title}
      className="overflow-hidden rounded-xl border border-slate-200 bg-white shadow-sm"
    >
      <div className="flex items-center justify-between gap-3 border-b border-slate-200 px-4 py-3">
        <h2 className="text-sm font-semibold text-slate-900">{title}</h2>
        {aside ? <div className="text-sm text-slate-500">{aside}</div> : null}
      </div>
      {children}
    </section>
  );
}
