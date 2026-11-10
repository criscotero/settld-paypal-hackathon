// Countries offered at onboarding: where Settld's first buyers and sellers are (US clients, LATAM
// engineers) plus common PayPal markets. ISO 3166-1 alpha-2, as Core API stores them; names
// come from Intl so they are never misspelled and can follow the user's language later.
export const COUNTRY_CODES = [
  "US", "CA", "MX", "CO", "AR", "BR", "CL", "PE", "EC", "UY", "CR", "GT", "PA", "DO",
  "ES", "PT", "GB", "IE", "DE", "FR", "IT", "NL", "IN", "PH", "AU",
] as const;

export function countryName(code: string, locale = "en"): string {
  return new Intl.DisplayNames([locale], { type: "region" }).of(code) ?? code;
}
