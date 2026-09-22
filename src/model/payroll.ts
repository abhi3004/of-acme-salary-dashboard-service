export type PayrollPeriodStatus = 'draft' | 'approved' | 'processing' | 'completed' | 'closed';
export type EmployeePayrollStatus = 'pending' | 'partially_paid' | 'paid';
export type PaymentStatus = 'pending' | 'successful' | 'failed' | 'reversed';

export interface PayrollPeriod {
  id: string; name: string; start_date: string; end_date: string; payment_due_date: string;
  status: PayrollPeriodStatus; created_at: string; approved_at: string | null; approved_by: string | null;
}

export interface EmployeePayroll {
  id: string; payroll_period_id: string; employee_id: string; salary_snapshot: number; currency: string;
  additions: number; deductions: number; carried_forward: number; net_payable: number; amount_paid: number;
  outstanding_amount: number; status: EmployeePayrollStatus; calculated_at: string; paid_at: string | null;
}
