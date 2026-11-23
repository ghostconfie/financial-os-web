import { useEffect, useState } from 'preact/hooks';
import { backupBytes, backupFileName, readBackup, restoreBackup } from '../lib/backup.js';
import { loadDemo } from '../lib/demo.js';
import { Modal, useApp } from './components.jsx';

export function downloadBytes(bytes, name, type = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet') {
  const blob = new Blob([bytes], { type });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = name;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}

export function saveBackup(db) {
  const name = backupFileName();
  downloadBytes(backupBytes(db), name);
  try { localStorage.setItem('fos.lastBackup', new Date().toISOString()); } catch { /* private mode */ }
  return name;
}

export function BackupDialog({ onClose }) {
  const { fin, toast } = useApp();
  const n = (t) => fin.db.all(t).length;
  return (
    <Modal title="Back up everything to Excel" onClose={onClose} submitLabel="Download backup"
      sub="One Excel file with every workspace, account, transaction, transfer, category, pool, bill and goal. You can open and edit it in Excel, and restore it into any copy of Emperio Finances to get everything back exactly."
      onSubmit={() => { const name = saveBackup(fin.db); toast(`Saved ${name}`); }}>
      <div class="strip small">
        {fin.workspaces().length} workspaces · {n('bank_accounts')} accounts · {n('transactions')} transactions · {n('transfers')} transfers ·
        {' '}{n('categories')} categories · {n('budget_pools')} pools · {n('bills')} bills · {n('budget_goals')} goals
      </div>
      <p class="small muted">Tip: keep the file somewhere safe like OneDrive or Google Drive. It has all your financial data in it.</p>
    </Modal>
  );
}

export function RestoreDialog({ onClose, file: initial }) {
  const { fin, toast, setWs } = useApp();
  const [file, setFile] = useState(initial || null);
  const [res, setRes] = useState(null);
  const [err, setErr] = useState('');
  const [keepCopy, setKeepCopy] = useState(true);
  useEffect(() => {
    if (!file) return;
    setErr(''); setRes(null);
    file.arrayBuffer().then((buf) => setRes(readBackup(buf))).catch((ex) => setErr(`Couldn't read that file: ${ex.message}`));
  }, [file]);
  const hasData = fin.db.all('transactions').length > 0;
  return (
    <Modal title="Restore from an Excel backup" danger={hasData} submitLabel="Replace everything with this backup" busy={!res || !res.data.workspaces.length}
      sub="Everything currently in the app is replaced by what's in the backup file. Use this to move to a new device, a new copy of the app, or to undo a mistake."
      onClose={onClose}
      onSubmit={() => {
        if (keepCopy && hasData) saveBackup(fin.db);
        restoreBackup(fin.db, res.data);
        setWs(fin.workspaces()[0]?.id);
        toast('Backup restored');
      }}>
      <input type="file" accept=".xlsx,.xlsm" onChange={(e) => setFile(e.currentTarget.files[0])} />
      {err && <div class="notice rose" style={{ marginTop: 10 }}>{err}</div>}
      {res && (
        <div style={{ marginTop: 12 }}>
          <div class="strip small">{Object.entries(res.counts).map(([k, v]) => `${v} ${k.toLowerCase()}`).join(' · ')}</div>
          {res.problems.length > 0 && (
            <div class="notice" style={{ marginTop: 10 }}>
              <b>{res.problems.length} thing{res.problems.length === 1 ? '' : 's'} to know:</b>
              <ul style={{ margin: '6px 0 0', paddingLeft: 18 }}>{res.problems.slice(0, 12).map((p) => <li key={p}>{p}</li>)}</ul>
            </div>
          )}
          {hasData && <label class="check small" style={{ marginTop: 10 }}><input type="checkbox" checked={keepCopy} onChange={(e) => setKeepCopy(e.currentTarget.checked)} />Download a backup of what's in the app now, first (recommended)</label>}
        </div>
      )}
    </Modal>
  );
}

export function SettingsDialog({ onClose }) {
  const { fin, sync, theme, setTheme, toast, open, setWs } = useApp();
  const [notif, setNotif] = useState(typeof Notification !== 'undefined' ? Notification.permission : 'unsupported');
  let last = null;
  try { last = localStorage.getItem('fos.lastBackup'); } catch { /* ignore */ }
  return (
    <Modal title="Settings" onClose={onClose} noSubmit>
      <div class="col" style={{ gap: 14 }}>
        <div class="strip">
          <div class="eyebrow">Your data</div>
          {sync.mode === 'cloud'
            ? <div style={{ marginTop: 4 }}>Signed in as <b>{sync.email}</b>. Saved to your Firebase cloud and kept in sync on every device you sign in on. Works offline too: changes upload when you're back online.</div>
            : <div style={{ marginTop: 4 }}>Saved in this browser only (cloud sync isn't set up in this copy of the app). Make Excel backups so you never lose it.</div>}
          <div class="small muted" style={{ marginTop: 6 }}>{sync.label}</div>
          <div class="row wrap" style={{ marginTop: 8 }}>
            {sync.mode === 'cloud' && <button type="button" class="btn sm" onClick={async () => { toast('Re-downloading everything…'); await sync.resync(); toast('Up to date'); }}>Re-sync everything</button>}
            {sync.mode === 'cloud' && <button type="button" class="btn sm" onClick={() => sync.signOut()}>Sign out</button>}
          </div>
        </div>
        <div class="strip">
          <div class="eyebrow">Excel backup</div>
          <div class="small" style={{ marginTop: 4 }}>{last ? `Last backup downloaded on this device: ${new Date(last).toLocaleString('en-GB', { timeZone: 'Europe/London' })}` : 'No backup downloaded on this device yet.'}</div>
          <div class="row wrap" style={{ marginTop: 8 }}>
            <button type="button" class="btn sm primary" onClick={() => { onClose(); open('backup', {}); }}>Back up to Excel</button>
            <button type="button" class="btn sm" onClick={() => { onClose(); open('restore', {}); }}>Restore from backup</button>
          </div>
        </div>
        <div class="strip row wrap">
          <div class="grow"><div class="eyebrow">Theme</div><div class="small muted">Light is the default.</div></div>
          <div class="seg">
            {[['light', 'Light'], ['dark', 'Dark'], ['auto', 'Match device']].map(([v, l]) => <button type="button" key={v} class={theme === v ? 'on' : ''} onClick={() => setTheme(v)}>{l}</button>)}
          </div>
        </div>
        <div class="strip row wrap">
          <div class="grow"><div class="eyebrow">Bill reminders</div>
            <div class="small muted">{notif === 'granted' ? 'Notifications are on for this device.' : notif === 'denied' ? 'Notifications are blocked in this browser’s settings. Reminders still show inside the app.' : notif === 'unsupported' ? 'This browser can’t show notifications. Reminders show inside the app.' : 'Allow notifications to get a pop-up when a bill is due.'}</div></div>
          {notif === 'default' && <button type="button" class="btn sm" onClick={async () => setNotif(await Notification.requestPermission())}>Allow notifications</button>}
        </div>
        <div class="strip row wrap">
          <div class="grow"><div class="eyebrow">Demo data</div><div class="small muted">Fills the Personal workspace with three months of example data, to see how everything works.</div></div>
          <button type="button" class="btn sm" onClick={() => open('confirm', {
            title: 'Load demo data?', body: 'This adds example accounts, pools and about 3 months of transactions to your Personal workspace. Only do this in an empty app.', label: 'Load demo data', danger: false,
            action: () => { const id = loadDemo(fin); setWs(id); toast('Demo data loaded'); onClose(); },
          })}>Load demo data</button>
        </div>
        <div class="small faint">Emperio Finances v{__APP_VERSION__}</div>
      </div>
    </Modal>
  );
}
