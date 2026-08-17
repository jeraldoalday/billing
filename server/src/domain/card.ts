// Pure helpers for working with a raw card number at the point it's
// tokenized into a PaymentMethod. Once stored, only brand/last4/expiry are
// kept (see prisma/schema.prisma) — the raw number itself is never
// persisted, mirroring how real payment processors avoid storing a PAN.

export const CARD_BRANDS = ['VISA', 'MASTERCARD', 'AMEX', 'UNKNOWN'] as const;
export type CardBrand = (typeof CARD_BRANDS)[number];

// Minimal IIN/BIN range detection, enough to distinguish the major brands
// for display purposes. Not exhaustive (real BIN tables are huge and
// operator-licensed); anything unrecognized is UNKNOWN rather than a guess.
export function detectCardBrand(cardNumber: string): CardBrand {
  if (/^4\d*$/.test(cardNumber)) {
    return 'VISA';
  }
  if (/^5[1-5]\d*$/.test(cardNumber)) {
    return 'MASTERCARD';
  }
  if (/^3[47]\d*$/.test(cardNumber)) {
    return 'AMEX';
  }
  return 'UNKNOWN';
}

export function lastFour(cardNumber: string): string {
  return cardNumber.slice(-4);
}

// True once the card's expiration has passed as of `now`, using the
// standard convention that a card is valid through the LAST instant of its
// expiry month (e.g. a card expiring 03/2026 is still usable throughout
// March 2026, and expires the moment April begins).
export function isCardExpired(expMonth: number, expYear: number, now: Date = new Date()): boolean {
  const firstInstantAfterExpiry = new Date(Date.UTC(expYear, expMonth, 1));
  return now.getTime() >= firstInstantAfterExpiry.getTime();
}
