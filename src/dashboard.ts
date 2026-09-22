import type { Store } from './database/store';
import { convertSalary, EXCHANGE_RATES, reportingCurrency } from './exchange-rates';

type Totals = { employees: number; departments: number; countries: number };
type SalaryGroup = { currency: string; employees: number; total: number; average: number };
type DepartmentGroup = Omit<SalaryGroup, 'average'> & { department: string };
const roundMoney = (amount: number) => Math.round((amount + Number.EPSILON) * 100) / 100;

// Keep raw currency groups for diagnostics, then convert each group before adding it.
// Counts and averages cover every employee in the selected country, regardless of table pagination.
export function dashboardSummary(store: Store, country?: string) {
  const where = country ? 'WHERE country = ?' : '';
  const params = country ? [country] : [];
  const organization = store.db.prepare(`
    SELECT COUNT(*) AS employees, COUNT(DISTINCT department) AS departments,
      COUNT(DISTINCT country) AS countries
    FROM employees
  `).get() as unknown as Totals;
  const totals = country ? store.db.prepare(`SELECT COUNT(*) AS employees,
    COUNT(DISTINCT department) AS departments, COUNT(DISTINCT country) AS countries
    FROM employees ${where}`).get(...params) as unknown as Totals : organization;
  const countryOptions = store.db.prepare('SELECT DISTINCT country FROM employees ORDER BY country').all()
    .map((row) => String(row.country));
  const salaries = store.db.prepare(`
    SELECT currency, COUNT(*) AS employees, SUM(salary) AS total, AVG(salary) AS average
    FROM employees ${where} GROUP BY currency ORDER BY employees DESC, currency
  `).all(...params) as unknown as SalaryGroup[];
  const departments = store.db.prepare(`
    SELECT department, currency, COUNT(*) AS employees, SUM(salary) AS total
    FROM employees ${where} GROUP BY department, currency ORDER BY total DESC, department
  `).all(...params) as unknown as DepartmentGroup[];
  const statuses = store.db.prepare(`
    SELECT status, COUNT(*) AS employees FROM employees ${where}
    GROUP BY status ORDER BY employees DESC, status
  `).all(...params);
  const currency = reportingCurrency(country, salaries.map((group) => group.currency));
  const unavailableCurrencies = salaries.filter((group) => !currency || convertSalary(group.total, group.currency, currency) === null)
    .map((group) => group.currency);
  const available = currency !== null && unavailableCurrencies.length === 0;
  const convertedDepartments = new Map<string, { department: string; total: number; employees: number }>();
  let total = 0;
  if (available) {
    for (const group of departments) {
      const converted = convertSalary(group.total, group.currency, currency)!;
      total += converted;
      const department = convertedDepartments.get(group.department) ?? { department: group.department, total: 0, employees: 0 };
      department.total += converted;
      department.employees += group.employees;
      convertedDepartments.set(group.department, department);
    }
  }
  return { ...totals, organization, country: country ?? null, country_options: countryOptions,
    salaries, salary_by_department: departments, statuses,
    compensation: {
      currency, total: available ? roundMoney(total) : null,
      average: available && totals.employees ? roundMoney(total / totals.employees) : null,
      approximate: !country || salaries.some((group) => group.currency !== currency),
      unavailable_currencies: unavailableCurrencies,
      departments: [...convertedDepartments.values()].sort((a, b) => b.total - a.total || a.department.localeCompare(b.department))
        .map((group) => ({ ...group, total: roundMoney(group.total) })),
      exchange_rates: { date: EXCHANGE_RATES.date, source: EXCHANGE_RATES.source, source_url: EXCHANGE_RATES.source_url },
    },
  };
}
