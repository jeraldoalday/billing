// Pure helpers for working with a raw card number at the point it's
// tokenized into a PaymentMethod. Once stored, only brand/last4/expiry are
// kept (see prisma/schema.prisma) — the raw number itself is never
// persisted, mirroring how real payment processors avoid storing a PAN.

export const CARD_BRANDS = ['VISA', 'MASTERCARD', 'AMEX', 'DISCOVER', 'UNKNOWN'] as const;
export type CardBrand = (typeof CARD_BRANDS)[number];

// Minimal IIN/BIN range detection, enough to distinguish the major brands
// for display purposes. Not exhaustive (real BIN tables are huge and
// operator-licensed); anything unrecognized is UNKNOWN rather than a guess.
export function detectCardBrand(cardNumber: string): CardBrand {
  if (/^4\d*$/.test(cardNumber)) {
    return 'VISA';
  }
  if (/^5[1-5]\d*$/.test(cardNumber) || isMastercard2Series(cardNumber)) {
    return 'MASTERCARD';
  }
  if (/^3[47]\d*$/.test(cardNumber)) {
    return 'AMEX';
  }
  // Discover's two best-known prefixes: the original 6011 BIN and the
  // later 65 range. (Like Mastercard's 2-series, Discover also carries a
  // numeric 622126-622925 range and a 644-649 range; those are omitted
  // here for the same "not exhaustive" reason the file-level comment
  // already gives.)
  if (/^(6011|65)\d*$/.test(cardNumber)) {
    return 'DISCOVER';
  }
  return 'UNKNOWN';
}

// Mastercard's 2016 range extension added BINs 222100-272099 (a 4-digit
// prefix of 2221-2720) alongside the original 51-55 range, to keep up with
// demand for new BINs. A plain character-class regex can't express that
// numeric range, so the prefix is parsed and compared directly.
function isMastercard2Series(cardNumber: string): boolean {
  if (cardNumber.length < 4) {
    return false;
  }
  const prefix = Number(cardNumber.slice(0, 4));
  return Number.isInteger(prefix) && prefix >= 2221 && prefix <= 2720;
}

export function lastFour(cardNumber: string): string {
  return cardNumber.slice(-4);
}

// Luhn checksum (ISO/IEC 7812-1), the same mod-10 check every real card
// issuer runs before a number ever reaches a processor. It catches the
// common case this platform can actually prevent — a transposed or mistyped
// digit — before the number is "tokenized" and the raw digits are gone for
// good; it says nothing about whether the account itself is live.
export function isValidLuhn(cardNumber: string): boolean {
  let sum = 0;
  let alternate = false;
  for (let i = cardNumber.length - 1; i >= 0; i--) {
    let digit = cardNumber.charCodeAt(i) - 48;
    if (digit < 0 || digit > 9) {
      return false;
    }
    if (alternate) {
      digit *= 2;
      if (digit > 9) {
        digit -= 9;
      }
    }
    sum += digit;
    alternate = !alternate;
  }
  return sum % 10 === 0;
}

// True once the card's expiration has passed as of `now`, using the
// standard convention that a card is valid through the LAST instant of its
// expiry month (e.g. a card expiring 03/2026 is still usable throughout
// March 2026, and expires the moment April begins).
export function isCardExpired(expMonth: number, expYear: number, now: Date = new Date()): boolean {
  const firstInstantAfterExpiry = new Date(Date.UTC(expYear, expMonth, 1));
  return now.getTime() >= firstInstantAfterExpiry.getTime();
}
