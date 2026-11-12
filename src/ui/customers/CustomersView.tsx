import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import type { Customer } from '../../domain/customers.ts';
import { modulesFromEvents } from '../../domain/modules.ts';
import { crmClient } from '../../services/crmClient.ts';
import { useShopEvents } from '../../services/ownerData.ts';
import { signedIn, subscribeAuth } from '../../services/serverAuth.ts';
import { OwnerNav } from '../OwnerNav.tsx';
import { CampaignsPanel } from './CampaignsPanel.tsx';
import { CustomerList } from './CustomerList.tsx';
import { CustomerProfile } from './CustomerProfile.tsx';
import { ImportPanel } from './ImportPanel.tsx';

/**
 * Customers (CRM), on the shop PC, for managers and the owner, only while the developers have the
 * module on (modules.ts). Three tabs: the list (numbers at the top, segments, search; a tap opens a
 * customer), Import (the owner's spreadsheet), Campaigns (push messages, the owner's).
 * Who a customer is comes from the shop server; what they bought from the events, folded here.
 */
export type CustomersPlace = { at: 'list' } | { at: 'import' } | { at: 'campaigns' } | { at: 'customer'; id: string };

export const placeOf = (hash: string): CustomersPlace => {
  if (hash === '#customers/import') return { at: 'import' };
  if (hash === '#customers/campaigns') return { at: 'campaigns' };
  const m = /^#customers\/c\/(cus-[0-9a-f]{16})$/.exec(hash);
  return m ? { at: 'customer', id: m[1] } : { at: 'list' };
};

const TABS = [
  { at: 'list', label: 'Customers', href: '#customers' },
  { at: 'import', label: 'Import', href: '#customers/import' },
  { at: 'campaigns', label: 'Campaigns', href: '#customers/campaigns' },
] as const;

export interface CrmData { customers: Customer[]; withApp: Set<string> }

/** A change just made, said once, with its Undo while it shows. */
export interface Notice { message: string; undo?: () => Promise<void> }
const NOTICE_MS = 8_000;

export default function CustomersView({ hash, onRegister }: { hash: string; onRegister: () => void }) {
  const place = placeOf(hash);
  const shop = useShopEvents();
  const events = shop.state === 'loading' ? null : shop.events ?? [];
  const at = shop.state === 'ready' ? shop.at : Date.now();
  const on = events === null ? null : modulesFromEvents(events).crm;
  const role = useSyncExternalStore(subscribeAuth, () => signedIn()?.role ?? null);
  const [data, setData] = useState<CrmData | null>(null);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState<Notice | null>(null);
  const scroller = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!notice) return;
    // The notice (and its Undo) is at the top: bring it into sight, wherever the list was scrolled.
    scroller.current?.scrollTo?.({ top: 0, behavior: 'smooth' });
    const t = setTimeout(() => setNotice(null), NOTICE_MS);
    return () => clearTimeout(t);
  }, [notice]);

  const load = useCallback(async () => {
    try {
      const r = await crmClient.list();
      setData({ customers: r.customers, withApp: new Set(r.withApp) });
      setError('');
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
  }, []);
  useEffect(() => { if (on) void load(); }, [on, load]);

  if (on === false) {
    return (
      <div className="inv-page">
        <OwnerNav current="customers" onRegister={onRegister} />
        <div className="inv-page__head"><h1 className="supplier-heading">Customers</h1></div>
        <p className="crm__lead crm__pad">Customers are not on for this shop.</p>
      </div>
    );
  }

  const tab = place.at === 'customer' ? 'list' : place.at;
  return (
    <div className="inv-page">
      <OwnerNav current="customers" onRegister={onRegister} />
      <div className="inv-page__head">
        <h1 className="supplier-heading">Customers</h1>
        <nav className="cats" aria-label="Customers">
          {TABS.map((t) => <a key={t.at} className="pill" href={t.href} aria-pressed={tab === t.at}>{t.label}</a>)}
        </nav>
      </div>
      <div className="inv-scroll" ref={scroller}>
        <div className="crm__pad">
          {error && <p className="setup__error" role="alert">{error}</p>}
          {notice && (
            <div className="inv-notice" role="status">
              {notice.message}
              {notice.undo && <button type="button" onClick={() => { const u = notice.undo!; setNotice(null); void u().then(load, (e: unknown) => setError(e instanceof Error ? e.message : String(e))); }}>Undo</button>}
            </div>
          )}
          {place.at === 'list' && <CustomerList data={data} events={events ?? []} now={at} onAdded={async (n) => { await load(); setNotice(n); }} />}
          {place.at === 'customer' && (
            <CustomerProfile id={place.id} data={data} events={events ?? []} now={at} isOwner={role === 'owner'} onChanged={load}
              onRemoved={async (n) => { await load(); setNotice(n); location.hash = '#customers'; }} />
          )}
          {place.at === 'import' && <ImportPanel count={data?.customers.length ?? null} onSaved={load} />}
          {place.at === 'campaigns' && <CampaignsPanel isOwner={role === 'owner'} data={data} events={events ?? []} now={at} />}
        </div>
      </div>
    </div>
  );
}
