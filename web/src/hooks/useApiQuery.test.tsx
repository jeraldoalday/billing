import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { ApiError } from '../api/client';
import { useApiQuery } from './useApiQuery';

interface ProbeProps {
  fetcher: (signal: AbortSignal) => Promise<string>;
  enabled?: boolean;
  dep?: string;
}

function Probe({ fetcher, enabled, dep = 'a' }: ProbeProps) {
  const { status, data, error, refetch } = useApiQuery(fetcher, [dep], {
    ...(enabled === undefined ? {} : { enabled }),
  });

  return (
    <div>
      <p data-testid="status">{status}</p>
      <p data-testid="data">{data ?? 'none'}</p>
      <p data-testid="error">{error?.message ?? 'none'}</p>
      <button onClick={refetch}>refetch</button>
    </div>
  );
}

/** A promise the test resolves by hand, to control when a request lands. */
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe('useApiQuery', () => {
  it('starts loading and resolves to the data', async () => {
    render(<Probe fetcher={async () => 'hello'} />);

    expect(screen.getByTestId('status')).toHaveTextContent('loading');

    await waitFor(() => expect(screen.getByTestId('status')).toHaveTextContent('success'));
    expect(screen.getByTestId('data')).toHaveTextContent('hello');
  });

  it('surfaces an ApiError as-is', async () => {
    const fetcher = async () => {
      throw new ApiError(404, 'NOT_FOUND', 'Customer not found');
    };

    render(<Probe fetcher={fetcher} />);

    await waitFor(() => expect(screen.getByTestId('status')).toHaveTextContent('error'));
    expect(screen.getByTestId('error')).toHaveTextContent('Customer not found');
  });

  it('wraps a non-ApiError failure', async () => {
    const fetcher = async () => {
      throw new Error('boom');
    };

    render(<Probe fetcher={fetcher} />);

    await waitFor(() =>
      expect(screen.getByTestId('error')).toHaveTextContent('Something went wrong'),
    );
  });

  it('stays quiet when the request is aborted', async () => {
    const fetcher = async () => {
      throw new DOMException('aborted', 'AbortError');
    };

    render(<Probe fetcher={fetcher} />);

    // An abort is our own doing, so it must not become an error state.
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(screen.getByTestId('status')).toHaveTextContent('loading');
  });

  it('does not run at all when disabled', async () => {
    const fetcher = vi.fn(async () => 'hello');

    render(<Probe fetcher={fetcher} enabled={false} />);

    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('runs once the query becomes enabled', async () => {
    const fetcher = vi.fn(async () => 'hello');

    function Toggle() {
      const [enabled, setEnabled] = useState(false);
      return (
        <div>
          <button onClick={() => setEnabled(true)}>enable</button>
          <Probe fetcher={fetcher} enabled={enabled} />
        </div>
      );
    }

    render(<Toggle />);
    await userEvent.click(screen.getByRole('button', { name: 'enable' }));

    await waitFor(() => expect(fetcher).toHaveBeenCalledTimes(1));
  });

  it('re-runs on refetch', async () => {
    let calls = 0;
    const fetcher = async () => `call ${++calls}`;

    render(<Probe fetcher={fetcher} />);
    await waitFor(() => expect(screen.getByTestId('data')).toHaveTextContent('call 1'));

    await userEvent.click(screen.getByRole('button', { name: 'refetch' }));

    await waitFor(() => expect(screen.getByTestId('data')).toHaveTextContent('call 2'));
  });

  it('re-runs when a dependency changes', async () => {
    const fetcher = vi.fn(async () => 'hello');

    function WithDep() {
      const [dep, setDep] = useState('a');
      return (
        <div>
          <button onClick={() => setDep('b')}>change</button>
          <Probe fetcher={fetcher} dep={dep} />
        </div>
      );
    }

    render(<WithDep />);
    await waitFor(() => expect(fetcher).toHaveBeenCalledTimes(1));

    await userEvent.click(screen.getByRole('button', { name: 'change' }));

    await waitFor(() => expect(fetcher).toHaveBeenCalledTimes(2));
  });

  // A slow first request landing after a refetch must not overwrite the
  // newer answer with stale data.
  it('discards a response from a superseded run', async () => {
    const first = deferred<string>();
    const second = deferred<string>();
    let call = 0;
    const fetcher = () => (++call === 1 ? first.promise : second.promise);

    render(<Probe fetcher={fetcher} />);
    await userEvent.click(screen.getByRole('button', { name: 'refetch' }));

    await act(async () => {
      second.resolve('newest');
      first.resolve('stale');
      await Promise.resolve();
    });

    await waitFor(() => expect(screen.getByTestId('data')).toHaveTextContent('newest'));
  });

  it('aborts the in-flight request when the component unmounts', async () => {
    let seenSignal: AbortSignal | null = null;
    const fetcher = (signal: AbortSignal) => {
      seenSignal = signal;
      return new Promise<string>(() => undefined);
    };

    const { unmount } = render(<Probe fetcher={fetcher} />);
    unmount();

    await waitFor(() => expect(seenSignal?.aborted).toBe(true));
  });
});
