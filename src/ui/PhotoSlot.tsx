import { useEffect, useRef, useState, type DragEvent } from 'react';
import { PhotoError, keepPhoto } from '../services/menuPhotos.ts';

/**
 * An item's photo on its sheet (the Menu screen: Change, and + Add). Serves the owner: they have a
 * picture somewhere (a file, or copied from a browser or WhatsApp) and want it on the item now.
 * Choose photo, Paste (or Ctrl+V anywhere on the sheet), or drop a file on it; it is made small and
 * kept, and the sheet's owner records the change (with its Undo).
 */
export function PhotoSlot({ name, url, onPhoto, onRemove }: {
  /** The item's name, for the picture's description. */
  name: string;
  /** What it shows now; null = no photo (a blank). */
  url: string | null;
  /** A picture was kept: its photo id. */
  onPhoto: (id: string) => void;
  /** Absent: nothing to remove. */
  onRemove?: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [over, setOver] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  const take = async (picture: Blob | null | undefined) => {
    if (!picture) return;
    setError('');
    setBusy(true);
    try { onPhoto(await keepPhoto(picture)); }
    catch (e) { setError(e instanceof PhotoError ? e.message : 'The photo could not be saved. Try again.'); }
    finally { setBusy(false); }
  };
  const takeRef = useRef(take);
  takeRef.current = take;

  // Ctrl+V anywhere on the open sheet: a copied picture becomes the photo. Pasted text still goes into the field.
  useEffect(() => {
    const onPaste = (e: ClipboardEvent) => {
      const file = [...(e.clipboardData?.files ?? [])].find((f) => f.type.startsWith('image/'));
      if (!file) return;
      e.preventDefault();
      void takeRef.current(file);
    };
    window.addEventListener('paste', onPaste);
    return () => window.removeEventListener('paste', onPaste);
  }, []);

  const pasteButton = async () => {
    setError('');
    try {
      for (const entry of await navigator.clipboard.read()) {
        const type = entry.types.find((t) => t.startsWith('image/'));
        if (type) { await take(await entry.getType(type)); return; }
      }
      setError('There is no picture copied. Copy one first (right-click a picture, Copy image), then Paste.');
    } catch {
      setError('Copy a picture, then press Ctrl+V here.');
    }
  };

  const drop = (e: DragEvent) => {
    e.preventDefault();
    setOver(false);
    void take([...e.dataTransfer.files].find((f) => f.type.startsWith('image/')));
  };

  return (
    <section className="group photo-slot">
      <h2>Photo</h2>
      <div className={`photo-slot__frame${over ? ' photo-slot__frame--over' : ''}${busy ? ' photo-slot__frame--busy' : ''}`}
        onDragOver={(e) => { e.preventDefault(); setOver(true); }} onDragLeave={() => setOver(false)} onDrop={drop}>
        {url ? <img src={url} alt={`Photo of ${name}`} /> : <span className="photo-slot__blank">No photo. Drop a picture here, or press Ctrl+V.</span>}
      </div>
      <div className="photo-slot__actions">
        <button type="button" className="chip" disabled={busy} onClick={() => fileRef.current?.click()}>Choose photo</button>
        <button type="button" className="chip" disabled={busy} onClick={() => { void pasteButton(); }}>Paste</button>
        {onRemove && url && <button type="button" className="linkbtn" disabled={busy} onClick={() => { setError(''); onRemove(); }}>Remove photo</button>}
        <input ref={fileRef} type="file" accept="image/*" hidden aria-label="Photo file"
          onChange={(e) => { void take(e.target.files?.[0]); e.target.value = ''; }} />
      </div>
      {busy && <p className="menued__note" role="status">Saving the photo…</p>}
      {error && <p className="reason-msg" role="alert">{error}</p>}
    </section>
  );
}
