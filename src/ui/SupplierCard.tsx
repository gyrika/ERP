import { useState } from 'react';
import { StatusDot } from './StatusDot.tsx';
import { stockStatus } from '../domain/inventory.ts';
import type { SupplierSummary } from '../domain/inventory.ts';

export function SupplierCard({ summary }: { summary: SupplierSummary }) {
  const [expanded, setExpanded] = useState(false);
  const { supplier } = summary;

  return (
    <article className="sup-card supplier-card">
      {/* Default State: Header with Name & Toggle */}
      <button
        className="sup-card__header"
        onClick={() => setExpanded(!expanded)}
        aria-expanded={expanded}
      >
        <div className="sup-card__title-block">
          <h3 className="sup-card__title">{supplier.name}</h3>
        </div>
        <div className="sup-card__toggle">
          {expanded ? '−' : '+'}
        </div>
      </button>

      {/* Expanded State: Contact + Color-Coded Ingredients */}
      {expanded && (
        <div className="sup-card__expand">
          {supplier.phone ? (
            <div className="sup-card__actions">
              <a href={`tel:${supplier.phone}`} className="restock-action">
                Call
              </a>
              <a
                href={`https://wa.me/${supplier.phone.replace(/[^0-9]/g, '')}`}
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
                {/* Visual alignment token pushes the status indicator to the edge */}
                <StatusDot status={stockStatus(item)} />
              </div>
            ))}
          </div>
        </div>
      )}
    </article>
  );
}