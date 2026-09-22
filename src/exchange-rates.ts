// Fixed reference snapshot for approximate reporting. No network dependency at runtime.
// Amount in target currency = amount / source units-per-EUR * target units-per-EUR.
export const EXCHANGE_RATES = {
  date: '2026-09-18',
  source: 'European Central Bank',
  source_url: 'https://www.ecb.europa.eu/stats/eurofxref/eurofxref-daily.xml',
  units_per_eur: {
    EUR: 1, USD: 1.1460, JPY: 180.94, CZK: 24.339, DKK: 7.4754, GBP: 0.85880,
    HUF: 364.28, PLN: 4.3635, RON: 5.2647, SEK: 11.2915, CHF: 0.9462,
    ISK: 139.40, NOK: 10.8095, TRY: 55.9077, AUD: 1.6095, BRL: 5.8857,
    CAD: 1.6056, CNY: 7.6755, HKD: 8.9903, IDR: 20424.81, ILS: 3.4812,
    INR: 109.8755, KRW: 1590.76, MXN: 19.6855, MYR: 4.6763, NZD: 2.0068,
    PHP: 71.972, SGD: 1.4651, THB: 38.225, ZAR: 18.6482,
  } as Record<string, number>,
};

const LOCAL_CURRENCIES: Record<string, string> = {
  india: 'INR', in: 'INR', ind: 'INR',
  'united states': 'USD', 'united states of america': 'USD', us: 'USD', usa: 'USD',
  'united kingdom': 'GBP', uk: 'GBP', gb: 'GBP', gbr: 'GBP',
  germany: 'EUR', de: 'EUR', deu: 'EUR',
  japan: 'JPY', jp: 'JPY', jpn: 'JPY',
  australia: 'AUD', au: 'AUD', aus: 'AUD',
  singapore: 'SGD', sg: 'SGD', sgp: 'SGD',
  canada: 'CAD', ca: 'CAD', can: 'CAD',
};

export function reportingCurrency(country: string | undefined, recordedCurrencies: string[]): string | null {
  if (!country) return 'USD';
  const key = country.toLowerCase();
  return Object.hasOwn(LOCAL_CURRENCIES, key) ? LOCAL_CURRENCIES[key]!
    : recordedCurrencies.length === 1 ? recordedCurrencies[0]! : null;
}

export function convertSalary(amount: number, from: string, to: string): number | null {
  if (from === to) return amount;
  const source = EXCHANGE_RATES.units_per_eur[from];
  const target = EXCHANGE_RATES.units_per_eur[to];
  return source && target ? amount / source * target : null;
}
