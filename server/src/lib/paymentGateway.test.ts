import { describe, expect, it } from 'vitest';
import { isRetriableFailureCode, MockPaymentGateway } from './paymentGateway';

const gateway = new MockPaymentGateway();
const baseRequest = { amount: 1000, currency: 'usd', attempt: 1 };

describe('MockPaymentGateway', () => {
  it('succeeds for an ordinary card number', async () => {
    const result = await gateway.charge({ ...baseRequest, last4: '4242' });

    expect(result.status).toBe('succeeded');
  });

  it('hard-declines a card ending in 0002 with card_declined, regardless of attempt', async () => {
    const first = await gateway.charge({ ...baseRequest, last4: '0002', attempt: 1 });
    const second = await gateway.charge({ ...baseRequest, last4: '0002', attempt: 2 });

    expect(first).toEqual({ status: 'declined', failureCode: 'card_declined' });
    expect(second).toEqual({ status: 'declined', failureCode: 'card_declined' });
  });

  it('hard-declines a card ending in 0069 with expired_card', async () => {
    const result = await gateway.charge({ ...baseRequest, last4: '0069' });

    expect(result).toEqual({ status: 'declined', failureCode: 'expired_card' });
  });

  it('hard-declines a card ending in 0341 with insufficient_funds', async () => {
    const result = await gateway.charge({ ...baseRequest, last4: '0341' });

    expect(result).toEqual({ status: 'declined', failureCode: 'insufficient_funds' });
  });

  it('declines a card ending in 0119 with processing_error on the first two attempts, then succeeds', async () => {
    const attempt1 = await gateway.charge({ ...baseRequest, last4: '0119', attempt: 1 });
    const attempt2 = await gateway.charge({ ...baseRequest, last4: '0119', attempt: 2 });
    const attempt3 = await gateway.charge({ ...baseRequest, last4: '0119', attempt: 3 });

    expect(attempt1).toEqual({ status: 'declined', failureCode: 'processing_error' });
    expect(attempt2).toEqual({ status: 'declined', failureCode: 'processing_error' });
    expect(attempt3).toEqual({ status: 'succeeded' });
  });

  it('always declines a card ending in 0127 with processing_error, no matter the attempt', async () => {
    const attempt1 = await gateway.charge({ ...baseRequest, last4: '0127', attempt: 1 });
    const attempt10 = await gateway.charge({ ...baseRequest, last4: '0127', attempt: 10 });

    expect(attempt1).toEqual({ status: 'declined', failureCode: 'processing_error' });
    expect(attempt10).toEqual({ status: 'declined', failureCode: 'processing_error' });
  });
});

describe('isRetriableFailureCode', () => {
  it('treats processing_error as retriable', () => {
    expect(isRetriableFailureCode('processing_error')).toBe(true);
  });

  it('treats hard declines as not retriable', () => {
    expect(isRetriableFailureCode('card_declined')).toBe(false);
    expect(isRetriableFailureCode('expired_card')).toBe(false);
    expect(isRetriableFailureCode('insufficient_funds')).toBe(false);
  });
});
