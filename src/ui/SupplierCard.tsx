import { useState } from 'react';
import type { SupplierSummary } from '../domain/inventory.ts';
import { whatsAppNumber } from '../domain/ordering.ts';


export function SupplierCard({
  summary,
  onEdit,
  onArchive,
}: {
  summary: SupplierSummary;
  onEdit: (supplierId: string) => void;
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
        </button>
        <button
          type="button"
          className="sup-card__edit"
          aria-label={`Edit ${supplier.name}`}
          title={`Edit ${supplier.name}`}
          onClick={() => onEdit(supplier.id)}
        >
          <svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
            <path d="M4 20h4L19 9l-4-4L4 16v4zM13.5 6.5l4 4" />
          </svg>
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
            </div>
          ))}
        </div>
      </div>
    </article>
  );
}