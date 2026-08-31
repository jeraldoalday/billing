import { render, screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { Card, DataTable, type Column } from './DataTable';

interface Row {
  id: string;
  name: string;
  total: number;
}

const ROWS: Row[] = [
  { id: 'a', name: 'Ada', total: 1 },
  { id: 'b', name: 'Grace', total: 2 },
];

const COLUMNS: Column<Row>[] = [
  { key: 'name', header: 'Name', render: (row) => row.name },
  { key: 'total', header: 'Total', align: 'right', render: (row) => row.total },
];

describe('DataTable', () => {
  it('renders a row per record under the column headers', () => {
    render(<DataTable caption="People" columns={COLUMNS} rows={ROWS} rowKey={(row) => row.id} />);

    const table = screen.getByRole('table', { name: 'People' });
    expect(within(table).getAllByRole('columnheader').map((th) => th.textContent)).toEqual([
      'Name',
      'Total',
    ]);
    // Two records plus the header row.
    expect(within(table).getAllByRole('row')).toHaveLength(3);
    expect(within(table).getByText('Grace')).toBeInTheDocument();
  });

  it('flushes a numeric column right', () => {
    render(<DataTable caption="People" columns={COLUMNS} rows={ROWS} rowKey={(row) => row.id} />);

    expect(screen.getByText('1').className).toContain('text-right');
    expect(screen.getByText('Ada').className).not.toContain('text-right');
  });

  // An empty table with headers and no rows reads as a loading bug; the
  // caller's empty state says what is actually going on.
  it('renders the empty state instead of an empty grid', () => {
    render(
      <DataTable
        caption="People"
        columns={COLUMNS}
        rows={[]}
        rowKey={(row) => row.id}
        empty={<p>No people yet</p>}
      />,
    );

    expect(screen.queryByRole('table')).not.toBeInTheDocument();
    expect(screen.getByText('No people yet')).toBeInTheDocument();
  });

  it('still renders the grid when no empty state was supplied', () => {
    render(<DataTable caption="People" columns={COLUMNS} rows={[]} rowKey={(row) => row.id} />);

    expect(screen.getByRole('table', { name: 'People' })).toBeInTheDocument();
  });
});

describe('Card', () => {
  it('names its region so a page with several is navigable', () => {
    render(
      <Card title="Invoices" aside="3 total">
        <p>Body</p>
      </Card>,
    );

    const region = screen.getByRole('region', { name: 'Invoices' });
    expect(within(region).getByRole('heading', { name: 'Invoices' })).toBeInTheDocument();
    expect(within(region).getByText('3 total')).toBeInTheDocument();
    expect(within(region).getByText('Body')).toBeInTheDocument();
  });
});
