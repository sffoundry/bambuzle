'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const fs = require('fs');

// Minimal DOM/localStorage stubs for the browser-side theme engine
function stubBrowser() {
  const props = {};
  const classes = new Set();
  const events = [];
  const store = {};
  globalThis.localStorage = { getItem: (k) => store[k] ?? null, setItem: (k, v) => { store[k] = String(v); } };
  globalThis.document = {
    documentElement: { style: { setProperty: (k, v) => { props[k] = v; } }, dataset: {} },
    body: { classList: { add: (c) => classes.add(c), remove: (c) => classes.delete(c) } },
  };
  globalThis.window = { dispatchEvent: (e) => events.push(e) };
  globalThis.CustomEvent = class { constructor(type, init) { this.type = type; this.detail = init?.detail; } };
  return { props, classes, events, store };
}

test('every theme defines the same variables as :root, and applyTheme swaps class + persists + notifies', async () => {
  const env = stubBrowser();
  const themes = await import(path.join(__dirname, '..', 'public', 'js', 'themes.js'));
  const list = themes.getThemeList();
  assert.deepEqual(list.map((t) => t.id).sort(), ['accessibility', 'default', 'hamclock', 'lcars', 'radioface', 'terminal']);
  assert.equal(themes.getCurrentThemeId(), 'terminal', 'default keeps the classic look');

  // :root must define every variable a theme sets, so nothing is undefined before JS runs
  const css = fs.readFileSync(path.join(__dirname, '..', 'public', 'css', 'style.css'), 'utf8');
  const root = css.slice(css.indexOf(':root {'), css.indexOf('}', css.indexOf(':root {')));
  let reference = null;
  for (const t of list) {
    themes.applyTheme(t.id);
    const keys = Object.keys(env.props).sort();
    if (!reference) reference = keys;
    for (const k of keys) assert.ok(root.includes(`${k}:`), `:root lacks ${k}`);
  }

  themes.applyTheme('lcars');
  assert.ok(env.classes.has('theme-lcars'));
  themes.applyTheme('accessibility');
  assert.ok(!env.classes.has('theme-lcars'), 'previous class removed');
  assert.ok(env.classes.has('high-contrast'));
  assert.equal(env.store.bambuzle_theme, 'accessibility');
  assert.equal(env.events.at(-1).type, 'bambuzle:themechange');
  assert.equal(env.props['--accent'], '#00ccff');

  themes.applyTheme('nope');
  assert.equal(themes.getCurrentThemeId(), 'accessibility', 'unknown id ignored');
  assert.equal(themes.getThemeSwatchColors('lcars').length, 5);
});
