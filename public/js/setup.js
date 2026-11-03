// /setup's own script (loaded there only). Copy buttons (the guided setup's commands): the code beside the button goes to the clipboard, and the button says so.
// Where the clipboard is refused, the command is selected instead, for the person to copy.
(function () {
    'use strict';
    document.addEventListener('click', function (e) {
        var btn = e.target && e.target.closest ? e.target.closest('[data-c4-copy]') : null;
        if (!btn) return;
        var code = btn.parentNode && btn.parentNode.querySelector('code');
        if (!code) return;
        var text = code.textContent || '';
        var said = function (word) { btn.textContent = word; window.setTimeout(function () { btn.textContent = 'Copy'; }, 1600); };
        var select = function () { var r = document.createRange(); r.selectNodeContents(code); var sel = window.getSelection(); sel.removeAllRanges(); sel.addRange(r); said('Selected'); };
        if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(text).then(function () { said('Copied'); }, select);
        else select();
    });
})();
