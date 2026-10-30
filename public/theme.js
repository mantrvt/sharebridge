// Dark by default; choice saved in localStorage. Loaded in <head> so there is no flash.
(function () {
  var KEY = 'sl-theme';
  var saved; try { saved = localStorage.getItem(KEY); } catch (e) {}
  var root = document.documentElement;
  var SUN = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/></svg>';
  var MOON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z"/></svg>';

  function apply(t) {
    root.setAttribute('data-theme', t);
    var m = document.querySelector('meta[name="theme-color"]');
    if (m) m.setAttribute('content', t === 'dark' ? '#0a0a0a' : '#fafafa');
    var b = document.getElementById('theme-toggle');
    if (b) { b.innerHTML = t === 'dark' ? SUN : MOON; b.setAttribute('aria-label', 'Switch to ' + (t === 'dark' ? 'light' : 'dark') + ' mode'); }
  }
  apply(saved === 'light' ? 'light' : 'dark');

  document.addEventListener('DOMContentLoaded', function () {
    var wrap = document.querySelector('.wrap');
    if (!wrap) return;
    var bar = document.createElement('div');
    bar.className = 'bar';
    bar.innerHTML = '<button id="theme-toggle" type="button" class="ghost"></button>';
    wrap.insertBefore(bar, wrap.firstChild);
    apply(root.getAttribute('data-theme'));
    document.getElementById('theme-toggle').onclick = function () {
      var next = root.getAttribute('data-theme') === 'dark' ? 'light' : 'dark';
      try { localStorage.setItem(KEY, next); } catch (e) {}
      apply(next);
    };
  });
})();
