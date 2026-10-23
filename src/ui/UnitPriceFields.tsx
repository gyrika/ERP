import { NEW_ITEM_UNITS, newItemUnit } from '../domain/counting.ts';
import type { BaseUnit } from '../domain/inventoryData.ts';
import { parseLKR } from '../domain/money.ts';
import type { Cents } from '../domain/types.ts';

/** What a new ingredient is bought in and what one of it costs, as typed. */
export interface UnitPrice { unit: string | null; price: string }

export const EMPTY_UNIT_PRICE: UnitPrice = { unit: null, price: '' };

/** The typed unit and price as the stored item's fields, or null while either is missing or not a price above zero. */
export const unitPriceItem = ({ unit, price }: UnitPrice): { baseUnit: BaseUnit; packQty: number; workingPriceCents: Cents } | null => {
  const size = unit ? newItemUnit(unit) : null;
  const cents = parseLKR(price);
  return size && cents !== null && cents > 0 ? { ...size, workingPriceCents: cents } : null;
};

/** Unit chips, then "Price per kg". `name` labels them when several ingredients share a form. */
export function UnitPriceFields({ value, onChange, name }: { value: UnitPrice; onChange: (next: UnitPrice) => void; name?: string }) {
  const label = (text: string) => (name ? `${name} ${text.toLowerCase()}` : text);
  const typed = value.price.trim();
  const bad = typed !== '' && !((parseLKR(typed) ?? 0) > 0);
  return (
    <>
      <div className="inv-modal__field">
        <span>{label('Unit')}</span>
        <div className="inv-units" role="group" aria-label={label('Unit')}>
          {NEW_ITEM_UNITS.map((u) => (
            <button key={u.id} type="button" className="chip" aria-pressed={value.unit === u.id} onClick={() => onChange({ ...value, unit: u.id })}>{u.label}</button>
          ))}
        </div>
      </div>
      <label className="inv-modal__field">
        <span>{label(`Price per ${value.unit ?? 'unit'}`)}</span>
        <input className="inv-modal__input" inputMode="decimal" autoComplete="off" placeholder="Rs" value={value.price}
          aria-invalid={bad} onChange={(event) => onChange({ ...value, price: event.target.value })} />
      </label>
    </>
  );
}
