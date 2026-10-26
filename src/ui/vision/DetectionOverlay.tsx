import { footPoint, type FloorTable, type Seen, type ZoneSpec } from '../../domain/tables.ts';

/**
 * What detection sees, drawn over the large camera view on #vision (SCRUM-175): each table's zone
 * filled in its state colour (no camera: grey), every person box with its score, and the foot
 * point that decides whether they sit at a table. Boxes come from the camera worker through the
 * shop server, only while this view is open; nothing here is kept. The SVG lays itself over the
 * picture the way the picture fits its frame (contain), in the picture's own proportions.
 */
const WIDTH = 1000;
const STATE_WORD: Record<FloorTable['state'], string> = { free: 'free', occupied: 'occupied', needs_cleaning: 'needs cleaning', reserved: 'reserved' };

export function DetectionOverlay({ zones, tables, seen, aspect = 16 / 9 }: {
  zones: readonly ZoneSpec[];
  tables: readonly FloorTable[];
  seen: Seen | undefined;
  /** The picture's width / height. */
  aspect?: number;
}) {
  const w = WIDTH, h = WIDTH / aspect;
  const byId = new Map(tables.map((t) => [t.id, t]));
  const people = seen?.persons ?? [];
  const tableWords = zones.map((z) => {
    const t = byId.get(z.tableId);
    return `Table ${t?.label ?? z.tableId} ${t ? (t.noCamera ? 'no camera' : STATE_WORD[t.state]) : 'unknown'}`;
  });
  const label = [`Detection: ${people.length} ${people.length === 1 ? 'person' : 'people'}`, ...tableWords].join('. ');
  return (
    <svg className="overlay" viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="xMidYMid meet" role="img" aria-label={label}>
      {zones.map((z) => {
        const t = byId.get(z.tableId);
        const tone = !t || t.noCamera ? 'nocam' : t.state;
        const x = z.points.reduce((s, p) => s + p.x, 0) / z.points.length;
        const top = Math.min(...z.points.map((p) => p.y));
        return (
          <g key={z.id} className={`overlay__zone overlay__zone--${tone}`} data-table={z.tableId}>
            <polygon points={z.points.map((p) => `${p.x * w},${p.y * h}`).join(' ')} />
            <text x={x * w} y={top * h + 30} textAnchor="middle">Table {t?.label ?? z.tableId}</text>
          </g>
        );
      })}
      {people.map((p, i) => {
        const foot = footPoint(p);
        return (
          <g key={i} className="overlay__person">
            <rect x={p.x1 * w} y={p.y1 * h} width={(p.x2 - p.x1) * w} height={(p.y2 - p.y1) * h} />
            <text x={p.x1 * w + 4} y={Math.max(18, p.y1 * h - 6)}>{Math.round(p.score * 100)}%</text>
            <circle cx={foot.x * w} cy={foot.y * h} r={7} />
          </g>
        );
      })}
    </svg>
  );
}

/** "Last checked N s ago": how old the detection is, growing while the motion gate reuses it. */
export const checkedLine = (seen: Seen | undefined, now: number): string => {
  if (!seen) return 'Not checked yet: detection runs in Shadow and Live.';
  const s = Math.max(0, Math.round((now - seen.detectedAt) / 1000));
  const n = seen.persons.length;
  return `Last checked ${s} s ago · ${n} ${n === 1 ? 'person' : 'people'}`;
};
