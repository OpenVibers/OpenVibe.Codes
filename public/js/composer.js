/* The conductor's message box on the shared composer (openvibe-shared 4.215.0, OpenVibeComposer.mount, preset
   agent): the session form keeps its action, upload picker, status lines and no-JS post; its model becomes the mode
   chip (the form's `who`), and c4.js still drives the send. Without ov-composer.js the server's box stays. */
(function () {
  'use strict';
  function upgrade(form) {
    if (!form || form.__ovcComposer || !window.OpenVibeComposer || !window.OpenVibeComposer.mount) return;
    var ta = form.querySelector('#c4-message, textarea[name="text"], textarea');
    if (!ta) return;
    var options = [];
    try { options = JSON.parse(form.getAttribute('data-c4-model-options') || '[]'); } catch (e) { options = []; }
    var value = form.getAttribute('data-c4-model-value') || '';
    var c = window.OpenVibeComposer.mount(document.createElement('div'), {
      preset: 'agent', name: ta.name || 'text', maxLength: 16000,
      placeholder: ta.placeholder || 'Tell your conductor what to do next', label: 'Message the conductor',
      submitLabel: 'Send', tools: [],
      mode: options.length ? { name: 'who', label: 'Model', options: options, value: value } : null,
    });
    if (!c) return;
    c.text.id = 'c4-message';
    var anchor = ta.closest('label') || ta;
    while (c.form.firstChild) anchor.parentNode.insertBefore(c.form.firstChild, anchor);
    anchor.remove();
    var old = form.querySelector('.c4-conductor-actions button[type="submit"]');
    if (old) old.remove();
    form.classList.add('ovt-composer', 'ovc-v2');
    form.dataset.preset = 'agent';
    c.text.addEventListener('keydown', function (e) {
      if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); if (form.requestSubmit) form.requestSubmit(); else form.submit(); }
    });
    form.__ovcComposer = c;
  }
  function scan() {
    Array.prototype.forEach.call(document.querySelectorAll('form[data-ovc-compose]'), upgrade);
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', scan, { once: true }); else scan();
  window.OVCodesComposer = { scan: scan, upgrade: upgrade };
})();
