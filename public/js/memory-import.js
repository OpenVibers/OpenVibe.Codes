'use strict';
/*
 * Memory M5: choosing a portable file fills the import textarea, so the page works with the browser's own file
 * picker and no inline script. It only copies the file's text; the import itself is a normal form post to Codes,
 * which forwards the document to the store.
 */
(function () {
    var input = document.getElementById('memory-import-file');
    var text = document.getElementById('memory-import-text');
    if (!input || !text) return;
    input.addEventListener('change', function () {
        var file = input.files && input.files[0];
        if (!file) return;
        if (file.size > 25 * 1024 * 1024) {
            text.value = '';
            input.setCustomValidity('That file is larger than 25 MB.');
            input.reportValidity();
            return;
        }
        input.setCustomValidity('');
        var reader = new FileReader();
        reader.onload = function () { text.value = String(reader.result || ''); };
        reader.readAsText(file);
    });
}());
