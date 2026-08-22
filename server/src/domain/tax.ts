// Simple rate-table tax calculation. Not a general-purpose tax engine (no
// nexus rules, no sub-national jurisdictions, no product tax categories) —
// a flat percentage per country, plus the two exceptions that change the
// answer often enough to matter for a real invoice: a customer with an
// exemption on file, and an EU business that self-accounts for VAT under
// the reverse charge. Rates are illustrative approximations of each
// country's standard VAT/GST rate, not legal or financial advice.
const TAX_RATES_BY_COUNTRY: Record<string, number> = {
  US: 0, // Sales tax varies by state/locality; not modeled here.
  CA: 5, // Federal GST; provincial PST/HST not modeled here.
  GB: 20,
  DE: 19,
  FR: 20,
  IE: 23,
  ES: 21,
  IT: 22,
  NL: 21,
  AU: 10,
  NZ: 15,
  JP: 10,
  IN: 18,
  SG: 9,
};

// EU member states, which are the only jurisdictions where the reverse
// charge below applies. GB is deliberately absent: it left the EU VAT area,
// so a UK business customer is taxed at the standard UK rate like anyone
// else.
const EU_MEMBER_STATES = new Set([
  'AT', 'BE', 'BG', 'CY', 'CZ', 'DE', 'DK', 'EE', 'ES', 'FI', 'FR', 'GR',
  'HR', 'HU', 'IE', 'IT', 'LT', 'LU', 'LV', 'MT', 'NL', 'PL', 'PT', 'RO',
  'SE', 'SI', 'SK',
]);

// Why an invoice was taxed the way it was. Recorded alongside the amount so
// a zero-tax invoice can say *which* zero it is — an exemption, a reverse
// charge, a country we hold no rate for, or simply a 0% jurisdiction.
export const TAX_TREATMENTS = ['STANDARD', 'EXEMPT', 'REVERSE_CHARGE', 'NO_JURISDICTION'] as const;
export type TaxTreatment = (typeof TAX_TREATMENTS)[number];

// Percentage rate (e.g. 20 for 20%) for a customer's tax jurisdiction. An
// unset or unrecognized country code is treated as 0% rather than an error,
// since not every customer has a country on file yet.
export function taxRateForCountry(countryCode?: string | null): number {
  if (!countryCode) {
    return 0;
  }
  return TAX_RATES_BY_COUNTRY[countryCode.toUpperCase()] ?? 0;
}

export function isEuMemberState(countryCode?: string | null): boolean {
  return countryCode ? EU_MEMBER_STATES.has(countryCode.toUpperCase()) : false;
}

// A VAT identification number always starts with the two-letter country
// code of the member state that issued it, followed by 2-12 alphanumeric
// characters. This is a shape check, not a validity check — confirming the
// number is really registered means calling the tax authority's service,
// which this platform doesn't do. A number whose prefix disagrees with the
// customer's country is rejected, since one of the two is wrong and
// guessing which would mean either over- or under-charging tax.
export function isVatIdShapeValid(taxId: string, countryCode?: string | null): boolean {
  const normalized = taxId.replace(/[\s-]/g, '').toUpperCase();
  if (!/^[A-Z]{2}[0-9A-Z]{2,12}$/.test(normalized)) {
    return false;
  }
  return countryCode ? normalized.startsWith(countryCode.toUpperCase()) : true;
}

export interface TaxableCustomer {
  country?: string | null;
  taxId?: string | null;
  taxExempt?: boolean | null;
}

export interface TaxTreatmentResult {
  treatment: TaxTreatment;
  rate: number;
}

// Which of the rules applies to a customer, and the rate that falls out of
// it. Order matters: a documented exemption beats everything, then the EU
// reverse charge, then the rate table.
//
// The reverse charge is modeled from the position of a merchant established
// outside the EU (this platform has no merchant establishment configured,
// so it can't be selling domestically into any member state). Under that
// arrangement an EU *business* — one that has given us a VAT ID matching
// its country — accounts for the VAT itself and we charge 0%, while an EU
// consumer with no VAT ID pays their own country's rate.
export function resolveTaxTreatment(customer: TaxableCustomer): TaxTreatmentResult {
  if (customer.taxExempt) {
    return { treatment: 'EXEMPT', rate: 0 };
  }

  if (!customer.country) {
    return { treatment: 'NO_JURISDICTION', rate: 0 };
  }

  if (
    isEuMemberState(customer.country) &&
    customer.taxId &&
    isVatIdShapeValid(customer.taxId, customer.country)
  ) {
    return { treatment: 'REVERSE_CHARGE', rate: 0 };
  }

  return { treatment: 'STANDARD', rate: taxRateForCountry(customer.country) };
}

// Tax owed on `taxableAmount` (integer minor currency units) for a customer
// in `countryCode`, rounded to the nearest whole minor unit so an invoice's
// total is always an integer. Kept for callers that only have a country to
// hand; anything holding a whole customer should use calculateCustomerTax
// so exemptions and the reverse charge are honoured.
export function calculateTax(taxableAmount: number, countryCode?: string | null): number {
  const rate = taxRateForCountry(countryCode);
  return Math.round(taxableAmount * (rate / 100));
}

export interface CustomerTaxResult extends TaxTreatmentResult {
  amount: number;
}

// Tax owed on `taxableAmount` by a specific customer. `taxableAmount` is
// what's left after any coupon (see src/services/invoice.service.ts): tax
// follows the price actually charged, so discounting an invoice discounts
// its tax with it.
//
// A negative taxable amount — an invoice made of proration credits — yields
// negative tax, so crediting a customer returns the tax they paid rather
// than keeping it.
export function calculateCustomerTax(taxableAmount: number, customer: TaxableCustomer): CustomerTaxResult {
  const { treatment, rate } = resolveTaxTreatment(customer);
  return { treatment, rate, amount: Math.round(taxableAmount * (rate / 100)) };
}
