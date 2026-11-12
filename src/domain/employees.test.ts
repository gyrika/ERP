import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  validateEmployee,
  type EmployeeInput,
} from './employees.ts';

const validEmployee: EmployeeInput = {
  employeeNumber: 'EMP-001',
  name: 'Test Employee',
  email: 'employee@example.com',
  phone: '0771234567',
  department: 'Kitchen',
  jobTitle: 'Cook',
  joinedOn: '2026-11-12',
  active: true,
};

test('accepts valid employee details', () => {
  assert.deepEqual(validateEmployee(validEmployee), {});
});

test('allows optional contact details to be empty', () => {
  assert.deepEqual(
    validateEmployee({
      ...validEmployee,
      email: '',
      phone: '',
    }),
    {},
  );
});

test('rejects missing required details and invalid employee numbers', () => {
  const errors = validateEmployee({
    ...validEmployee,
    employeeNumber: 'EMP 001',
    name: '   ',
    department: '',
    jobTitle: '',
  });

  assert.ok(errors.employeeNumber);
  assert.ok(errors.name);
  assert.ok(errors.department);
  assert.ok(errors.jobTitle);
});

test('rejects invalid contact details', () => {
  const errors = validateEmployee({
    ...validEmployee,
    email: 'invalid-email',
    phone: 'abcdefg',
  });

  assert.ok(errors.email);
  assert.ok(errors.phone);
});

test('rejects impossible dates and accepts a real leap day', () => {
  for (const joinedOn of ['', '2026-13-01', '2026-02-29']) {
    assert.ok(
      validateEmployee({ ...validEmployee, joinedOn }).joinedOn,
    );
  }

  assert.deepEqual(
    validateEmployee({
      ...validEmployee,
      joinedOn: '2028-02-29',
    }),
    {},
  );
});