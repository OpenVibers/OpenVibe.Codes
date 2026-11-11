'use strict';
// The shared picker keeps portable JSON local; export zips go through the existing preview route.
(function () {
    if (!window.OVUpload) return;
    const localRoot = document.getElementById('memory-import-picker');
    const text = document.getElementById('memory-import-text');
    const localError = document.getElementById('memory-import-error');
    const maxBytes = 25 * 1024 * 1024;
    if (localRoot && text) {
        const picker = OVUpload.picker(localRoot, {
            label: 'Choose a memory JSON file', accept: '.json,application/json', multiple: false,
            onFile: (file, row) => {
                picker.rows.querySelectorAll('.ov-upload__row').forEach((old) => { if (old !== row) { old.dispatchEvent(new Event('remove')); old.remove(); } });
                if (file.size > maxBytes || !(/\.json$/i.test(file.name) || file.type === 'application/json')) {
                    row.dispatchEvent(new Event('remove')); row.remove();
                    localError.textContent = file.size > maxBytes ? 'That file is larger than 25 MB.' : 'Choose a JSON file.';
                    localError.hidden = false; return;
                }
                localError.hidden = true;
                const reader = new FileReader();
                reader.onload = () => { text.value = String(reader.result || ''); };
                reader.onerror = () => { localError.textContent = 'That file could not be read. Try another JSON file.'; localError.hidden = false; };
                reader.readAsText(file);
            },
            onRemove: () => { text.value = ''; }
        });
    }
    document.querySelectorAll('[data-memory-zip-form]').forEach((form) => {
        const root = form.querySelector('[data-memory-zip-picker]');
        const error = form.querySelector('[data-memory-zip-error]');
        const meter = OVUpload.progress(form.querySelector('[data-memory-zip-progress]'));
        let selected = null;
        const picker = OVUpload.picker(root, {
            label: 'Choose an export ZIP', accept: '.zip,application/zip,application/x-zip-compressed', multiple: false,
            onFile: (file, row) => {
                picker.rows.querySelectorAll('.ov-upload__row').forEach((old) => { if (old !== row) { old.dispatchEvent(new Event('remove')); old.remove(); } });
                if (!/\.zip$/i.test(file.name) || !file.size || file.size > maxBytes) {
                    row.dispatchEvent(new Event('remove')); row.remove();
                    error.textContent = !/\.zip$/i.test(file.name) ? 'Choose a ZIP export.' : file.size > maxBytes ? 'That export is larger than 25 MB.' : 'That export is empty.';
                    error.hidden = false; return;
                }
                selected = file; error.hidden = true;
                meter.update({ state: 'waiting', done: 0, total: file.size });
            },
            onRemove: (file) => { if (selected === file) selected = null; meter.update({ state: 'waiting', done: 0, total: 0 }); }
        });
        form.addEventListener('submit', (event) => {
            event.preventDefault();
            if (!selected) { error.textContent = 'Choose a ZIP export to preview.'; error.hidden = false; return; }
            const button = form.querySelector('button[type="submit"]');
            button.disabled = true; error.hidden = true;
            const data = new FormData(form); data.append('file', selected, selected.name);
            const xhr = new XMLHttpRequest(); xhr.open('POST', form.action); xhr.withCredentials = true;
            meter.update({ state: 'sending', done: 0, total: selected.size });
            xhr.upload.onprogress = (e) => { if (e.lengthComputable) meter.update({ state: 'sending', done: Math.min(selected.size, e.loaded), total: selected.size }); };
            xhr.onload = () => {
                if (xhr.status >= 200 && xhr.status < 400) { meter.update({ state: 'done', done: selected.size, total: selected.size }); location.href = xhr.responseURL || form.action; return; }
                const message = 'That export could not be previewed. Try another ZIP file.';
                meter.update({ state: 'failed', message }); error.textContent = message; error.hidden = false; button.disabled = false;
            };
            xhr.onerror = () => { const message = 'The connection stopped. Try again.'; meter.update({ state: 'failed', message }); error.textContent = message; error.hidden = false; button.disabled = false; };
            xhr.send(data);
        });
    });
}());
