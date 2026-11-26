import { useId, useRef, useState, type FormEvent } from 'react';
import {
  validateEmployee,
  type EmployeeInput,
  type EmployeeErrors,
} from '../../domain/employees.ts';
import './hr.css';

interface Props {
  initial?: EmployeeInput;
  onSave: (employee: EmployeeInput) => Promise<void>;
  onCancel: () => void;
}

const EMPTY: EmployeeInput = {
  employeeNumber: '',
  name: '',
  email: '',
  phone: '',
  department: '',
  jobTitle: '',
  joinedOn: '',
  active: true,
};

const GROUPS = [
  {
    title: 'Personal details',
    fields: [
      { key: 'name', label: 'Full name', type: 'text', required: true, max: 100 },
      { key: 'email', label: 'Email', type: 'email', required: false, max: 150 },
      { key: 'phone', label: 'Phone', type: 'tel', required: false, max: 30 },
    ],
  },
  {
    title: 'Employment details',
    fields: [
      { key: 'employeeNumber', label: 'Employee number', type: 'text', required: true, max: 30 },
      { key: 'department', label: 'Department', type: 'text', required: true, max: 80 },
      { key: 'jobTitle', label: 'Job title', type: 'text', required: true, max: 80 },
      { key: 'joinedOn', label: 'Joining date', type: 'date', required: true, max: 10 },
    ],
  },
] as const;

export function EmployeeForm({ initial, onSave, onCancel }: Props) {
  const prefix = useId();
  const saving = useRef(false);

  const [value, setValue] = useState<EmployeeInput>(
    () => ({ ...(initial ?? EMPTY) }),
  );
  const [errors, setErrors] = useState<EmployeeErrors>({});
  const [failure, setFailure] = useState('');
  const [busy, setBusy] = useState(false);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (saving.current) return;

    const clean = { ...value };

    for (const group of GROUPS) {
      for (const field of group.fields) {
        clean[field.key] = clean[field.key].trim();
      }
    }

    const nextErrors = validateEmployee(clean);
    setErrors(nextErrors);
    setFailure('');

    const first = Object.keys(nextErrors)[0];

    if (first) {
      const input = event.currentTarget.elements.namedItem(first);
      (input as HTMLInputElement | null)?.focus();
      return;
    }

    saving.current = true;
    setBusy(true);

    try {
      await onSave(clean);
    } catch (error) {
      setFailure(
        error instanceof Error
          ? error.message
          : 'Could not save. Please try again.',
      );
    } finally {
      saving.current = false;
      setBusy(false);
    }
  }

  return (
    <form
      className="hr-form"
      aria-label={initial ? 'Edit employee' : 'Add employee'}
      noValidate
      onSubmit={submit}
    >
      <p>
        Fields marked * are required. Email and phone are optional.
      </p>

      {failure && (
        <p role="alert" className="hr-form__error">
          {failure}
        </p>
      )}

      {GROUPS.map(group => (
        <fieldset key={group.title} disabled={busy}>
          <legend>{group.title}</legend>

          <div className="hr-form__grid">
            {group.fields.map(field => {
              const id = `${prefix}-${field.key}`;

              return (
                <div key={field.key} className="hr-form__field">
                  <label htmlFor={id}>
                    {field.label}{field.required ? ' *' : ''}
                  </label>

                  <input
                    id={id}
                    name={field.key}
                    type={field.type}
                    required={field.required}
                    maxLength={field.max}
                    value={value[field.key]}
                    aria-invalid={Boolean(errors[field.key])}
                    aria-describedby={
                      errors[field.key] ? `${id}-error` : undefined
                    }
                    onChange={event => {
                      setValue({
                        ...value,
                        [field.key]: event.target.value,
                      });
                      setErrors({
                        ...errors,
                        [field.key]: undefined,
                      });
                    }}
                  />

                  {errors[field.key] && (
                    <span
                      id={`${id}-error`}
                      className="hr-form__error"
                    >
                      {errors[field.key]}
                    </span>
                  )}
                </div>
              );
            })}
          </div>
        </fieldset>
      ))}

      <div className="hr-form__actions">
        <button
          type="button"
          className="inv-page__secondary"
          disabled={busy}
          onClick={onCancel}
        >
          Cancel
        </button>

        <button
          type="submit"
          className="inv-page__primary"
          disabled={busy}
        >
          {busy ? 'Saving…' : 'Save employee'}
        </button>
      </div>
    </form>
  );
}