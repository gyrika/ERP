/**
 * Light or dark, per screen. 'auto' follows Windows (or the phone), which is the default.
 * The colours themselves live in styles.css under :root[data-theme]; the Kitchen view
 * always shows dark, whatever is chosen here.
 */
export type ThemeChoice = 'auto' | 'light' | 'dark';

const KEY = 'cb.theme';

export const themeChoice = (): ThemeChoice => {
  try {
    const v = localStorage.getItem(KEY);
    return v === 'light' || v === 'dark' ? v : 'auto';
  } catch {
    return 'auto';
  }
};

/** Puts the choice on the page: no attribute = follow the system. */
export const applyTheme = (choice: ThemeChoice = themeChoice()): void => {
  const root = document.documentElement;
  if (choice === 'auto') delete root.dataset.theme;
  else root.dataset.theme = choice;
};

export const setTheme = (choice: ThemeChoice): void => {
  try {
    if (choice === 'auto') localStorage.removeItem(KEY);
    else localStorage.setItem(KEY, choice);
  } catch { /* private mode: this visit only */ }
  applyTheme(choice);
};

export const THEME_LABEL: Record<ThemeChoice, string> = {
  light: 'Light mode', dark: 'Dark mode', auto: 'Light or dark: follow Windows',
};
