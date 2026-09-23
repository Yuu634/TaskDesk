'use strict';
(() => {
  const selector = 'textarea, input:not([type]), input[type="text"], input[type="search"]';
  const editable = el => el instanceof HTMLElement && el.matches(selector) && !el.matches(':disabled') && !el.readOnly;
  function prepare(root) {
    const fields = [...(root.matches?.(selector) ? [root] : []), ...root.querySelectorAll(selector)];
    for (const field of fields) {
      if (!field.hasAttribute('inputmode')) field.setAttribute('inputmode', 'text');
      field.setAttribute('virtualkeyboardpolicy', 'auto');
    }
  }
  prepare(document);
  new MutationObserver(records => {
    for (const record of records) for (const node of record.addedNodes) if (node.nodeType === 1) prepare(node);
  }).observe(document.body, { childList: true, subtree: true });
  // Keep focus in the user's tap event, so mobile browsers can show their keyboard.
  document.addEventListener('click', event => {
    if (editable(event.target) && document.activeElement !== event.target) event.target.focus({ preventScroll: true });
  });
  const mobile = matchMedia('(max-width: 700px)'), viewport = window.visualViewport;
  let frame;
  function update() {
    cancelAnimationFrame(frame);
    frame = requestAnimationFrame(() => {
      if (!mobile.matches) return;
      const height = viewport?.height || innerHeight, top = viewport?.offsetTop || 0;
      document.documentElement.style.setProperty('--mobile-view-height', height + 'px');
      document.documentElement.style.setProperty('--mobile-view-top', top + 'px');
      const field = document.activeElement;
      if (!editable(field)) return;
      const container = field.closest('#inspector-content, .modal-body');
      if (!container) return;
      const rect = field.getBoundingClientRect(), box = container.getBoundingClientRect();
      if (rect.top < box.top || rect.bottom > box.bottom) container.scrollTop += rect.top - box.top - 8;
    });
  }
  viewport?.addEventListener('resize', update);
  viewport?.addEventListener('scroll', update);
  window.addEventListener('resize', update);
  document.addEventListener('focusin', update);
  update();
})();
