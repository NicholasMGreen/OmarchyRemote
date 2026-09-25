// Scale every explicitly sized piece of shell text without moving layout boxes.
// Text is sized in raw px across the stylesheets, the design-export template's
// inline styles, and app-created nodes, so a root font-size change cannot reach
// it. Each px font-size is rewritten once into calc(px * var(--omarchy-text-scale, 1));
// the setting then changes only that variable, so windows keep their layout.
// Terminal keeps its own Larger/Fit controls, so .xterm subtrees are left alone.
(() => {
  const { storage } = window.HyprlandUtil;
  const KEY = 'omarchy-text-scale';
  const VAR = '--omarchy-text-scale';
  const SCALES = ['70', '80', '90', '100', '110', '125'];
  const PX = /^(\d+(?:\.\d+)?)px$/;
  const rewrite = px => `calc(${px}px * var(${VAR}, 1))`;

  const current = () => {
    const v = storage.get(KEY);
    return SCALES.includes(v) ? v : '100';
  };

  const scaleInline = el => {
    if (el.closest?.('.xterm')) return;
    const match = PX.exec(el.style?.fontSize || '');
    if (match) el.style.fontSize = rewrite(match[1]);
  };

  const walkRules = rules => {
    for (const rule of rules) {
      if (rule.cssRules) walkRules(rule.cssRules);
      if (!rule.style) continue;
      // Shorthand font rules keep their declaration; the appended font-size
      // longhand lands after it in the cascade, so calc avoids shorthand parsing.
      const match = PX.exec(rule.style.fontSize || '');
      if (match)
        rule.style.setProperty(
          'font-size',
          rewrite(match[1]),
          rule.style.getPropertyPriority('font-size')
        );
    }
  };

  let observing = false;
  const mo = new MutationObserver(records => {
    for (const m of records) {
      if (m.type === 'attributes') {
        scaleInline(m.target);
      } else {
        for (const added of m.addedNodes) {
          if (added.nodeType !== 1) continue;
          if (added.tagName === 'STYLE') {
            try {
              if (added.sheet) walkRules(added.sheet.cssRules);
            } catch {}
            continue;
          }
          scaleInline(added);
          for (const el of added.querySelectorAll('[style]')) scaleInline(el);
        }
      }
    }
  });

  const activate = () => {
    const scale = current();
    if (scale === '100') {
      document.documentElement.style.removeProperty(VAR);
      if (observing) {
        mo.disconnect();
        observing = false;
      }
      return;
    }
    document.documentElement.style.setProperty(VAR, String(Number(scale) / 100));
    // Stylesheets and the template are only complete once parsing has finished.
    if (document.readyState === 'loading' || observing) return;
    for (const sheet of document.styleSheets) {
      try {
        walkRules(sheet.cssRules);
      } catch {}
    }
    for (const el of document.querySelectorAll('[style]')) scaleInline(el);
    mo.observe(document.documentElement, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['style'],
    });
    observing = true;
  };

  const factor = () => Number(current()) / 100;
  const set = value => {
    if (!SCALES.includes(value)) return;
    storage.set(KEY, value);
    activate();
    window.dispatchEvent(new Event('hyprland-text-scale'));
  };

  window.HyprlandTextScale = { SCALES, current, set, factor };
  activate();
  document.addEventListener('DOMContentLoaded', activate);
})();
