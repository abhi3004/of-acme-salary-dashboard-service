export interface Employee {
    id: string;
    first_name: string;
    last_name: string;
    email: string;
    phone: string;
    department: string;
    role: string;
    salary: number;
    status: string;
    country: string;
    joining_date: string;
    currency: string;
    last_updated_date: string;
    last_updated_by: string;
}

export let employees: Employee[] = [];
