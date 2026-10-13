import { useState } from 'react';
import type { InventoryRow } from '../services/inventoryStore.ts';
import { supplierDetails, splitSupplierName } from './supplierName.ts';
import { StatusDot } from './StatusDot.tsx';

export type SupplierSummary = {
  supplier: { id: string; name: string; phone?: string };
  status: 'out' | 'low' | 'ok';
  outCount: number;
  lowCount: number;
  primaryItems: InventoryRow[];
  needItems: InventoryRow[];
  backupItems: InventoryRow[];
};

const compactCountText = (summary: SupplierSummary): string => {
  const { outCount, lowCount } = summary;
  if (outCount > 0 && lowCount > 0) return `${outCount} out, ${lowCount} low`;
  if (outCount > 0) return `${outCount} out`;
  if (lowCount > 0) return `${lowCount} low`;
  return 'All stocked';
};

const needLine = (summary: SupplierSummary): string => {
  if (summary.needItems.length === 0) return 'Nothing to order';
  const visible = summary.needItems.slice(0, 2).map((item) => item.name);
  const more = summary.needItems.length - visible.length;
  return more > 0 ? `${visible.join(', ')}, +${more}` : visible.join(', ');
};

export function SupplierCard({ summary, variant }: { summary: SupplierSummary; variant: 'restock' | 'directory' }) {
  const { supplier } = summary;
  const { title, detail } = splitSupplierName(supplier.name);
  const { type, location } = supplierDetails(detail, supplier.name);
  const [expanded, setExpanded] = useState(false);

  const titleColor = summary.status === 'ok' ? 'var(--ink-2)' : 'var(--ink)';

  return (
    <article className={`sup-card sup-card--${summary.status} sup-card--${variant}`}>
      <button
        type="button"
        className="sup-card__header"
        aria-expanded={expanded}
        onClick={() => setExpanded((value) => !value)}
      >
        <div className="sup-card__title-block">
          <StatusDot status={summary.status} size="lg" />
          <div className="sup-card__copy">
            <h2 className="sup-card__title" style={{ color: titleColor }}>{title}</h2>
            {location && <span className="sup-card__sub">{location}</span>}
            {type && <span className="sup-card__meta">{type}</span>}
          </div>
        </div>
        <span className="sup-card__toggle" aria-hidden="true">{expanded ? '−' : '+'}</span>
      </button>

      <div className="sup-card__body">
        <div className="sup-card__summary-line">{compactCountText(summary)}</div>
        <div className="sup-card__need-line" title={summary.needItems.map((item) => item.name).join(', ')}>
          {needLine(summary)}
        </div>

        {variant === 'directory' && (
          <dl className="supplier-card__stats">
            <div>
              <dt>Primary items</dt>
              <dd>{summary.primaryItems.length}</dd>
            </div>
            <div>
              <dt>Backup items</dt>
              <dd>{summary.backupItems.length}</dd>
            </div>
          </dl>
        )}

        {supplier.phone ? (
          <div className="sup-card__actions">
            <a
              className="insight__action sup-card__action"
              aria-label={`Call ${title}`}
              href={`tel:${supplier.phone}`}
            >
              Call
            </a>
            <a
              className="insight__action sup-card__action"
              aria-label={`WhatsApp ${title}`}
              href={`https://wa.me/${supplier.phone.replace(/[^0-9]/g, '')}`}
              target="_blank"
              rel="noopener noreferrer"
            >
              WhatsApp
            </a>
          </div>
        ) : (
          <p className="supplier-card__contact">No phone on file</p>
        )}
      </div>

      {expanded && (
        <div className="sup-card__expand">
          {summary.primaryItems.length > 0 && (
            <div className="sup-card__items" aria-label={`Primary items for ${title}`}>
              {summary.primaryItems.map((item) => (
                <div key={item.id} className="sup-card__item">
                  <div className="sup-card__item-main">
                    <StatusDot status={item.onHandPacks === 0 ? 'out' : item.onHandPacks === 1 ? 'low' : 'ok'} />
                    <span>{item.name}</span>
                  </div>
                  <span className="sup-card__item-count">{item.onHandPacks}</span>
                </div>
              ))}
            </div>
          )}
          {summary.backupItems.length > 0 && (
            <div className="sup-card__backup">
              Backup for: {summary.backupItems.map((item) => item.name).slice(0, 2).join(', ')}
              {summary.backupItems.length > 2 ? ` +${summary.backupItems.length - 2}` : ''}
            </div>
          )}
        </div>
      )}
    </article>
  );
}
