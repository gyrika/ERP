import { useEffect, useState, type FormEvent } from 'react';
import { menuItems, menuSections, menuState } from '../domain/menu.ts';
import {
  checkSection, CUSTOM_SIZE_IDS, moveSection, NEW_SECTION_MINUTES, newSectionId, PRINTED_COOK_MINUTES, PRINTED_SECTIONS,
  type Section, type SectionSetting,
} from '../domain/sections.ts';
import { currentCashier } from '../services/auth.ts';
import { appendEvent } from './eventLog.ts';
import { useMenu } from './menuStore.ts';
import { NumberInput } from './NumberInput.tsx';

/**
 * A menu section, new or his own or printed (SCRUM-241). Serves the owner: he knows what he sells
 * and wants a place for it on the counter. The single next thing: name it, say how it is priced,
 * save. Every change is one `menu.section_set` (Undo on the Menu screen); moving is one
 * `menu.sections_ordered`, made at once with its own Undo, so he can step it along. Any section can
 * be hidden or deleted, printed ones too; a dish he wants to keep is moved first (its Change sheet).
 */

export const saveSection = (id: string, after: SectionSetting | null): SectionSetting | null => {
  const before = menuState().sections?.[id] ?? null;
  appendEvent({ type: 'menu.section_set', at: Date.now(), orderNumber: 0, actor: currentCashier(), itemId: id, before, after });
  return before;
};

const saveOrder = (after: string[]): string[] => {
  const before = menuState().sectionOrder ?? [];
  appendEvent({ type: 'menu.sections_ordered', at: Date.now(), orderNumber: 0, actor: currentCashier(), itemId: 'sections', before, after });
  return before;
};

const clean = (s: string) => s.trim();

export function SectionSheet({ section, onSaved, onClose }: {
  /** null: a new section. */
  section: Section | null;
  /** `select`: the section to show after saving (a new one). */
  onSaved: (message: string, undo: () => void, select?: string) => void;
  onClose: () => void;
}) {
  useMenu();
  const was = section ? menuState().sections?.[section.id] ?? null : null;
  const [en, setEn] = useState(section ? (section.printed ? was?.name?.en ?? '' : section.name.en) : '');
  const [si, setSi] = useState(section?.name.si ?? '');
  const [ta, setTa] = useState(section?.name.ta ?? '');
  const [minutes, setMinutes] = useState(String(section?.cookMinutes ?? NEW_SECTION_MINUTES));
  const [sized, setSized] = useState(Boolean(section?.sizes));
  const [sizes, setSizes] = useState<string[]>(section?.sizes?.map((z) => z.label) ?? ['', '']);
  const [hidden, setHidden] = useState(Boolean(section?.hidden));
  const [error, setError] = useState('');
  const [moved, setMoved] = useState<{ message: string; undo: string[] } | null>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const order = menuSections().map((s) => s.id as string);
  const at = section ? order.indexOf(section.id) : -1;
  const move = (step: -1 | 1) => {
    if (!section) return;
    const undo = saveOrder(moveSection(order, section.id, step));
    setMoved({ message: `${section.label} moved ${step < 0 ? 'earlier' : 'later'}.`, undo });
  };

  const build = (): SectionSetting | string => {
    const s: SectionSetting = {};
    const name: NonNullable<SectionSetting['name']> = {};
    if (clean(en)) name.en = clean(en);
    if (clean(si)) name.si = clean(si);
    if (clean(ta)) name.ta = clean(ta);
    if (Object.keys(name).length) s.name = name;
    const m = minutes.trim() ? Number(minutes) : NaN;
    // A printed section keeps only what differs from print, so "as printed" is simply nothing.
    if (section?.printed) {
      const printed = PRINTED_SECTIONS.find((p) => p.id === section.id)!;
      if (name.en === printed.label) delete name.en;
      if (!Object.keys(name).length) delete s.name;
      if (m !== PRINTED_COOK_MINUTES[printed.id]) s.cookMinutes = m;
    } else s.cookMinutes = m;
    if (!section?.printed && sized) s.sizes = sizes.map((label, i) => ({ id: CUSTOM_SIZE_IDS[i], label: clean(label) }));
    if (hidden) s.hidden = true;
    const id = section?.id ?? 'sec-new';
    const bad = checkSection(id, s, was);
    if (bad) return `${bad[0].toUpperCase()}${bad.slice(1)}.`;
    if (!section && menuSections().some((x) => x.label.toLowerCase() === clean(en).toLowerCase())) return `${clean(en)} is already a section.`;
    return s;
  };

  const save = (e: FormEvent) => {
    e.preventDefault();
    const s = build();
    if (typeof s === 'string') return setError(s);
    if (!section) {
      const id = newSectionId(s.name!.en!, order);
      saveSection(id, s);
      return onSaved(`${s.name!.en} is on the menu. Add its dishes.`, () => saveSection(id, null), id);
    }
    // A printed section with nothing changed goes back to as printed.
    const after = section.printed && !Object.keys(s).length ? null : s;
    const before = saveSection(section.id, after);
    onSaved(`Saved ${s.name?.en ?? section.label}`, () => saveSection(section.id, before));
  };

  const title = section ? section.label : 'New section';
  /** Its dishes on offer: they go off the menu with it. */
  const dishes = section ? menuItems().filter((m) => m.category === section.id && !m.removed && !m.hidden).length : 0;
  const remove = () => {
    if (!section) return;
    const before = saveSection(section.id, { ...(was ?? {}), removed: true });
    onSaved(`Deleted ${section.label}`, () => saveSection(section.id, before));
  };
  return (
    <>
      <div className="scrim" onClick={onClose} />
      <form className="sheet menued" role="dialog" aria-modal="true" aria-label={section ? `Section ${section.label}` : 'New section'} onSubmit={save}>
        <div className="sheet__body">
          <div className="sheet__title">
            <h1>{title}</h1>
            {section?.printed && was && (
              <button type="button" className="linkbtn" onClick={() => {
                const before = saveSection(section.id, null);
                onSaved(`${section.label}: back to the printed menu`, () => saveSection(section.id, before));
              }}>Back to the printed menu</button>
            )}
          </div>

          <section className="group">
            <h2>Name</h2>
            <div className="menued__grid">
              <label>English
                <input value={en} onChange={(e) => { setEn(e.target.value); setError(''); }} maxLength={30} required={!section?.printed}
                  placeholder={section?.printed ? section.label : 'Kottu'} autoFocus={!section} />
              </label>
              <label>Sinhala<input value={si} onChange={(e) => setSi(e.target.value)} maxLength={40} lang="si" /></label>
              <label>Tamil<input value={ta} onChange={(e) => setTa(e.target.value)} maxLength={40} lang="ta" /></label>
            </div>
          </section>

          {!section?.printed && (
            <section className="group">
              <h2>Price</h2>
              {section ? (
                <p className="menued__note">{section.sizes ? 'Its dishes come in these sizes. You can rename them.' : 'Its dishes have one price.'}</p>
              ) : (
                <div className="cats" role="radiogroup" aria-label="How its dishes are priced">
                  <button type="button" role="radio" className="pill" aria-checked={!sized} aria-pressed={!sized} onClick={() => setSized(false)}>One price</button>
                  <button type="button" role="radio" className="pill" aria-checked={sized} aria-pressed={sized} onClick={() => setSized(true)}>Sizes</button>
                </div>
              )}
              {sized && (
                <div className="menued__grid">
                  {sizes.map((label, i) => (
                    <label key={i}>
                      Size {i + 1}
                      <input value={label} maxLength={12} placeholder={['Full', 'Normal', 'Small'][i]}
                        onChange={(e) => { setSizes(sizes.map((x, j) => (j === i ? e.target.value : x))); setError(''); }} />
                      {!section && i === 2 && (
                        <button type="button" className="linkbtn" onClick={() => setSizes(sizes.slice(0, 2))}>Remove</button>
                      )}
                    </label>
                  ))}
                  {!section && sizes.length < CUSTOM_SIZE_IDS.length && (
                    <button type="button" className="chip" onClick={() => setSizes([...sizes, ''])}>+ Size</button>
                  )}
                </div>
              )}
            </section>
          )}

          <section className="group">
            <h2>Kitchen</h2>
            <div className="menued__grid">
              <label>
                Cook time
                <NumberInput decimals={0} unit="min" value={minutes} onText={(t) => { setMinutes(t); setError(''); }} aria-label="Cook time in minutes" />
                <span className="menued__was">The ticket turns amber after this, red at one and a half times it.</span>
              </label>
            </div>
          </section>

          {section && (
            <section className="group">
              <h2>Place on the menu</h2>
              <div className="cats">
                <button type="button" className="chip" disabled={at <= 0} onClick={() => move(-1)}>Move earlier</button>
                <button type="button" className="chip" disabled={at < 0 || at >= order.length - 1} onClick={() => move(1)}>Move later</button>
                <span className="menued__was">{at + 1} of {order.length}</span>
              </div>
              {moved && (
                <p className="menued__added" role="status">
                  {moved.message}
                  <button type="button" className="linkbtn" onClick={() => { saveOrder(moved.undo); setMoved(null); }}>Undo</button>
                </p>
              )}
            </section>
          )}

          {section && (
            <section className="group">
              <label className="menued__check">
                <input type="checkbox" checked={hidden} onChange={(e) => setHidden(e.target.checked)} />
                Hide this section <span>(the counter and cheesybeez.com stop offering its dishes; old orders keep them)</span>
              </label>
              <div className="cats">
                <button type="button" className="chip" onClick={remove}>Delete section</button>
                <span className="menued__was">
                  {dishes ? `Its ${dishes === 1 ? 'dish goes' : `${dishes} dishes go`} off the menu with it. To keep one, open it and pick another section first.` : 'It has no dishes on offer.'}
                </span>
              </div>
            </section>
          )}
          {error && <p className="reason-msg" role="alert">{error}</p>}
        </div>
        <div className="sheet__foot menued__foot">
          <button type="button" className="linkbtn" onClick={onClose}>Cancel</button>
          <button type="submit" className="cta">{section ? 'Save' : 'Add section'}</button>
        </div>
      </form>
    </>
  );
}
