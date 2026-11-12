export interface Employee {
  id: string;
  employeeNumber: string;
  name: string;
  email: string;
  phone: string;
  department: string;
  jobTitle: string;
  joinedOn: string;
  active: boolean;
}

export type EmployeeInput = Omit<Employee, 'id'>;

export type EmployeeErrors =
  Partial<Record<keyof EmployeeInput, string>>;

export function validateEmployee(
  employee: EmployeeInput,
): EmployeeErrors {
  const errors: EmployeeErrors = {};

  if (!/^[A-Za-z0-9_-]{1,30}$/.test(employee.employeeNumber)) {
    errors.employeeNumber =
      'Use 1–30 letters, numbers, hyphens or underscores.';
  }

  if (!employee.name.trim() || employee.name.length > 100) {
    errors.name = 'Enter a full name within 100 characters.';
  }

  if (!employee.department.trim() || employee.department.length > 80) {
    errors.department = 'Enter a department within 80 characters.';
  }

  if (!employee.jobTitle.trim() || employee.jobTitle.length > 80) {
    errors.jobTitle = 'Enter a job title within 80 characters.';
  }

  if (
    employee.email !== '' &&
    (
      employee.email.length > 150 ||
      !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(employee.email)
    )
  ) {
    errors.email = 'Enter a valid email address.';
  }

  if (
    employee.phone !== '' &&
    !/^[+\d ()-]{7,30}$/.test(employee.phone)
  ) {
    errors.phone = 'Enter a valid phone number.';
  }

  const date = new Date(`${employee.joinedOn}T00:00:00Z`);

  if (
    !/^\d{4}-\d{2}-\d{2}$/.test(employee.joinedOn) ||
    !Number.isFinite(date.getTime()) ||
    date.toISOString().slice(0, 10) !== employee.joinedOn
  ) {
    errors.joinedOn = 'Choose a valid joining date.';
  }

  return errors;
}