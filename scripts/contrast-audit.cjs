// Dev tool (not shipped in the image): renders every view in every theme with headless Chromium and lists text
// below WCAG AA. Needs playwright-core + a Chromium build outside this repo, e.g.:
//   npm i --prefix /tmp/pw playwright-core && PLAYWRIGHT_BROWSERS_PATH=/tmp/pw/b npx --prefix /tmp/pw playwright-core install chromium-headless-shell
//   NODE_PATH=/tmp/pw/node_modules PLAYWRIGHT_BROWSERS_PATH=/tmp/pw/b TOKEN=$(cat admin-token) node scripts/contrast-audit.cjs
// Read-only against the target server (never clicks printer controls).
// Renders Bambuzle in every theme and reports text below WCAG AA contrast (4.5:1 normal, 3:1 large).
// Read-only: never clicks printer controls.
const { chromium } = require('playwright-core');
const fs = require('fs');
const BASE = process.env.BASE || 'http://localhost:3000';
const TOKEN = process.env.TOKEN;
const OUT = process.env.OUT;
const THEMES = ['terminal', 'default', 'lcars', 'hamclock', 'radioface', 'accessibility'];
const VIEWS = ['dashboard', 'events', 'alerts', 'stats', 'maintenance'];

const AUDIT = () => {
  const parse = (c) => {
    const m = c.match(/rgba?\(([^)]+)\)/);
    if (!m) return null;
    const p = m[1].split(/[ ,\/]+/).filter(Boolean).map(Number);
    return { r: p[0], g: p[1], b: p[2], a: p.length > 3 ? p[3] : 1 };
  };
  const blend = (top, under) => ({
    r: top.r * top.a + under.r * (1 - top.a), g: top.g * top.a + under.g * (1 - top.a),
    b: top.b * top.a + under.b * (1 - top.a), a: 1,
  });
  const lum = ({ r, g, b }) => {
    const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; };
    return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
  };
  const ratio = (a, b) => { const [x, y] = [lum(a), lum(b)].sort((m, n) => n - m); return (x + 0.05) / (y + 0.05); };
  // Effective background: stack ancestor backgrounds from the root down (gradients → first colour stop)
  const bgOf = (el) => {
    const layers = [];
    for (let n = el; n && n.nodeType === 1; n = n.parentElement) {
      const cs = getComputedStyle(n);
      let c = parse(cs.backgroundColor);
      if (cs.backgroundImage && cs.backgroundImage.includes('gradient')) {
        const g = parse(cs.backgroundImage);
        if (g) c = g;
      }
      if (c && c.a > 0) { layers.push(c); if (c.a >= 1) break; }
    }
    let acc = { r: 255, g: 255, b: 255, a: 1 };
    for (const l of layers.reverse()) acc = blend(l, acc);
    return acc;
  };
  const visible = (el) => {
    const r = el.getBoundingClientRect();
    if (r.width < 1 || r.height < 1) return false;
    for (let n = el; n && n.nodeType === 1; n = n.parentElement) {
      const cs = getComputedStyle(n);
      if (cs.display === 'none' || cs.visibility === 'hidden' || Number(cs.opacity) === 0) return false;
    }
    return true;
  };
  const label = (el) => {
    const cls = [...el.classList].slice(0, 3).join('.');
    const parent = el.parentElement ? (el.parentElement.className && typeof el.parentElement.className === 'string' ? '.' + el.parentElement.className.split(' ')[0] : el.parentElement.tagName.toLowerCase()) : '';
    return `${parent} > ${el.tagName.toLowerCase()}${el.id ? '#' + el.id : ''}${cls ? '.' + cls : ''}`;
  };
  const out = [];
  for (const el of document.querySelectorAll('body *')) {
    if (['SCRIPT', 'STYLE', 'svg', 'path', 'OPTION'].includes(el.tagName)) continue;
    const text = [...el.childNodes].filter((n) => n.nodeType === 3).map((n) => n.textContent.trim()).join(' ').trim();
    const isField = ['INPUT', 'SELECT', 'BUTTON', 'TEXTAREA'].includes(el.tagName);
    const shown = text || (isField && (el.value || el.textContent || '').trim());
    if (!shown || !visible(el)) continue;
    // Skip text covered by another layer (e.g. the header behind the sign-in overlay): only judge what's on top
    {
      const rr = el.getBoundingClientRect();
      const cx = rr.left + rr.width / 2;
      const cy = rr.top + rr.height / 2;
      if (cx >= 0 && cy >= 0 && cx < innerWidth && cy < innerHeight) {
        const top = document.elementFromPoint(cx, cy);
        if (top && top !== el && !el.contains(top) && !top.contains(el)) continue;
      }
    }
    const cs = getComputedStyle(el);
    let fg = parse(cs.color);
    if (!fg) continue;
    const bg = bgOf(el);
    if (fg.a < 1) fg = blend(fg, bg);
    const op = Number(cs.opacity) < 1 ? Number(cs.opacity) : 1;
    if (op < 1) fg = blend({ ...fg, a: op }, bg);
    const size = parseFloat(cs.fontSize);
    const bold = Number(cs.fontWeight) >= 700;
    const large = size >= 24 || (bold && size >= 18.66);
    const r = ratio(fg, bg);
    const need = large ? 3 : 4.5;
    if (r < need) {
      out.push({ where: label(el), text: String(shown).slice(0, 30), ratio: Math.round(r * 100) / 100, need,
        fg: `rgb(${Math.round(fg.r)},${Math.round(fg.g)},${Math.round(fg.b)})`, bg: `rgb(${Math.round(bg.r)},${Math.round(bg.g)},${Math.round(bg.b)})` });
    }
  }
  return out;
};

(async () => {
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 1600, height: 1000 } });
  const page = await ctx.newPage();
  await page.goto(BASE + '/');
  await page.evaluate(async (t) => { await fetch('/api/session', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token: t }) }); }, TOKEN);
  await page.goto(BASE + '/');
  await page.waitForTimeout(2500);
  await page.selectOption('#dash-filter-printer', '__all__').catch(() => {});
  await page.waitForTimeout(1500);
  const report = {};
  for (const theme of THEMES) {
    await page.evaluate(async (id) => { (await import('/js/themes.js')).applyTheme(id); }, theme);
    await page.waitForTimeout(600);
    const findings = [];
    for (const view of VIEWS) {
      await page.click(`.nav-btn[data-view="${view}"]`);
      await page.waitForTimeout(view === 'dashboard' ? 1200 : 800);
      if (OUT && view === 'dashboard') await page.screenshot({ path: `${OUT}/${theme}-dashboard.png` });
      for (const f of await page.evaluate(AUDIT)) findings.push({ view, ...f });
    }
    await page.click('#config-btn'); await page.waitForTimeout(500);
    for (const f of await page.evaluate(AUDIT)) findings.push({ view: 'config', ...f });
    await page.click('.config-conn-btn').catch(() => {}); await page.waitForTimeout(600);
    for (const f of await page.evaluate(AUDIT)) findings.push({ view: 'connection-dialog', ...f });
    await page.keyboard.press('Escape'); await page.waitForTimeout(200);
    await page.keyboard.press('Escape'); await page.click('#config-close').catch(() => {});
    await page.click('.nav-btn[data-view="dashboard"]');
    // de-duplicate by view+where+colours
    const seen = new Map();
    for (const f of findings) {
      const k = `${f.view}|${f.where}|${f.fg}|${f.bg}`;
      if (!seen.has(k)) seen.set(k, { ...f, count: 1 }); else seen.get(k).count++;
    }
    report[theme] = [...seen.values()].sort((a, b) => a.ratio - b.ratio);
  }
  // leave the browser's stored theme as it was (terminal)
  await page.evaluate(async () => { (await import('/js/themes.js')).applyTheme('terminal'); });
  await browser.close();
  console.log(JSON.stringify(report, null, 1));
})().catch((e) => { console.error('FAIL', e.message); process.exit(1); });
