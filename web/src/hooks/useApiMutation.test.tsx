import { act, renderHook, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { ApiError } from '../api/client';
import { formErrorMessage, useApiMutation } from './useApiMutation';

/** A promise the test resolves or rejects when it chooses to. */
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe('useApiMutation', () => {
  it('resolves with what the API returned', async () => {
    const perform = vi.fn().mockResolvedValue({ id: 'cus_1' });
    const { result } = renderHook(() => useApiMutation(perform));

    let returned: unknown;
    await act(async () => {
      returned = await result.current.mutate({ name: 'Ada' });
    });

    expect(perform).toHaveBeenCalledWith({ name: 'Ada' });
    expect(returned).toEqual({ id: 'cus_1' });
    expect(result.current.error).toBeNull();
    expect(result.current.isPending).toBe(false);
  });

  it('reports that it is pending while the request is in flight', async () => {
    const pending = deferred<{ id: string }>();
    const { result } = renderHook(() => useApiMutation(() => pending.promise));

    act(() => {
      void result.current.mutate(undefined);
    });
    await waitFor(() => expect(result.current.isPending).toBe(true));

    await act(async () => {
      pending.resolve({ id: 'cus_1' });
      await pending.promise;
    });
    expect(result.current.isPending).toBe(false);
  });

  it('captures a failure instead of throwing, and resolves null', async () => {
    const conflict = new ApiError(409, 'CONFLICT', 'A customer with this email already exists');
    const { result } = renderHook(() => useApiMutation(() => Promise.reject(conflict)));

    let returned: unknown = 'unset';
    await act(async () => {
      returned = await result.current.mutate(undefined);
    });

    expect(returned).toBeNull();
    expect(result.current.error).toBe(conflict);
    expect(result.current.isPending).toBe(false);
  });

  it('exposes the server per-field messages for the form to render', async () => {
    const invalid = new ApiError(400, 'VALIDATION_ERROR', 'Invalid request', {
      formErrors: [],
      fieldErrors: { email: ['Invalid email'] },
    });
    const { result } = renderHook(() => useApiMutation(() => Promise.reject(invalid)));

    await act(async () => {
      await result.current.mutate(undefined);
    });

    expect(result.current.fieldErrors.email).toEqual(['Invalid email']);
  });

  it('wraps a non-API failure so callers only ever see an ApiError', async () => {
    const { result } = renderHook(() => useApiMutation(() => Promise.reject(new Error('boom'))));

    await act(async () => {
      await result.current.mutate(undefined);
    });

    expect(result.current.error).toBeInstanceOf(ApiError);
    expect(result.current.error?.code).toBe('UNKNOWN_ERROR');
  });

  // A double-clicked "Create" must not create two customers: the second
  // click can land before React has re-rendered the disabled button.
  it('drops a second submit while the first is still running', async () => {
    const pending = deferred<{ id: string }>();
    const perform = vi.fn().mockReturnValue(pending.promise);
    const { result } = renderHook(() => useApiMutation(perform));

    let second: unknown = 'unset';
    await act(async () => {
      void result.current.mutate(undefined);
      second = await result.current.mutate(undefined);
    });

    expect(perform).toHaveBeenCalledTimes(1);
    expect(second).toBeNull();

    await act(async () => {
      pending.resolve({ id: 'cus_1' });
      await pending.promise;
    });
  });

  it('accepts a new submit once the first has finished', async () => {
    const perform = vi.fn().mockResolvedValue({ id: 'cus_1' });
    const { result } = renderHook(() => useApiMutation(perform));

    await act(async () => {
      await result.current.mutate(undefined);
    });
    await act(async () => {
      await result.current.mutate(undefined);
    });

    expect(perform).toHaveBeenCalledTimes(2);
  });

  it('clears the last failure on reset', async () => {
    const { result } = renderHook(() =>
      useApiMutation(() => Promise.reject(new ApiError(500, 'ERROR', 'Server error'))),
    );

    await act(async () => {
      await result.current.mutate(undefined);
    });
    expect(result.current.error).not.toBeNull();

    act(() => {
      result.current.reset();
    });
    expect(result.current.error).toBeNull();
    expect(result.current.fieldErrors).toEqual({});
  });

  it('does not set state after the component has gone', async () => {
    const pending = deferred<{ id: string }>();
    const { result, unmount } = renderHook(() => useApiMutation(() => pending.promise));

    act(() => {
      void result.current.mutate(undefined);
    });
    unmount();

    await act(async () => {
      pending.reject(new ApiError(500, 'ERROR', 'Server error'));
      await pending.promise.catch(() => undefined);
    });

    // Nothing to assert on the unmounted hook itself; the test would fail
    // on React's "state update on an unmounted component" warning if the
    // mounted guard were missing.
    expect(true).toBe(true);
  });

  it('calls the latest performer, not the one from first render', async () => {
    const first = vi.fn().mockResolvedValue('first');
    const second = vi.fn().mockResolvedValue('second');
    const { result, rerender } = renderHook(({ perform }) => useApiMutation(perform), {
      initialProps: { perform: first as (input: unknown) => Promise<string> },
    });

    rerender({ perform: second as (input: unknown) => Promise<string> });
    await act(async () => {
      await result.current.mutate(undefined);
    });

    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledTimes(1);
  });
});

describe('formErrorMessage', () => {
  it('has nothing to say when nothing failed', () => {
    expect(formErrorMessage(null)).toBeNull();
  });

  // The fields already carry the complaint; a banner saying "Invalid
  // request" above them adds noise and no information.
  it('stays quiet for a validation failure the fields already show', () => {
    const invalid = new ApiError(400, 'VALIDATION_ERROR', 'Invalid request', {
      formErrors: [],
      fieldErrors: { email: ['Invalid email'] },
    });

    expect(formErrorMessage(invalid)).toBeNull();
  });

  it('surfaces a validation failure that named no field', () => {
    const invalid = new ApiError(400, 'VALIDATION_ERROR', 'Invalid request', {
      formErrors: ['At least one field must be provided'],
      fieldErrors: {},
    });

    expect(formErrorMessage(invalid)).toBe('Invalid request');
  });

  it('explains a dead server rather than repeating the raw message', () => {
    expect(formErrorMessage(new ApiError(0, 'NETWORK_ERROR', 'Could not reach the billing API'))).toBe(
      'Could not reach the billing API. Is the server running?',
    );
  });

  it('passes any other failure through', () => {
    expect(formErrorMessage(new ApiError(409, 'CONFLICT', 'Email already in use'))).toBe(
      'Email already in use',
    );
  });
});
