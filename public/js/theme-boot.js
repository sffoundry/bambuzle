// Runs synchronously in <head> (classic script, not a module) so the saved theme is in place before
// first paint — no green-on-black flash for other themes. themes.js caches { cls, vars } on every apply.
(function () {
  try {
    var saved = JSON.parse(localStorage.getItem('bambuzle_theme_cache') || 'null');
    if (!saved || !saved.vars) return;
    var root = document.documentElement;
    for (var k in saved.vars) root.style.setProperty(k, saved.vars[k]);
    if (saved.cls) root.classList.add(saved.cls);
  } catch (e) { /* storage blocked or corrupt — themes.js applies the theme after load */ }
})();
