import { useEffect, useRef, useState } from 'react';
import { disconnectChatGpt, isChatGptConnected, undoDisconnect } from '../services/chatgptLink.ts';

/** Shorter than the cloud's one minute, so a shown Undo always works. */
const UNDO_MS = 8000;

/**
 * Serves the owner (SCRUM-197). He knows ChatGPT is connected; the one thing he needs is to cut it
 * off, in one tap, from his phone. Nothing shows unless it is connected. Unlike the rest of the POS
 * this does not update optimistically: it never says "disconnected" until the cloud has done it.
 */
export function ChatGptLink() {
  const [state, setState] = useState<'hidden' | 'connected' | 'busy'>('hidden');
  const [undo, setUndo] = useState<number | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  useEffect(() => {
    let alive = true;
    isChatGptConnected().then((on) => { if (alive && on) setState('connected'); }, () => {});
    return () => { alive = false; clearTimeout(timer.current); };
  }, []);

  const disconnect = async () => {
    setState('busy');
    setFailed(null);
    try {
      const at = await disconnectChatGpt();
      setState('hidden');
      setUndo(at);
      timer.current = setTimeout(() => setUndo(null), UNDO_MS);
    } catch {
      setState('connected');
      setFailed('Not disconnected: no connection. ChatGPT can still read your sales.');
    }
  };

  const bringBack = async (at: number) => {
    clearTimeout(timer.current);
    setUndo(null);
    setFailed(null);
    try {
      await undoDisconnect(at);
      setState('connected');
    } catch {
      setFailed('Could not undo. ChatGPT stays disconnected: sign in again from ChatGPT.');
    }
  };

  return (
    <>
      {failed && <p className="owner__note" role="alert">{failed}</p>}
      {state !== 'hidden' && (
        <p className="owner__install owner__chatgpt">
          <span>ChatGPT can read your sales.</span>
          <button type="button" className="chip" disabled={state === 'busy'} onClick={() => void disconnect()}>
            {state === 'busy' ? 'Disconnecting…' : 'Disconnect'}
          </button>
        </p>
      )}
      {undo !== null && (
        <div className="toast" role="status">
          <span>ChatGPT disconnected</span>
          <button type="button" onClick={() => void bringBack(undo)}>Undo</button>
        </div>
      )}
    </>
  );
}
