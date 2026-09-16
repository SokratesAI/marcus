// The drawing on the form sheet (idea #193). This lives in its own file because
// app.js is a size ratchet that may not grow; it listens to the same clicks
// app.js's delegated listener turns into the glossary and form sheets, and runs
// after it because it is loaded after it.
(function () {
  const box = document.getElementById('termDemo');
  if (!box || !box.querySelectorAll) return;
  const imgs = box.querySelectorAll('.form-demo img');
  if (imgs.length !== 2) return;
  function show(entry) {
    const frames = formDemoFrames(entry);
    box.hidden = frames.length === 0;
    imgs.forEach(function (img, i) {
      if (frames[i]) img.src = frames[i];
      else img.removeAttribute('src');
    });
    imgs[0].alt = frames.length ? 'Drawing of ' + entry.name + ', start and end position' : '';
  }
  document.addEventListener('click', function (ev) {
    const form = ev.target.closest('[data-form]');
    if (form) { show(formGuide(form.dataset.form)); return; }
    if (ev.target.closest('[data-term]')) show(null);
  });
})();
