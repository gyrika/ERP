import { afterEach, expect, test, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { EmployeeForm } from './EmployeeForm.tsx';
import type { EmployeeInput } from '../../domain/employees.ts';

afterEach(cleanup);

const employee: EmployeeInput = {
  employeeNumber: 'EMP-001',
  name: 'Test Employee',
  email: '',
  phone: '',
  department: 'Kitchen',
  jobTitle: 'Cook',
  joinedOn: '2026-11-12',
  active: true,
};

test('empty form shows validation errors and does not save', async () => {
  const user = userEvent.setup();
  const save = vi.fn().mockResolvedValue(undefined);

  render(
    <EmployeeForm onSave={save} onCancel={() => {}} />,
  );

  await user.click(
    screen.getByRole('button', { name: 'Save employee' }),
  );

  expect(save).not.toHaveBeenCalled();

  expect(
    screen.getByText('Enter a full name within 100 characters.'),
  ).toBeTruthy();

  expect(document.activeElement).toBe(
    screen.getByLabelText('Employee number *'),
  );
});

test('saves edited details and removes surrounding spaces', async () => {
  const user = userEvent.setup();
  const save = vi.fn().mockResolvedValue(undefined);

  render(
    <EmployeeForm
      initial={employee}
      onSave={save}
      onCancel={() => {}}
    />,
  );

  const nameInput = screen.getByLabelText('Full name *');

  await user.clear(nameInput);
  await user.type(nameInput, '  Updated Employee  ');

  await user.click(
    screen.getByRole('button', { name: 'Save employee' }),
  );

  expect(save).toHaveBeenCalledTimes(1);
  expect(save).toHaveBeenCalledWith({
    ...employee,
    name: 'Updated Employee',
  });
});

test('failed save keeps details and allows retry or cancel', async () => {
  const user = userEvent.setup();
  const cancel = vi.fn();
  const save = vi.fn().mockRejectedValue(
    new Error('Employee number already exists.'),
  );

  render(
    <EmployeeForm
      initial={employee}
      onSave={save}
      onCancel={cancel}
    />,
  );

  await user.click(
    screen.getByRole('button', { name: 'Save employee' }),
  );

  const alert = await screen.findByRole('alert');

  expect(alert.textContent).toBe(
    'Employee number already exists.',
  );

  const nameInput = screen.getByLabelText(
    'Full name *',
  ) as HTMLInputElement;

  expect(nameInput.value).toBe(employee.name);

  await user.click(
    screen.getByRole('button', { name: 'Save employee' }),
  );

  expect(save).toHaveBeenCalledTimes(2);

  await user.click(
    screen.getByRole('button', { name: 'Cancel' }),
  );

  expect(cancel).toHaveBeenCalledTimes(1);
});