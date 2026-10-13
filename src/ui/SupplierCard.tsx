import { useState } from 'react';
import { StatusDot } from './StatusDot.tsx';
import { stockStatus } from '../domain/inventory.ts';
import type { SupplierSummary } from '../domain/inventory.ts';

/** WhatsApp links need the country code: 077 123 4567 becomes 94771234567. */
const whatsAppNumber = (phone: string): string => {
  const digits = phone.replace(/\D/g, '');
  return digits.length === 10 && digits.startsWith('0') ? `94${digits.slice(1)}` : digits;
};

export function SupplierCard({
  summary,
  onArchive,
}: {
  summary: SupplierSummary;
  onArchive: (supplierId: string) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const { supplier } = summary;

  return (
    <article className={`sup-card supplier-card${expanded ? ' supplier-card--expanded' : ''}`}>
      <div className="sup-card__header">
        <button
          className="sup-card__expand-toggle"
          onClick={() => setExpanded(!expanded)}
          aria-label={`${expanded ? 'Collapse' : 'Expand'} ${supplier.name}`}
          aria-expanded={expanded}
          aria-controls={`supplier-${supplier.id}-details`}
        >
          <div className="sup-card__title-block">
            <h3 className="sup-card__title">{supplier.name}</h3>
          </div>
          <StatusDot status={summary.status} />
          <span className="sup-card__toggle">{expanded ? '−' : '+'}</span>
        </button>
        <button
          type="button"
          className="sup-card__remove"
          aria-label={`Remove ${supplier.name}`}
          title={`Remove ${supplier.name}`}
          onClick={() => onArchive(supplier.id)}
        >
          <svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
            <path d="M4 7h16M10 11v6m4-6v6M5 7l1 13h12l1-13M9 7V4h6v3" />
          </svg>
        </button>
      </div>

      <div
        className="sup-card__expand"
        id={`supplier-${supplier.id}-details`}
        hidden={!expanded}
      >
        {supplier.phone ? (
          <div className="sup-card__actions">
            <a href={`tel:${supplier.phone}`} className="restock-action">
              Call
            </a>
            <a
              href={`https://wa.me/${whatsAppNumber(supplier.phone)}`}
              className="restock-action restock-action--wa"
              target="_blank"
              rel="noopener noreferrer"
            >
              WhatsApp
            </a>
          </div>
        ) : (
          <p className="supplier-card__contact">No phone on file</p>
        )}

        <div className="sup-card__items">
          {summary.suppliedItems.map((item) => (
            <div key={item.id} className="sup-card__item">
              <div className="sup-card__item-main">
                <span>{item.name}</span>
              </div>
              <StatusDot status={stockStatus(item)} />
            </div>
          ))}
        </div>
      </div>
    </article>
  );
}