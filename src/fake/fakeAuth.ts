import type { AuthService } from '../domain/auth.ts';
import { canManage } from '../domain/auth.ts';
import { FAKE_SHOP_ID, FAKE_STAFF } from './data.ts';

/** Stand-in AuthService over the fake staff list. Replace with the real one in sprint 3. */
export const fakeAuth: AuthService = {
  shopId: () => FAKE_SHOP_ID,
  currentCashier: () => FAKE_STAFF.find((s) => s.actor.role === 'cashier')!.actor,
  async verifyManagerPin(pin) {
    const actor = FAKE_STAFF.find((s) => s.pin === pin)?.actor;
    return actor && canManage(actor) ? actor : null;
  },
};
