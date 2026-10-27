/**
 * Filters that combine (SCRUM-187), as Visual Flow and Raw materials use them: each chip is
 * `group:value` ("status:low", "kind:raw", "wh:wh-2"). Within a group any picked one will do
 * (Low or Out); across groups all must hold (Low, and in Warehouse 2). Nothing picked: everything.
 */
export type Picked = ReadonlySet<string>;

export const groupOf = (chip: string): string => chip.slice(0, chip.indexOf(':'));

/** Turns one chip on or off; the others stay as they are. */
export const toggleChip = (picked: Picked, chip: string): Set<string> => {
  const next = new Set(picked);
  if (next.has(chip)) next.delete(chip); else next.add(chip);
  return next;
};

/** Does a thing pass? `facts` holds what it is, by group: its status chips, its kind, its warehouses. */
export const passes = (picked: Picked, facts: Readonly<Record<string, readonly string[]>>): boolean => {
  const groups = new Map<string, string[]>();
  for (const chip of picked) {
    const g = groupOf(chip);
    groups.set(g, [...(groups.get(g) ?? []), chip.slice(g.length + 1)]);
  }
  for (const [g, wanted] of groups) {
    const has = facts[g] ?? [];
    if (!wanted.some((w) => has.includes(w))) return false;
  }
  return true;
};
