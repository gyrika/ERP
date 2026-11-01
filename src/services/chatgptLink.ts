import { ownerToken } from './pairing.ts';

/**
 * The owner's Disconnect button (SCRUM-197): whether ChatGPT can read his shop, from the cloud's
 * /api/v1/mcp endpoints. A cloud with the MCP server switched off answers 404, which reads as
 * "not connected", so nothing shows.
 */
const call = async (path: string, body?: unknown): Promise<Response> => {
  const token = ownerToken();
  if (!token) throw new Error('no owner link');
  return fetch(`/api/v1/mcp/${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { authorization: `Bearer ${token}`, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(15_000),
  });
};

export const isChatGptConnected = async (): Promise<boolean> => {
  const r = await call('connection');
  return r.ok && ((await r.json()) as { connected?: unknown }).connected === true;
};

/** When it was cut off, which Undo hands back. Throws unless the cloud has really done it. */
export const disconnectChatGpt = async (): Promise<number> => {
  const r = await call('disconnect', {});
  if (!r.ok) throw new Error(`server ${r.status}`);
  return ((await r.json()) as { at: number }).at;
};

export const undoDisconnect = async (at: number): Promise<void> => {
  const r = await call('reconnect', { at });
  if (!r.ok) throw new Error(`server ${r.status}`);
};
