import { useMemo, useState } from 'preact/hooks';
import * as imp from '../lib/importer.js';
import { isBackup } from '../lib/backup.js';
import { fmtDate, fmtMoney } from '../lib/util.js';
import { Modal, Pill, Select, useApp } from './components.jsx';

const STATUS = { new: ['New', 'emerald'], review: ['Review', 'amber'], duplicate: ['Duplicate', ''], error: ['Error', 'rose'] };

function describe(r) {
  const d = r.data;
  switch (r.section) {
    case 'transactions': return `${fmtDate(d.date) || '?'} · ${d.type} · ${d.category} · ${d.amount === null ? '?' : fmtMoney(d.amount)}${d.description ? ` · ${d.description}` : ''}${d.bankAccount ? ` · ${d.bankAccount}` : ''}`;
    case 'dla': return `${fmtDate(d.date) || '?'} · ${d.businessWorkspace || '?'} · ${d.amount === null ? '?' : fmtMoney(d.amount)} · ${d.description}`;
    case 'transfers': return `${fmtDate(d.date) || '?'} · ${d.fromAccount} → ${d.toAccount} · ${fmtMoney(d.amount)}`;
    case 'balances': return `${d.name} · ${d.balance === null ? '?' : fmtMoney(d.balance)}`;
    case 'goals': return `${d.category} · ${d.amount === null ? '?' : fmtMoney(d.amount)} · ${d.type}`;
    case 'bills': return `${d.billName} · day ${d.dueDay ?? '?'} · ${fmtMoney(d.amount)}${d.bankAccount ? ` · ${d.bankAccount}` : ''}`;
    case 'pools': return `${d.icon} ${d.name} · ${d.mode} ${d.mode === 'percent' ? `${d.value}%` : fmtMoney(d.value)}${d.isDefault ? ' · default' : ''}`;
    case 'pool_lines': return `${d.pool} · ${d.category} · ${fmtMoney(d.allocated)}`;
    case 'pool_transfers': return `${fmtDate(d.date) || ''} · ${d.fromPool} → ${d.toPool} · ${fmtMoney(d.amount)}`;
    default: return JSON.stringify(d);
  }
}

export function ImportDialog({ onClose }) {
  const { fin, ws: curWs, setWs, open, toast } = useApp();
  const [file, setFile] = useState(null);
  const [tables, setTables] = useState([]);
  const [meta, setMeta] = useState({});
  const [target, setTarget] = useState(curWs);
  const [rev, setRev] = useState(0);
  const [err, setErr] = useState('');
  const [backup, setBackup] = useState(false);
  const [mapEdit, setMapEdit] = useState(null);
  const [busy, setBusy] = useState(false);
  const [excluded, setExcluded] = useState({}); // row key -> include override

  const rows = useMemo(() => (tables.length ? imp.buildRows(fin, target, tables) : []), [tables, target, rev]);
  rows.forEach((r, i) => { const k = `${r.table}:${i}`; if (k in excluded) r.include = excluded[k]; });

  const pick = async (f) => {
    setErr(''); setBackup(false); setTables([]); setExcluded({});
    if (!f) return;
    setFile(f);
    try {
      const buf = await f.arrayBuffer();
      if (/\.xls[xm]?$/i.test(f.name) && isBackup(buf)) setBackup(true);
      const [t, m] = imp.detectFile(f.name, buf);
      setTables(t); setMeta(m);
      if (!t.length) setErr("I couldn't find any tables in this file. Check it has a header row with columns like Date and Amount.");
      const w = m.workspaceName && fin.workspaces().find((x) => x.name.toLowerCase() === m.workspaceName.toLowerCase());
      if (w) setTarget(w.id);
    } catch (ex) {
      console.error(ex);
      setErr(`Couldn't read that file: ${ex.message}`);
    }
  };

  const counts = {};
  for (const r of rows) {
    const c = (counts[r.section] ||= { total: 0, inc: 0, new: 0, review: 0, duplicate: 0, error: 0 });
    c.total++; c[r.status]++; if (r.include) c.inc++;
  }
  const included = rows.filter((r) => r.include && r.status !== 'error').length;
  const tick = (status, on) => {
    const n = { ...excluded };
    rows.forEach((r, i) => { if (r.status === status) n[`${r.table}:${i}`] = on; });
    setExcluded(n);
  };
  const wsMissing = meta.workspaceName && !fin.workspaces().some((w) => w.name.toLowerCase() === meta.workspaceName.toLowerCase());

  const run = () => {
    setBusy(true);
    try {
      const c = imp.importRows(fin, target, rows);
      const parts = Object.entries(c).filter(([, v]) => v).map(([k, v]) => `${v} ${imp.SECTION_TITLES[k].toLowerCase()}`);
      toast(parts.length ? `Imported ${parts.join(', ')}` : 'Nothing to import');
      if (target !== curWs) setWs(target);
      onClose();
    } catch (ex) {
      console.error(ex);
      fin.db.rollback();
      setErr(ex.message);
    } finally { setBusy(false); }
  };

  const shown = {};
  return (
    <Modal wide title="Import a spreadsheet or bank statement" onClose={onClose}
      sub="Any CSV or Excel file works. Every sheet is scanned and each table is recognised from its title, sheet name, headers or contents. You can change anything below before importing."
      footer={tables.length ? <>
        <button type="button" class="btn ghost sm" onClick={() => tick('review', true)}>Tick all review rows</button>
        <button type="button" class="btn ghost sm" onClick={() => tick('duplicate', true)}>Tick duplicates too</button>
        <button type="button" class="btn primary" disabled={!included || busy} onClick={run}>{busy ? 'Importing…' : `Import ${included} row${included === 1 ? '' : 's'}`}</button>
      </> : null}>
      <div class="row wrap" style={{ marginBottom: 12 }}>
        <input type="file" accept=".csv,.tsv,.tab,.txt,.xlsx,.xlsm,.xlsb,.xltx,.xltm,.xls,.ods,.fods,text/csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,application/vnd.ms-excel"
          onChange={(e) => pick(e.currentTarget.files[0])} style={{ flex: '2 1 260px' }} />
        <span class="muted">into</span>
        <div style={{ flex: '1 1 200px' }}><Select value={target} onChange={setTarget} options={fin.workspaces().map((w) => [w.id, w.name])} /></div>
      </div>
      {err && <div class="notice rose" style={{ marginBottom: 10 }}>{err}</div>}
      {backup && (
        <div class="notice neutral row wrap" style={{ marginBottom: 10 }}>
          <span class="grow">This is an Emperio Finances backup file. To bring back everything exactly as it was, restore it instead of importing.</span>
          <button type="button" class="btn sm primary" onClick={() => { onClose(); open('restore', { file }); }}>Restore backup instead</button>
        </div>
      )}
      {wsMissing && (
        <div class="notice row wrap" style={{ marginBottom: 10 }}>
          <span class="grow">This file is for the workspace “{meta.workspaceName}”, which doesn't exist yet.</span>
          <button type="button" class="btn sm primary" onClick={() => { const w = fin.createWorkspace(meta.workspaceName, 'business'); setTarget(w.id); setRev(rev + 1); }}>Create “{meta.workspaceName}”</button>
        </div>
      )}
      {tables.length > 0 && <>
        <h3 style={{ marginBottom: 6 }}>What I found</h3>
        <div class="tablewrap" style={{ marginBottom: 12 }}>
          <table class="t">
            <thead><tr><th>Table</th><th class="money">Rows</th><th>Import as</th><th class="hide-sm">Columns used</th><th /></tr></thead>
            <tbody>
              {tables.map((t, ti) => (
                <tr key={ti}>
                  <td>{t.label}<div class="small muted">{t.reason}</div></td>
                  <td class="money">{t.body.length}</td>
                  <td style={{ minWidth: 170 }}>
                    <Select value={t.section} onChange={(v) => { imp.remap(t, v); setExcluded({}); setRev(rev + 1); }}
                      options={Object.entries(imp.SECTION_TITLES).map(([k, l]) => [k, l])} />
                  </td>
                  <td class="hide-sm small muted">{Object.entries(t.mapping).map(([f, i]) => `${imp.FIELD_LABELS[f] || f} ← ${imp.colLetter(i)}`).join(', ') || '—'}</td>
                  <td class="right">{t.section !== 'skip' && <button type="button" class="btn sm" onClick={() => setMapEdit(mapEdit === ti ? null : ti)}>Columns…</button>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {mapEdit !== null && tables[mapEdit] && (() => {
          const t = tables[mapEdit];
          const cols = t.columns();
          return (
            <div class="card flat" style={{ marginBottom: 12 }}>
              <div class="row" style={{ marginBottom: 8 }}><h3 class="grow">Which column feeds each field? · {t.label}</h3><button type="button" class="btn sm" onClick={() => setMapEdit(null)}>Done</button></div>
              <div class="grid c3">
                {Object.keys(imp.FIELDS[t.section]).map((f) => (
                  <label class="field" key={f}><span>{imp.FIELD_LABELS[f] || f}</span>
                    <Select value={f in t.mapping ? String(t.mapping[f]) : null} onChange={(v) => {
                      const m = { ...t.mapping };
                      if (v === null) delete m[f]; else m[f] = +v;
                      t.mapping = m; t.reason = 'columns chosen by you'; setExcluded({}); setRev(rev + 1);
                    }} options={[[null, '— not used —'], ...cols.map((c, i) => [String(i), c])]} />
                  </label>
                ))}
              </div>
              {t.section === 'transactions' && (
                <label class="row small" style={{ gap: 8, marginTop: 10 }}>
                  <input type="checkbox" style={{ width: 'auto' }} checked={!!t.flip} onChange={(e) => { t.flip = e.currentTarget.checked; setExcluded({}); setRev(rev + 1); }} />
                  Spending shows as plus and income as minus in this file (common in credit card exports) — swap them
                </label>
              )}
            </div>
          );
        })()}
        <div class="row wrap" style={{ gap: 6, marginBottom: 8 }}>
          {Object.entries(counts).map(([s, c]) => (
            <span class="pill" key={s}>{imp.SECTION_TITLES[s]}: {c.inc} of {c.total} ticked{c.review ? ` · ${c.review} to review` : ''}{c.duplicate ? ` · ${c.duplicate} duplicate` : ''}{c.error ? ` · ${c.error} unreadable` : ''}</span>
          ))}
        </div>
        <div class="tablewrap" style={{ maxHeight: 380, overflowY: 'auto' }}>
          <table class="t">
            <thead><tr><th class="chk" /><th>Item</th><th>Status</th><th class="hide-sm">Notes</th></tr></thead>
            <tbody>
              {rows.map((r, i) => {
                shown[r.section] = (shown[r.section] || 0) + 1;
                if (shown[r.section] > 400) return null;
                const k = `${r.table}:${i}`;
                const [label, tone] = STATUS[r.status];
                return (
                  <tr key={k}>
                    <td class="chk"><input type="checkbox" disabled={r.status === 'error'} checked={r.include} onChange={(e) => setExcluded({ ...excluded, [k]: e.currentTarget.checked })} /></td>
                    <td><span class="small muted">{imp.SECTION_TITLES[r.section]}</span> · {describe(r)}</td>
                    <td><Pill tone={tone}>{label}</Pill></td>
                    <td class="hide-sm small muted">{r.reasons.join('; ')}</td>
                  </tr>
                );
              })}
              {!rows.length && <tr><td colSpan={4} class="empty">Nothing to import. Change “Import as” above for a table, or pick its columns.</td></tr>}
            </tbody>
          </table>
        </div>
        {Object.values(shown).some((n) => n > 400) && <div class="small muted" style={{ marginTop: 6 }}>Showing the first 400 rows of each kind; all ticked rows are imported.</div>}
      </>}
    </Modal>
  );
}
