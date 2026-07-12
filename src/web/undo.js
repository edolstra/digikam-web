// ===== Undo ==================================================================
// A session-only stack of reversible operations — nothing server-side, nothing
// persisted (a reload forgets it). Any code that performs a mutating operation
// pushes an op via pushUndo({label, undo}): `label` is a short human-readable
// description ("rating of img_1.jpg 3★ → 5★") shown in the confirmation toast,
// and `undo()` reverses the operation, returning a Promise (reversal is itself
// an async server call). The manager is generic — it knows nothing about what
// the ops do — so future operations (tag edits, moves, …) just push their own.
var undoStack = [];
function pushUndo(op) { undoStack.push(op); }

// Pop the most recent operation and reverse it. A failed reversal (e.g. the
// server now runs without --allow-writes) puts the op back so `u` can retry.
function undoLast() {
  var op = undoStack.pop();
  if (!op) { toast('Nothing to undo'); return; }
  op.undo().then(function () {
    toast('Undone: ' + op.label);
  }, function () {
    undoStack.push(op);
    toast('Undo failed: ' + op.label, true);
  });
}

// Transient bottom-center notification (also the rating-change confirmation).
// A single fixed-position element over everything incl. the lightbox; `failed`
// renders it red. While an element is fullscreen (the lightbox), the browser
// paints only its descendants — so the toast is (re)hosted inside the current
// fullscreen element instead of `body`, or it would be invisible there.
var toastEl = null, toastTimer = 0;
function toast(text, failed) {
  if (!toastEl) {
    toastEl = document.createElement('div');
    toastEl.id = 'toast';
  }
  var host = document.fullscreenElement || document.body;
  if (toastEl.parentNode !== host) host.appendChild(toastEl);
  toastEl.textContent = text;
  toastEl.classList.toggle('failed', !!failed);
  toastEl.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(function () { toastEl.classList.remove('show'); }, 1500);
}

// `u` undoes the last operation — anywhere in the SPA, lightbox open or not
// (ops can outlive the view that created them) — but not while typing in a
// field (the tags filter input) and not as part of a modifier combo.
document.addEventListener('keydown', function (e) {
  if (e.key !== 'u' && e.key !== 'U') return;
  if (e.ctrlKey || e.altKey || e.metaKey) return;
  if (e.target.closest && e.target.closest('input, textarea, select')) return;
  e.preventDefault();
  undoLast();
});
