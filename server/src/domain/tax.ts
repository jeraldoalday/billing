// Simple rate-table tax calculation. Not a general-purpose tax engine (no
// nexus rules, no sub-national jurisdictions, no product tax categories) —
// just a flat percentage per country, good enough for Day 5's invoicing
// engine. Rates are illustrative approximations of each country's standard
// VAT/GST rate, not legal or financial advice.
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

// Percentage rate (e.g. 20 for 20%) for a customer's tax jurisdiction. An
// unset or unrecognized country code is treated as 0% rather than an error,
// since not every customer has a country on file yet.
export function taxRateForCountry(countryCode?: string | null): number {
  if (!countryCode) {
    return 0;
  }
  return TAX_RATES_BY_COUNTRY[countryCode.toUpperCase()] ?? 0;
}

// Tax owed on `subtotal` (integer minor currency units) for a customer in
// `countryCode`, rounded to the nearest whole minor unit so an invoice's
// total is always an integer.
export function calculateTax(subtotal: number, countryCode?: string | null): number {
  const rate = taxRateForCountry(countryCode);
  return Math.round(subtotal * (rate / 100));
}
