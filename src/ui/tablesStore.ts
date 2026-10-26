import { useEffect, useState } from 'react';
import { tablesFromEvents, visionFromEvents, type VisionSettings, type FloorTable, type TableState } from '../domain/tables.ts';
import { currentCashier } from '../services/auth.ts';
import { appendEvent, readAll, subscribeEvents } from './eventLog.ts';

/**
 * The floor is not stored: it is folded from the event log (`tablesFromEvents`), like the
 * kitchen tickets, so a camera's change, another tab's or the server's shows up the same way.
 */
export interface Floor { tables: FloorTable[]; settings: VisionSettings }

export const readFloor = (): Floor => {
  const events = readAll();
  return { tables: tablesFromEvents(events), settings: visionFromEvents(events).settings };
};

/** No layout yet (the setup screen is SCRUM-171): no chip, no floor. */
export const hasFloor = (): boolean => readFloor().tables.length > 0;

export function useFloor(): Floor {
  const [floor, setFloor] = useState(readFloor);
  useEffect(() => subscribeEvents(() => setFloor(readFloor())), []);
  return floor;
}

/** Staff set a table (C, R, F, O). Returns the event's id, for its Undo. */
export const setTable = (table: Pick<FloorTable, 'id' | 'state'>, to: TableState): string =>
  appendEvent({ type: 'table.state_set', at: Date.now(), orderNumber: 0, actor: currentCashier(), tableId: table.id, from: table.state, to }).id;

export const undoTable = (tableId: string, undoneEventId: string): void => {
  appendEvent({ type: 'table.state_set_undone', at: Date.now(), orderNumber: 0, actor: currentCashier(), tableId, undoneEventId });
};
