export interface SalaryChange {
  id: number;
  employee_id: string;
  action: 'import' | 'salary_update';
  old_salary: number | null;
  new_salary: number;
  old_currency: string | null;
  new_currency: string;
  previous_updated_at: string | null;
  previous_updated_by: string | null;
  changed_at: string;
  changed_by: string;
  reason: string | null;
  import_id: string | null;
}

export interface SalaryUpdate {
  salary: number;
  currency?: string;
  reason?: string;
  expected_last_updated_date?: string;
}
