// Theme engine — ported from HamTab (stevencheist/HamTabv1 src/themes.js, MIT, same author).
// Each theme sets Bambuzle's CSS custom properties plus an optional body class for shape/font
// overrides (see the "Themes" section of style.css). Choice is per-browser (localStorage).
// Default is 'terminal' — Bambuzle's original green-on-black look — so upgrades change nothing.
// Every text/background pairing meets WCAG AA (4.5:1); a few HamTab colours were adjusted for that
// (Modern accent/red, Radio Face dim text, Terminal dim text). Re-check with a contrast audit when editing.

const STORAGE_KEY = 'bambuzle_theme';
const DEFAULT_THEME = 'terminal';

const THEMES = {
  terminal: {
    name: 'Terminal',
    description: 'Retro green-on-black (Bambuzle classic)',
    bodyClass: 'theme-terminal',
    vars: {
      '--bg': '#000000', '--bg-card': '#0a1a0a', '--bg-hover': '#0d2b0d',
      '--border': '#1a4a2a', '--text': '#00ff88', '--text-dim': '#3fa86a',
      '--accent': '#00cc66', '--accent-dim': '#009944', '--on-accent': '#000000',
      '--green': '#00ff44', '--yellow': '#cccc00', '--red': '#ff3333', '--orange': '#ff8800', '--purple': '#cc66ff',
      '--font': "'Courier New', 'Lucida Console', monospace",
    },
  },
  default: {
    name: 'Modern',
    description: 'HamTab default — modern dark blue',
    bodyClass: 'theme-modern',
    vars: {
      '--bg': '#1a1a2e', '--bg-card': '#16213e', '--bg-hover': '#1f2d52',
      '--border': '#2a3a5e', '--text': '#e0e0e0', '--text-dim': '#8899aa',
      '--accent': '#ff6b81', '--accent-dim': '#b8364c', '--on-accent': '#000000',
      '--green': '#00c853', '--yellow': '#ffd600', '--red': '#ff5370', '--orange': '#ff9100', '--purple': '#b388ff',
      '--font': "system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif",
    },
  },
  lcars: {
    name: 'LCARS',
    description: 'Star Trek TNG inspired',
    bodyClass: 'theme-lcars',
    vars: {
      '--bg': '#000000', '--bg-card': '#0a0a14', '--bg-hover': '#111122',
      '--border': '#9999CC', '--text': '#FF9966', '--text-dim': '#CCBBDD',
      '--accent': '#FFCC66', '--accent-dim': '#CC9933', '--on-accent': '#000000',
      '--green': '#99CCFF', '--yellow': '#FFFF99', '--red': '#CC6666', '--orange': '#FF9933', '--purple': '#CC99CC',
      '--font': "'Arial Narrow', Arial, sans-serif",
    },
  },
  hamclock: {
    name: 'HamClock',
    description: 'Inspired by HamClock by WB0OEW',
    bodyClass: 'theme-hamclock',
    vars: {
      '--bg': '#000000', '--bg-card': '#000000', '--bg-hover': '#141414',
      '--border': '#333333', '--text': '#e0e0e0', '--text-dim': '#888899',
      '--accent': '#00ffff', '--accent-dim': '#00aaaa', '--on-accent': '#000000',
      '--green': '#00ff00', '--yellow': '#ffff00', '--red': '#ff0000', '--orange': '#e8a000', '--purple': '#cc66ff',
      '--font': "'Courier New', 'Lucida Console', monospace",
    },
  },
  radioface: {
    name: 'Radio Face',
    description: 'Modern transceiver LCD',
    bodyClass: 'theme-radioface',
    vars: {
      '--bg': '#060a12', '--bg-card': '#0c1220', '--bg-hover': '#141e30',
      '--border': '#1a2a44', '--text': '#d0e0f0', '--text-dim': '#8aa4c4',
      '--accent': '#00e5ff', '--accent-dim': '#0099aa', '--on-accent': '#000000',
      '--green': '#00c853', '--yellow': '#ffd600', '--red': '#ff4d6a', '--orange': '#ff9100', '--purple': '#b388ff',
      '--font': "'Segoe UI', Roboto, 'Helvetica Neue', sans-serif",
    },
  },
  accessibility: {
    name: 'Accessible',
    description: 'High contrast, larger text',
    bodyClass: 'high-contrast',
    vars: {
      '--bg': '#000000', '--bg-card': '#111111', '--bg-hover': '#222222',
      '--border': '#666666', '--text': '#ffffff', '--text-dim': '#cccccc',
      '--accent': '#00ccff', '--accent-dim': '#0099cc', '--on-accent': '#000000',
      '--green': '#00ff55', '--yellow': '#ffee00', '--red': '#ff4444', '--orange': '#ff9900', '--purple': '#dd99ff',
      '--font': "system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif",
    },
  },
};

function readSaved() {
  try {
    return localStorage.getItem(STORAGE_KEY);
  } catch {
    return null;
  }
}

let activeThemeId = THEMES[readSaved()] ? readSaved() : DEFAULT_THEME;

export function getThemeList() {
  return Object.entries(THEMES).map(([id, t]) => ({ id, name: t.name, description: t.description }));
}

export function getCurrentThemeId() {
  return activeThemeId;
}

/** Swatch colours for the picker preview. */
export function getThemeSwatchColors(themeId) {
  const v = THEMES[themeId]?.vars;
  return v ? [v['--bg'], v['--bg-card'], v['--accent'], v['--text'], v['--border']] : [];
}

/** Current value of a theme variable (charts/SVG read colours at render time). */
export function themeVar(name, fallback = '') {
  const value = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return value || fallback;
}

/** Apply a theme: set CSS variables, swap the body class, persist, and notify listeners. */
export function applyTheme(themeId) {
  const theme = THEMES[themeId];
  if (!theme) return;
  // Theme class goes on <html> (not <body>) so public/js/theme-boot.js can set it in <head> before paint
  const root = document.documentElement;
  for (const [prop, value] of Object.entries(theme.vars)) root.style.setProperty(prop, value);
  for (const t of Object.values(THEMES)) {
    if (t.bodyClass) root.classList.remove(t.bodyClass);
  }
  if (theme.bodyClass) root.classList.add(theme.bodyClass);
  root.dataset.theme = themeId;
  activeThemeId = themeId;
  try {
    localStorage.setItem(STORAGE_KEY, themeId);
    localStorage.setItem('bambuzle_theme_cache', JSON.stringify({ cls: theme.bodyClass, vars: theme.vars }));
  } catch { /* private mode — theme still applies for this page */ }
  window.dispatchEvent(new CustomEvent('bambuzle:themechange', { detail: { themeId } }));
}

export function initTheme() {
  applyTheme(activeThemeId);
}
