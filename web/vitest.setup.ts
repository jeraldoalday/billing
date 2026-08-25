import '@testing-library/jest-dom/vitest';
import { cleanup } from '@testing-library/react';
import { afterEach } from 'vitest';

// Every test renders into the same jsdom document; unmount between tests so
// a query like getByRole can never match a leftover tree from the last one.
afterEach(() => {
  cleanup();
});
