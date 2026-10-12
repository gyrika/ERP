/** Start the POS afresh (after setup: syncing, then the PIN screen). Its own module so tests can stand in for it. */
export const restartApp = (): void => { location.replace('/'); };
