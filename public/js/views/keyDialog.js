// Owner key panel: shows which key signs your mandates and lets you back it up or restore it.
import { h, clear, toast } from '../dom.js';
import { createRecoverableKey, restoreKey } from '../keys.js';

const download = (name, obj) => {
  const url = URL.createObjectURL(new Blob([JSON.stringify(obj, null, 2)], { type: 'application/json' }));
  const a = h('a', { href: url, download: name }); document.body.append(a); a.click(); a.remove(); URL.revokeObjectURL(url);
};

export function keyDialog(ctx, onChange) {
  const dlg = h('dialog', {});
  const pass = h('input', { type: 'password', autocomplete: 'new-password', placeholder: 'Backup passphrase (10+ characters)', 'aria-label': 'Backup passphrase' });
  const file = h('input', { type: 'file', accept: 'application/json,.json', 'aria-label': 'Backup file' });
  const msg = h('p', { class: 'muted small', role: 'status' });
  const fail = (e) => { msg.textContent = e.message; };
  const done = async (owner, text) => { ctx.owner = owner; onChange?.(); toast(text); draw(); };

  function draw() {
    const o = ctx.owner;
    clear(dlg,
      h('h2', {}, 'Owner signing key'),
      o ? h('dl', { class: 'kv' },
        h('dt', {}, 'Key ID'), h('dd', { class: 'mono' }, o.fingerprint),
        h('dt', {}, 'Type'), h('dd', {}, o.recoverable ? 'Recoverable (can be backed up)' : 'Non-extractable (most private, no backup possible)'),
        h('dt', {}, 'Stored'), h('dd', {}, o.sessionOnly ? 'This session only (private window)' : 'This browser')) : h('p', {}, 'No key available in this browser.'),
      h('p', { class: 'muted small' }, 'If this browser\'s data is cleared, a key with no backup is gone for good and its mandates can no longer be approved or revoked. Backups are encrypted with your passphrase in this browser; nothing is uploaded.'),
      pass,
      h('div', { class: 'row' },
        o?.recoverable ? h('button', { class: 'primary', type: 'button', onclick: async () => { try { download(`ledgertrue-owner-key-${o.fingerprint}.json`, await o.exportBackup(pass.value)); msg.textContent = 'Backup downloaded. Keep it somewhere safe, and remember the passphrase.'; } catch (e) { fail(e); } } }, 'Download encrypted backup')
          : h('button', { class: 'primary', type: 'button', onclick: async () => {
            if (!confirm('This creates a NEW key. Mandates already signed by your current key stay controlled by the current key. Continue?')) return;
            try { const k = await createRecoverableKey(); download(`ledgertrue-owner-key-${k.fingerprint}.json`, await k.exportBackup(pass.value)); await done(k, 'Recoverable key created and backed up'); } catch (e) { fail(e); }
          } }, 'Create recoverable key + backup')),
      h('hr', {}),
      h('label', { class: 'small' }, 'Restore from a backup file', file),
      h('div', { class: 'row' }, h('button', { type: 'button', onclick: async () => {
        try {
          const f = file.files?.[0]; if (!f) throw new Error('Choose a backup file first.');
          await done(await restoreKey(JSON.parse(await f.text()), pass.value), 'Owner key restored');
        } catch (e) { fail(e); }
      } }, 'Restore key'), h('button', { type: 'button', onclick: () => dlg.close() }, 'Close')),
      msg);
  }
  draw();
  document.body.append(dlg);
  dlg.addEventListener('close', () => dlg.remove());
  dlg.showModal();
}
