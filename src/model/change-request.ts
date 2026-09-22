import type { EmployeeUpdate } from '../employees/update';

export type ChangeRequestStatus = 'pending' | 'approved' | 'rejected';

export interface ChangeRequest {
  id: string;
  employee_id: string;
  requested_by: string;
  approved_by: string | null;
  reason: string | null;
  changes_json: string;
  expected_last_updated_date: string;
  filename: string;
  status: ChangeRequestStatus;
  error: string | null;
  created_at: string;
  reviewed_at: string | null;
}

export type RequestedChanges = Omit<EmployeeUpdate, 'expected_last_updated_date' | 'reason'>;
