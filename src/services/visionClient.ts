import type { SyncEvent } from '../domain/sync.ts';
import type { VisionSettings } from '../domain/tables.ts';
import { FAKE_CV_STATUS, FAKE_SHOP_ID, FAKE_STAFF } from '../fake/data.ts';
import { addEvents } from '../ui/eventLog.ts';
import { isDemo } from '../ui/storage.ts';
import { cameraClient, setupClient, type CvStatus } from './setupClient.ts';

/**
 * The Computer vision page's calls (#vision, SCRUM-174). On the shop PC they go to the shop
 * server with the owner's PIN, like #cameras: it checks the PIN and records the owner's
 * `vision.settings_set` (server/setup.ts). The demo has no shop server: the pack is there and the
 * change is recorded in this browser as the demo owner.
 */
export interface VisionClient {
  /** The owner's PIN is asked before the first change. */
  needsPin: boolean;
  status(pin: string): Promise<CvStatus>;
  activate(pin: string): Promise<CvStatus>;
  /** Records the settings; returns the event, already in this device's log. */
  save(pin: string, s: VisionSettings): Promise<SyncEvent[]>;
}

const shopServer: VisionClient = {
  needsPin: true,
  status: (pin) => setupClient.cvStatus(pin),
  activate: (pin) => setupClient.cvActivate(pin),
  async save(pin, s) {
    const { events } = await cameraClient.saveSettings(pin, s);
    addEvents(events);
    return events;
  },
};

const demo: VisionClient = {
  needsPin: false,
  status: async () => FAKE_CV_STATUS,
  activate: async () => FAKE_CV_STATUS,
  async save(_pin, s) {
    const owner = FAKE_STAFF.find((f) => f.actor.role === 'owner')!.actor;
    const event = {
      id: crypto.randomUUID(), shopId: FAKE_SHOP_ID, at: Date.now(), actor: owner, orderNumber: 0 as const, type: 'vision.settings_set' as const, ...s,
    };
    addEvents([event]);
    return [event];
  },
};

export const visionClient = (): VisionClient => (isDemo() ? demo : shopServer);
