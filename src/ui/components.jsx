import { createContext } from 'preact';
import { useContext, useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { TX_TYPES, fmtMoney, todayStr } from '../lib/util.js';

export const Ctx = createContext(null);
export const useApp = () => useContext(Ctx);

export function Money({ v, signed = false, tone = false, class: cls = '' }) {
  const t = tone ? (v < -0.004 ? 'neg' : v > 0.004 ? 'pos' : '') : '';
  return <span class={`money ${t} ${cls}`}>{fmtMoney(v, signed)}</span>;
}

export function Pill({ tone = '', children }) {
  return <span class={`pill ${tone}`}>{children}</span>;
}

export function Bar({ pct, color }) {
  const p = Math.max(0, Math.min(100, pct || 0));
  const c = color || (pct > 100 ? 'var(--rose)' : pct >= 90 ? 'var(--amber)' : 'var(--emerald)');
  return <div class="bar"><i style={{ width: `${p}%`, background: c }} /></div>;
}

export function Stat({ label, value, sub, money = true, cls = '', tone = false, children }) {
  return (
    <div class={`stat ${cls}`}>
      <div class="eyebrow">{label}</div>
      <div class="v">{money ? <Money v={value} tone={tone} /> : value}</div>
      {sub && <div class="s">{sub}</div>}
      {children}
    </div>
  );
}

export function Field({ label, children, class: cls = '' }) {
  return <label class={`field ${cls}`}><span>{label}</span>{children}</label>;
}

export function MoneyInput({ value, onInput, autoFocus, placeholder = '0.00' }) {
  return (
    <input type="number" inputMode="decimal" step="0.01" min="0" class="money-input" value={value === 0 || value ? value : ''}
      placeholder={placeholder} autoFocus={autoFocus}
      onInput={(e) => onInput(e.currentTarget.value === '' ? '' : e.currentTarget.value)} />
  );
}

export function Select({ value, onChange, options, class: cls = '' }) {
  // options: [[value, label]] ; value may be null
  return (
    <select class={cls} value={value ?? ''} onChange={(e) => {
      const v = e.currentTarget.value;
      onChange(v === '' ? null : v);
    }}>
      {options.map(([v, l]) => <option value={v ?? ''} key={v ?? '__'}>{l}</option>)}
    </select>
  );
}

export function Seg({ value, onChange, options }) {
  return (
    <div class="seg">
      {options.map(([v, l]) => <button type="button" class={v === value ? 'on' : ''} onClick={() => onChange(v)} key={String(v)}>{l}</button>)}
    </div>
  );
}

export function DateInput({ value, onInput }) {
  return <input type="date" value={value || todayStr()} onInput={(e) => onInput(e.currentTarget.value)} />;
}

export function Empty({ children }) { return <div class="empty">{children}</div>; }

/** Modal shell. `onSubmit` may throw (FinanceError) — the message is shown in the footer. */
export function Modal({ title, sub, onClose, onSubmit, submitLabel = 'Save', danger = false, wide = false, children, footer, busy = false, noSubmit = false }) {
  const [err, setErr] = useState('');
  const [working, setWorking] = useState(false);
  useEffect(() => {
    const k = (e) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', k);
    return () => window.removeEventListener('keydown', k);
  }, []);
  const submit = async (e) => {
    e?.preventDefault();
    if (!onSubmit) return;
    setErr('');
    setWorking(true);
    try {
      const r = await onSubmit();
      if (r !== false) onClose();
    } catch (ex) {
      console.error(ex);
      setErr(ex.message || String(ex));
    } finally {
      setWorking(false);
    }
  };
  return (
    <div class="overlay" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <form class={`modal ${wide ? 'wide' : ''}`} onSubmit={submit}>
        <div class="mh">
          <div class="grow">
            <h2>{title}</h2>
            {sub && <div class="muted small" style={{ marginTop: 4 }}>{sub}</div>}
          </div>
          <button type="button" class="iconbtn" aria-label="Close" onClick={onClose}>✕</button>
        </div>
        <div class="mb">{children}</div>
        <div class="mf">
          {err && <div class="err">{err}</div>}
          {footer}
          <button type="button" class="btn ghost" onClick={onClose}>{noSubmit ? 'Close' : 'Cancel'}</button>
          {!noSubmit && onSubmit && (
            <button type="submit" class={`btn ${danger ? 'danger solid' : 'primary'}`} disabled={working || busy}>{working ? 'Working…' : submitLabel}</button>
          )}
        </div>
      </form>
    </div>
  );
}

/** Pick-from-a-list category chooser, grouped by type, with "+ New category…". */
export function CategoryPicker({ value, onChange, type = 'Expense', includeIncome = true, onNew }) {
  const { fin, ws } = useApp();
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState('');
  const ref = useRef();
  const cats = fin.categories(ws);
  const pools = Object.fromEntries(fin.pools(ws).map((p) => [p.id, p]));
  const cur = cats.find((c) => c.name.toLowerCase() === (value || '').toLowerCase());
  useEffect(() => {
    if (!open) return;
    const h = (e) => { if (ref.current && !ref.current.contains(e.target)) setOpen(false); };
    document.addEventListener('mousedown', h);
    return () => document.removeEventListener('mousedown', h);
  }, [open]);
  const groups = useMemo(() => {
    const order = [type, ...TX_TYPES.filter((t) => t !== type)].filter((t) => includeIncome || t !== 'Income');
    const ql = q.trim().toLowerCase();
    return order.map((t) => [t, cats.filter((c) => c.defaultType === t && (!ql || c.name.toLowerCase().includes(ql)))]).filter(([, l]) => l.length);
  }, [cats.length, type, q, includeIncome]);
  return (
    <div ref={ref} style={{ position: 'relative' }}>
      <button type="button" class="pickbtn" onClick={() => setOpen(!open)}>
        {cur ? <><span class="swatch" style={{ background: cur.color }} /><span class="grow">{cur.name}</span>
          <span class="muted small">{cur.poolId && pools[cur.poolId] ? `${pools[cur.poolId].icon} ${pools[cur.poolId].name}` : 'Unpooled'}</span></>
          : <span class="muted grow">{value || 'Choose a category…'}</span>}
        <span class="muted">▾</span>
      </button>
      {open && (
        <div style={{ marginTop: 4, background: 'var(--card)', borderRadius: 10, boxShadow: '0 6px 24px rgba(0,0,0,.12)' }}>
          <input type="search" placeholder="Search categories…" value={q} autoFocus onInput={(e) => setQ(e.currentTarget.value)} style={{ borderRadius: '10px 10px 0 0' }} />
          <div class="picker" style={{ borderRadius: '0 0 10px 10px', borderTop: 0 }}>
            {groups.map(([t, list]) => (
              <div key={t}>
                <div class="grp">{t}</div>
                {list.map((c) => (
                  <div class={`opt ${cur && cur.id === c.id ? 'on' : ''}`} key={c.id} onClick={() => { onChange(c.name, c); setOpen(false); setQ(''); }}>
                    <span class="swatch" style={{ background: c.color }} />{c.name}
                    <span class="pp">{c.poolId && pools[c.poolId] ? `${pools[c.poolId].icon} ${pools[c.poolId].name}` : 'Unpooled'}</span>
                  </div>
                ))}
              </div>
            ))}
            {!groups.length && <div class="opt muted">No matches.</div>}
            {onNew && <div class="opt" style={{ fontWeight: 600 }} onClick={() => { setOpen(false); onNew(q.trim()); setQ(''); }}>＋ New category{q.trim() ? ` “${q.trim()}”` : '…'}</div>}
          </div>
        </div>
      )}
    </div>
  );
}

/** Small SVG area chart of [date, value] pairs. */
export function Sparkline({ data, height = 120 }) {
  if (!data.length) return null;
  const w = 320, h = height, pad = 4;
  const vals = data.map((d) => d[1]);
  let min = Math.min(...vals), max = Math.max(...vals);
  if (max - min < 1) { max += 1; min -= 1; }
  const x = (i) => pad + (i / Math.max(1, data.length - 1)) * (w - pad * 2);
  const y = (v) => pad + (1 - (v - min) / (max - min)) * (h - pad * 2);
  const line = data.map((d, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(d[1]).toFixed(1)}`).join(' ');
  const area = `${line} L${x(data.length - 1).toFixed(1)},${h} L${x(0).toFixed(1)},${h} Z`;
  return (
    <svg viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="none" style={{ width: '100%', height }} role="img" aria-label="Balance over the last 30 days">
      <path d={area} fill="var(--chart-fill)" />
      <path d={line} fill="none" stroke="var(--chart)" stroke-width="2" vector-effect="non-scaling-stroke" />
      <circle cx={x(data.length - 1)} cy={y(vals[vals.length - 1])} r="3.5" fill="var(--chart)" />
    </svg>
  );
}

export function Donut({ items, size = 128, center, sub }) {
  const total = items.reduce((s, i) => s + i[1], 0);
  const r = 52, c = 2 * Math.PI * r;
  let off = 0;
  return (
    <svg width={size} height={size} viewBox="0 0 128 128" role="img" aria-label="Spending by category" style={{ flex: 'none' }}>
      <circle cx="64" cy="64" r={r} fill="none" stroke="var(--card2)" stroke-width="14" />
      {total > 0 && items.map(([n, v, col]) => {
        const len = (v / total) * c;
        const el = <circle key={n} cx="64" cy="64" r={r} fill="none" stroke={col} stroke-width="14" stroke-dasharray={`${Math.max(0, len - 1.5)} ${c}`} stroke-dashoffset={-off} transform="rotate(-90 64 64)" />;
        off += len;
        return el;
      })}
      <text x="64" y="62" text-anchor="middle" font-family="var(--mono)" font-size="15" font-weight="700" fill="var(--text)">{center}</text>
      <text x="64" y="80" text-anchor="middle" font-size="9.5" fill="var(--muted)">{sub}</text>
    </svg>
  );
}

export function useDebounced(value, ms = 200) {
  const [v, setV] = useState(value);
  useEffect(() => { const t = setTimeout(() => setV(value), ms); return () => clearTimeout(t); }, [value]);
  return v;
}

// Simple line icons (stroke uses the current text colour).
const ICONS = {
  plus: 'M12 5v14M5 12h14',
  transfer: 'M7 7h11l-3-3M17 17H6l3 3',
  pool: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM12 16a4 4 0 1 0 0-8 4 4 0 0 0 0 8z',
  upload: 'M12 15V4M7.5 8.5 12 4l4.5 4.5M5 15v3a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-3',
  home: 'M4 10.5 12 4l8 6.5V19a1 1 0 0 1-1 1h-4.5v-5h-5v5H5a1 1 0 0 1-1-1z',
  list: 'M8 7h12M8 12h12M8 17h12M4 7h.01M4 12h.01M4 17h.01',
  bank: 'M3 9.5 12 4l9 5.5M5 10v7M9.5 10v7M14.5 10v7M19 10v7M3.5 20h17',
  bill: 'M6 3h12v18l-3-2-3 2-3-2-3 2zM9 8h6M9 12h6M9 16h3',
  more: 'M5 12h.01M12 12h.01M19 12h.01',
  menu: 'M4 7h16M4 12h16M4 17h16',
  search: 'M11 18a7 7 0 1 0 0-14 7 7 0 0 0 0 14zM20 20l-4-4',
  filter: 'M4 6h16M7 12h10M10 18h4',
};
export function Icon({ name, size }) {
  return <svg class="ic" viewBox="0 0 24 24" aria-hidden="true" style={size ? { width: size, height: size } : undefined}><path d={ICONS[name]} /></svg>;
}

/** Round coloured circle with the first letter of a name (stands in for a logo). */
export function Avatar({ name, color, small }) {
  const ch = (String(name || '?').trim().match(/[A-Za-z0-9]/) || ['£'])[0].toUpperCase();
  return <span class={`avatar ${small ? 'sm' : ''}`} style={{ background: color || '#6b7280' }}>{ch}</span>;
}

/** A transaction as a rounded row: avatar, description, details and a green/red amount. */
export function TxRow({ t, color, sub, onClick, selected, children }) {
  return (
    <div class={`txrow ${selected ? 'sel' : ''}`} onClick={onClick}>
      {children}
      <Avatar name={t.description || t.category} color={color} />
      <div class="grow">
        <div class="t1">{t.description || t.category}</div>
        <div class="t2">{sub}</div>
      </div>
      <span class={`money amt ${t.amount < -0.004 ? 'neg' : t.amount > 0.004 ? 'pos' : ''}`}>{fmtMoney(t.amount, true)}</span>
    </div>
  );
}

/** Category name → colour, for avatars. */
export function useCatColors() {
  const { fin, ws, version } = useApp();
  return useMemo(() => Object.fromEntries(fin.categories(ws).map((c) => [c.name.toLowerCase(), c.color])), [version, ws]);
}
