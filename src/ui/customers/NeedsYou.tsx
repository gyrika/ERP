import type { NeedsYouCard } from '../../domain/crmPage.ts';

/** The top of Customers: up to three sentences worth the owner's minute, one tap each (crmPage.ts needsYou). */
export function NeedsYou({ cards }: { cards: NeedsYouCard[] }) {
  if (!cards.length) return null;
  return (
    <section className="crm-needs" aria-label="Needs you">
      {cards.map((c) => (
        <a key={c.id} className="crm-card crm-needs__card" href={c.go}>
          <span className="crm-needs__label"><i className={`crm-needs__tone crm-needs__tone--${c.tone}`} />{c.label}</span>
          <b className="crm-needs__title">{c.title}</b>
          <span className="crm-needs__detail">{c.detail}</span>
          <span className="crm-needs__go">{c.action} →</span>
        </a>
      ))}
    </section>
  );
}
