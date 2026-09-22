import { PDFParse } from 'pdf-parse';
import { EDITABLE_FIELDS, parseEmployeeUpdate } from '../employees/update';
import type { Store } from '../database/store';

const LABELS = Object.fromEntries(EDITABLE_FIELDS.map((field) => [field.replaceAll('_', ' '), field]));

function field(text: string, name: string): string | undefined {
  return text.match(new RegExp(`^(?:\\d+\\.\\s*)?${name}\\s*:\\s*(.+)$`, 'im'))?.[1]?.trim();
}

export async function processChangeRequest(store: Store, id: string) {
  const request = store.getChangeRequest(id);
  if (!request || request.status !== 'pending') return request;
  try {
    const parser = new PDFParse({ data: store.getChangeRequestFile(id) });
    const result = await parser.getText();
    await parser.destroy();
    const text = result.text.replace(/\r/g, '');
    if (!/EMPLOYEE CHANGE AUTHORIZATION/i.test(text)) throw new Error('The PDF title must be "Employee Change Authorization".');
    const employeeId = field(text, 'Employee ID');
    const reason = field(text, 'Reason');
    const approvedBy = field(text, 'Approved By');
    const approvalDate = field(text, 'Approval Date');
    if (employeeId !== request.employee_id) throw new Error('The Employee ID in the PDF does not match this request.');
    if (!reason || reason.length > 500) throw new Error('The PDF must contain a Reason of 1-500 characters.');
    if (!approvedBy || approvedBy.length > 255) throw new Error('The PDF must contain an Approved By signatory.');
    if (!approvalDate || Number.isNaN(Date.parse(approvalDate))) throw new Error('The PDF must contain a valid Approval Date.');

    const { __reason: requestedReason, ...requested } = JSON.parse(request.changes_json) as Record<string, unknown>;
    if (requestedReason !== undefined && reason !== requestedReason) throw new Error('The Reason in the PDF does not match the submitted reason.');
    for (const [rawLabel, key] of Object.entries(LABELS)) {
      if (!(key in requested)) continue;
      const authorized = field(text, rawLabel);
      if (authorized === undefined || authorized !== String(requested[key])) {
        throw new Error(`The PDF does not authorize the requested ${key} value.`);
      }
    }
    const input = parseEmployeeUpdate({ ...requested, reason, expected_last_updated_date: request.expected_last_updated_date });
    store.approveChangeRequest(id, input, approvedBy, reason);
  } catch (error) {
    store.rejectChangeRequest(id, error instanceof Error ? error.message : 'The proof document could not be validated.');
  }
  return store.getChangeRequest(id);
}
