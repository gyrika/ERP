import type { BaseUnit } from './inventoryData.ts';

/** "12.4 kg", "750 ml", "6 pcs": base units, scaled up from 1000 g / 1000 ml. */
export const formatQuantity = (quantity: number, unit: BaseUnit): string => {
  const scaled = unit === 'g' && Math.abs(quantity) >= 1000
    ? { value: quantity / 1000, unit: 'kg' }
    : unit === 'ml' && Math.abs(quantity) >= 1000
      ? { value: quantity / 1000, unit: 'L' }
      : { value: quantity, unit };
  return `${Number(scaled.value.toFixed(2))} ${scaled.unit}`;
};
