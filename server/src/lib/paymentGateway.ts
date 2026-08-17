// A PaymentGateway abstraction so the rest of the codebase never talks to a
// real payment processor directly. MockPaymentGateway is the only
// implementation for now (no real network calls); a future real gateway
// (Stripe, Adyen, ...) would implement the same interface, and
// payment.service could take one as a constructor/call argument in its
// place without any other code changing.

export type ChargeFailureCode = 'card_declined' | 'expired_card' | 'insufficient_funds' | 'processing_error';

export interface ChargeRequest {
  /** Last four digits of the card being charged (the only card data ever kept post-tokenization). */
  last4: string;
  /** Integer minor currency units (e.g. cents). */
  amount: number;
  currency: string;
  /** 1-indexed attempt number for this logical charge, used by the mock to simulate transient failures. */
  attempt: number;
}

export type ChargeResult = { status: 'succeeded' } | { status: 'declined'; failureCode: ChargeFailureCode };

export interface PaymentGateway {
  charge(request: ChargeRequest): Promise<ChargeResult>;
}

// Only a processing-side hiccup is worth retrying — a hard decline (bad
// card, insufficient funds, expired) will fail again no matter how many
// times the exact same charge is retried, so retrying it just wastes time
// and, on a real processor, risks tripping fraud controls.
const RETRIABLE_FAILURE_CODES: ReadonlySet<ChargeFailureCode> = new Set(['processing_error']);

export function isRetriableFailureCode(code: ChargeFailureCode): boolean {
  return RETRIABLE_FAILURE_CODES.has(code);
}

// Magic last-four digits (mirroring the shape of Stripe's published test
// card numbers) that deterministically drive MockPaymentGateway's outcome.
// This lets payment flows — including retry/decline handling — be exercised
// end-to-end in tests without any network dependency or randomness.
const HARD_DECLINE_LAST4: Readonly<Record<string, ChargeFailureCode>> = {
  '0002': 'card_declined',
  '0069': 'expired_card',
  '0341': 'insufficient_funds',
};

// Simulates a transient processor error: declines with a retriable code on
// the first two attempts, then succeeds — a deterministic case for proving
// retry logic recovers.
const TRANSIENT_FAILURE_LAST4 = '0119';
const TRANSIENT_FAILURE_SUCCEEDS_ON_ATTEMPT = 3;

// Simulates a processor that never recovers, so retry logic has a
// deterministic case to prove it gives up after exhausting its attempts
// rather than retrying forever.
const PERMANENT_PROCESSING_ERROR_LAST4 = '0127';

export class MockPaymentGateway implements PaymentGateway {
  async charge(request: ChargeRequest): Promise<ChargeResult> {
    const hardDeclineCode = HARD_DECLINE_LAST4[request.last4];
    if (hardDeclineCode) {
      return { status: 'declined', failureCode: hardDeclineCode };
    }

    if (request.last4 === PERMANENT_PROCESSING_ERROR_LAST4) {
      return { status: 'declined', failureCode: 'processing_error' };
    }

    if (request.last4 === TRANSIENT_FAILURE_LAST4 && request.attempt < TRANSIENT_FAILURE_SUCCEEDS_ON_ATTEMPT) {
      return { status: 'declined', failureCode: 'processing_error' };
    }

    return { status: 'succeeded' };
  }
}
