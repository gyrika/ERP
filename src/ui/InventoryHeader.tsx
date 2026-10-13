type HeaderMode = 'inventory' | 'suppliers';

export function InventoryHeader({ active }: { active: HeaderMode }) {
  return (
    <header className="inv-page__head">
      <span className="brand">CheesyBeez</span>
      <nav className="inv-page__nav" aria-label="Inventory sections">
        <a
          className={`inv-page__link${active === 'inventory' ? ' inv-page__link--on' : ''}`}
          href="#inventory"
          aria-current={active === 'inventory' ? 'page' : undefined}
        >
          Inventory
        </a>
        <a
          className={`inv-page__link${active === 'suppliers' ? ' inv-page__link--on' : ''}`}
          href="#suppliers"
          aria-current={active === 'suppliers' ? 'page' : undefined}
        >
          Suppliers
        </a>
        <a className="inv-page__link" href="#">Register</a>
      </nav>
    </header>
  );
}
