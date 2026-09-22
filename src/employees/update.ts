import type { Employee } from '../model/employee';
import { validDate } from '../imports/validation';

export const EDITABLE_FIELDS = [
  'first_name', 'last_name', 'email', 'phone', 'department', 'role',
  'salary', 'status', 'country', 'joining_date', 'currency',
] as const satisfies readonly (keyof Employee)[];

export type EmployeeUpdate = Partial<Pick<Employee, (typeof EDITABLE_FIELDS)[number]>> & {
  reason?: string;
  expected_last_updated_date?: string;
};

export class EmployeeUpdateError extends Error {
  constructor(public readonly status: number, message: string) {
    super(message);
  }
}

export function parseEmployeeUpdate(body: unknown): EmployeeUpdate {
  const invalid = (message: string): never => { throw new EmployeeUpdateError(400, message); };
  if (!body || typeof body !== 'object' || Array.isArray(body))
    return invalid('A JSON object is required.');
  const values = body as Record<string, unknown>;
  const allowed = new Set<string>([...EDITABLE_FIELDS, 'reason', 'expected_last_updated_date']);
  if (Object.keys(values).some((key) => !allowed.has(key)))
    return invalid('Only employee details, reason, and expected_last_updated_date can be supplied. Employee ID and update metadata are read-only.');
  if (!EDITABLE_FIELDS.some((field) => Object.hasOwn(values, field)))
    return invalid('Supply at least one employee detail to update.');
  if (typeof values.expected_last_updated_date !== 'string' ||
      values.expected_last_updated_date.length > 40 || !validDate(values.expected_last_updated_date))
    return invalid('expected_last_updated_date must be the timestamp returned by the employee details API.');

  const input: EmployeeUpdate = { expected_last_updated_date: values.expected_last_updated_date };
  for (const field of EDITABLE_FIELDS) {
    if (!Object.hasOwn(values, field)) continue;
    const raw = values[field];
    if (field === 'salary') {
      if (typeof raw !== 'number' || !Number.isFinite(raw) || raw < 0 ||
          raw > Number.MAX_SAFE_INTEGER / 100 || Number(raw.toFixed(2)) !== raw)
        return invalid('Salary must be a non-negative number with at most two decimal places.');
      input.salary = raw;
    } else {
      if (typeof raw !== 'string' || !raw.trim() || raw.trim().length > 255 || /[\u0000-\u001f\u007f]/.test(raw))
        return invalid(`${field.replaceAll('_', ' ')} must be non-empty text of at most 255 characters without control characters.`);
      input[field] = raw.trim();
    }
  }
  if (input.email !== undefined && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(input.email))
    return invalid('Use a valid email address.');
  if (input.phone !== undefined) {
    const digits = input.phone.replace(/\D/g, '');
    if (!/^\+?[\d ()-]+$/.test(input.phone) || digits.length < 7 || digits.length > 15)
      return invalid('Phone must contain 7–15 digits, with an optional leading +, spaces, parentheses, or hyphens.');
  }
  if (input.joining_date !== undefined && !validDate(input.joining_date))
    return invalid('Joining date must be a real YYYY-MM-DD date or ISO timestamp with timezone.');
  if (input.currency !== undefined && !Intl.supportedValuesOf('currency').includes(input.currency))
    return invalid('Currency must be an uppercase ISO 4217 currency code, such as INR or USD.');
  if (values.reason !== undefined) {
    if (typeof values.reason !== 'string' || !values.reason.trim() || values.reason.length > 500 || /[\u0000-\u001f\u007f]/.test(values.reason))
      return invalid('Reason must be 1–500 characters without control characters.');
    input.reason = values.reason.trim();
  }
  return input;
}
