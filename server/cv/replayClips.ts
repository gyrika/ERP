// Stock clips the camera worker is replayed against (SCRUM-170), with each table's zone and the
// changes the cameras should see. The video files are not in git: `npm run cv:clips` fetches them
// from Pexels (free licence, https://www.pexels.com/license/) into test-assets/cv-clips/<name>/
// and builds each replay clip; server/cv/replay.test.ts runs them where the CV pack is (CV_PACK_DIR).
// Times are seconds of the replay clip, which the worker reads at one frame a second.
import type { TableState, ZoneSpec } from '../../src/domain/tables.ts';

export interface ReplayClip {
  name: string;
  /** What the clip shows, and why it is here. */
  what: string;
  pexels: { id: number; page: string };
  /**
   * How the replay clip is made from the download, scaled to 640x360: segments one after another,
   * each the download looped for `seconds`; `patch` is an ffmpeg filter graph on [s] (the scaled
   * frame) ending in [v], to change the scene (for example, the people leave).
   */
  segments: { seconds: number; patch?: string }[];
  timers: { seatS: number; leaveS: number };
  zones: ZoneSpec[];
  /** Every `table.state_changed` the replay must record, and no other. */
  expect: { tableId: string; from: TableState; to: TableState; atS: number }[];
}

/** A replayed change counts if it is this close to the expected time. */
export const TOLERANCE_S = 4;

const rect = (tableId: string, x1: number, y1: number, x2: number, y2: number): ZoneSpec =>
  ({ id: `zone-${tableId}`, tableId, points: [{ x: x1, y: y1 }, { x: x2, y: y1 }, { x: x2, y: y2 }, { x: x1, y: y2 }] });

export const REPLAY_CLIPS: ReplayClip[] = [
  {
    name: 'aerial-cafe',
    what: 'Camera straight above three round café tables: two people at the middle one for 40 s, then they are gone '
      + '(the empty outer tables pasted over the middle). YOLOX-Nano does not see people from straight above (best '
      + 'score 0.28), so nothing is recorded: mount cameras in a high corner, looking down at an angle. Kept to show '
      + 'that, and that empty tables never raise a change.',
    pexels: { id: 28575211, page: 'https://www.pexels.com/video/aerial-view-of-outdoor-cafe-seating-on-cobblestone-28575211/' },
    segments: [
      { seconds: 40 },
      { seconds: 40, patch: '[s]split=3[b][l][r];[l]crop=185:240:0:110[lc];[r]crop=160:240:480:110[rc];[b][lc]overlay=180:110[t];[t][rc]overlay=330:110[v]' },
    ],
    timers: { seatS: 10, leaveS: 20 },
    zones: [rect('left', 0, 0.38, 0.25, 0.82), rect('middle', 0.28, 0.33, 0.74, 0.95), rect('right', 0.76, 0.38, 1, 0.82)],
    expect: [],
  },
  {
    name: 'coffee-shop',
    what: 'Fixed camera in a small coffee shop: two people sit at a high table for 30 s; others stand at the counter '
      + 'beside it (standing near a table is not sitting at it). Then the table is covered by the empty wall from the '
      + 'same frame (synthetic: the people are gone). The floor by the wall stays empty.',
    pexels: { id: 6828710, page: 'https://www.pexels.com/video/people-in-a-coffee-shop-6828710/' },
    segments: [
      { seconds: 30 },
      { seconds: 30, patch: '[s]split[b][w];[w]crop=115:240:525:120,scale=230:240[wc];[b][wc]overlay=295:120[v]' },
    ],
    timers: { seatS: 10, leaveS: 20 },
    zones: [rect('high-table', 0.48, 0.6, 0.8, 1), rect('by-the-wall', 0.82, 0.5, 1, 1)],
    expect: [
      { tableId: 'high-table', from: 'free', to: 'occupied', atS: 10 },
      { tableId: 'high-table', from: 'occupied', to: 'needs_cleaning', atS: 48 },
    ],
  },
  {
    name: 'paris-pavement',
    what: 'A pavement café, camera at table height: a woman sits at the second table the whole time, half hidden by '
      + 'glasses in front; people keep walking past. Her table must be occupied, and stay so.',
    pexels: { id: 854750, page: 'https://www.pexels.com/video/time-lapse-video-of-people-854750/' },
    segments: [{ seconds: 50 }],
    timers: { seatS: 10, leaveS: 20 },
    zones: [rect('second-table', 0.18, 0.45, 0.4, 0.98)],
    expect: [{ tableId: 'second-table', from: 'free', to: 'occupied', atS: 10 }],
  },
];
