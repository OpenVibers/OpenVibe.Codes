// OpenVibe.Codes — optional copy buttons (the value is always selectable without JavaScript).
(function () {
    'use strict';
    document.querySelectorAll('button.copy[data-copy]').forEach(function (btn) {
        var target = document.querySelector(btn.getAttribute('data-copy'));
        if (!target || !navigator.clipboard) return;
        btn.hidden = false;
        btn.addEventListener('click', function () {
            navigator.clipboard.writeText(target.value || target.textContent || '').then(function () {
                btn.textContent = 'Copied';
                setTimeout(function () { btn.textContent = 'Copy secret'; }, 2000);
            }, function () { target.select && target.select(); });
        });
    });
})();
