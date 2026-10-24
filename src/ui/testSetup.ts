/**
 * What jsdom leaves out and Visual Flow's drawing library (React Flow) needs; every browser the
 * shop uses has them. Measured sizes stay 0 here: tests read the cards and the panel, not pixels.
 */
class NoResize {
  observe() {}
  unobserve() {}
  disconnect() {}
}
globalThis.ResizeObserver ??= NoResize as unknown as typeof ResizeObserver;

class Matrix {
  m22: number;
  constructor(transform?: string) {
    const scale = /scale\(([\d.]+)\)/.exec(transform ?? '');
    this.m22 = scale ? Number(scale[1]) : 1;
  }
}
globalThis.DOMMatrixReadOnly ??= Matrix as unknown as typeof DOMMatrixReadOnly;
