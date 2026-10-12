import { execFile } from 'node:child_process';
import { mkdir, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Sends raw ESC/POS bytes to the receipt printer (SCRUM-71). The browser
 * builds the bytes (src/domain/receipt.ts); this only delivers them.
 *
 * Windows: through the normal printer queue with the RAW datatype
 * (server/rawprint.ps1), so the Windows driver stays installed and other
 * programs can still print. Linux/macOS (development): `lp -o raw`.
 * Dry run (no printer yet): each receipt is saved to server/prints/ as .bin.
 */
export interface RawPrinter {
  readonly name: string;
  print(bytes: Uint8Array): Promise<void>;
}

const run = (cmd: string, args: string[]): Promise<void> =>
  new Promise((resolve, reject) => {
    execFile(cmd, args, { timeout: 15_000, windowsHide: true }, (err, _out, stderr) => {
      if (err) reject(new Error(`${cmd} failed: ${stderr || err.message}`));
      else resolve();
    });
  });

/** Prints one job at a time, in order: two receipts must never interleave on the paper. */
const serial = (printer: Omit<RawPrinter, 'print'> & { send(bytes: Uint8Array): Promise<void> }): RawPrinter => {
  let queue: Promise<unknown> = Promise.resolve();
  return {
    name: printer.name,
    print(bytes) {
      const job = queue.then(() => printer.send(bytes));
      queue = job.catch(() => {});
      return job;
    },
  };
};

const withTempFile = async (bytes: Uint8Array, fn: (path: string) => Promise<void>) => {
  const path = join(tmpdir(), `cheesybeez-receipt-${process.pid}-${Date.now()}.bin`);
  await writeFile(path, bytes);
  try { await fn(path); } finally { await unlink(path).catch(() => {}); }
};

export function systemPrinter(printerName: string): RawPrinter {
  const script = fileURLToPath(new URL('./rawprint.ps1', import.meta.url));
  return serial({
    name: printerName,
    send: (bytes) => withTempFile(bytes, (path) =>
      process.platform === 'win32'
        ? run('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script, '-Printer', printerName, '-Path', path])
        : run('lp', ['-d', printerName, '-o', 'raw', path])),
  });
}

export function dryRunPrinter(dir: string): RawPrinter {
  let n = 0;
  return serial({
    name: `dry run (${dir})`,
    async send(bytes) {
      await mkdir(dir, { recursive: true });
      const stamp = new Date().toISOString().replace(/[:.]/g, '-');
      await writeFile(join(dir, `${stamp}-${++n}.bin`), bytes);
    },
  });
}
