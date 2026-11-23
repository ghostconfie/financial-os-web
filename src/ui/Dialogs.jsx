import { useState } from 'preact/hooks';
import { FinanceError, PALETTE, POOL_ICONS } from '../lib/finance.js';
import { TX_TYPES, fmtMoney, round2, todayStr } from '../lib/util.js';
import { CategoryPicker, DateInput, Field, Modal, MoneyInput, Seg, Select, useApp } from './components.jsx';

const num = (v) => (v === '' || v === null || v === undefined ? 0 : parseFloat(v) || 0);

// ================================================================ Quick Add
export function QuickAdd({ onClose, mode = 'tx', prefill = {}, wsOverride, personal }) {
  const app = useApp();
  const { fin, month, open } = app;
  const ws = wsOverride || (personal ? (fin.workspaces().find((w) => w.kind === 'personal') || {}).id : null) || app.ws;
  const editing = prefill.id;
  const [tab, setTab] = useState(mode);
  const accounts = fin.accountNames(ws);
  const pools = fin.pools(ws);
  // transaction
  const firstCat = prefill.category || '';
  const [t, setT] = useState({
    date: prefill.date || todayStr(), type: prefill.type || 'Expense', category: firstCat,
    bankAccount: prefill.bankAccount || accounts[0] || '', poolId: prefill.poolId || (firstCat ? fin.categoryByName(ws, firstCat)?.poolId : null) || null,
    amount: prefill.amount ? Math.abs(prefill.amount) : '', description: prefill.description || '',
    isBusinessPayment: !!prefill.isBusinessPayment, businessWorkspaceId: prefill.businessWorkspaceId || fin.businessWorkspaces()[0]?.id || null,
    businessCategory: prefill.businessCategory || '', dlaNotes: prefill.dlaNotes || '',
  });
  const st = (k, v) => setT((o) => ({ ...o, [k]: v }));
  const pickCat = (name, c) => {
    const next = { ...t, category: name };
    if (c) {
      next.poolId = c.poolId || null;
      if (t.type === 'Expense' && c.defaultType !== 'Expense' && !editing) next.type = c.defaultType;
      if (c.bankAccount && c.bankAccount !== 'ALL' && accounts.includes(c.bankAccount)) next.bankAccount = c.bankAccount;
    }
    setT(next);
  };
  // transfer
  const other = accounts.find((n) => n !== (prefill.fromAccount || accounts[0]));
  const [x, setX] = useState({
    fromAccount: prefill.fromAccount || accounts[0] || '', toAccount: prefill.toAccount || other || '',
    amount: prefill.amount || '', date: prefill.date || todayStr(), notes: prefill.notes || '',
  });
  const sx = (k, v) => setX((o) => ({ ...o, [k]: v }));
  // reallocation
  const [r, setR] = useState({ kind: prefill.kind || 'category', fromId: prefill.fromId || null, toId: prefill.toId || null, amount: '', note: '' });
  const sr = (k, v) => setR((o) => ({ ...o, [k]: v }));
  const cats = fin.categories(ws).filter((c) => c.defaultType !== 'Income');
  const poolNames = Object.fromEntries(pools.map((p) => [p.id, p.name]));
  const rOpts = r.kind === 'category'
    ? cats.map((c) => [c.id, `${c.name} · ${poolNames[c.poolId] || 'Unpooled'}`])
    : pools.map((p) => [p.id, `${p.icon} ${p.name}`]);
  const rFrom = r.fromId && rOpts.some((o) => o[0] === r.fromId) ? r.fromId : rOpts[0]?.[0];
  const rTo = r.toId && rOpts.some((o) => o[0] === r.toId) ? r.toId : rOpts.find((o) => o[0] !== rFrom)?.[0];
  let avail = '';
  if (rFrom) {
    if (r.kind === 'category') { const c = fin.db.get('categories', rFrom); avail = c ? `Available in line: ${fmtMoney(c.allocated)}` : ''; }
    else { const m = fin.poolMetrics(ws, month).find((p) => p.id === rFrom); avail = m ? `Pool budget ${fmtMoney(m.allocatedBudget)} · unassigned ${fmtMoney(m.unassigned)}` : ''; }
  }

  const submit = () => {
    if (tab === 'tx') {
      if (!t.category) throw new FinanceError('Choose a category from the list (or pick “+ New category…”).');
      if (!(num(t.amount) > 0)) throw new FinanceError('Amount must be more than £0.00.');
      if (!t.bankAccount) throw new FinanceError('Add a bank account first.');
      if (t.isBusinessPayment && !t.businessWorkspaceId) throw new FinanceError('Create a Business workspace to tag a DLA payment against.');
      const bw = t.isBusinessPayment ? fin.workspace(t.businessWorkspaceId) : null;
      fin.saveTransaction({
        id: editing || null, workspaceId: ws, date: t.date, type: t.type, category: t.category, bankAccount: t.bankAccount,
        poolId: t.poolId, amount: num(t.amount), description: t.description.trim(), isBusinessPayment: t.isBusinessPayment,
        businessWorkspaceId: bw ? bw.id : null, businessWorkspaceName: bw ? bw.name : null,
        businessCategory: t.isBusinessPayment ? t.businessCategory.trim() : null, dlaNotes: t.isBusinessPayment ? t.dlaNotes.trim() : null,
      });
      app.toast(editing ? 'Transaction updated' : `Saved ${fmtMoney(num(t.amount))} · ${t.category}`);
    } else if (tab === 'transfer') {
      fin.saveTransfer({ id: editing || null, workspaceId: ws, date: x.date, fromAccount: x.fromAccount, toAccount: x.toAccount, amount: num(x.amount), notes: x.notes.trim() });
      app.toast('Transfer saved');
    } else {
      if (r.kind === 'category') fin.categoryTransfer(rFrom, rTo, num(r.amount), r.note.trim());
      else fin.poolTransfer(ws, rFrom, rTo, num(r.amount), r.note.trim());
      app.toast('Reallocated');
    }
  };
  const del = editing && tab !== 'realloc' ? (
    <button type="button" class="btn danger" style={{ marginRight: 'auto' }} onClick={() => {
      if (tab === 'tx') fin.deleteTransactions([editing]); else fin.deleteTransfer(editing);
      app.toast('Deleted'); onClose();
    }}>Delete</button>
  ) : null;
  const wsName = ws !== app.ws ? ` · ${fin.workspace(ws)?.name}` : '';
  return (
    <Modal title={(editing ? 'Edit' : 'Quick add') + wsName} onClose={onClose} onSubmit={submit} footer={del}>
      {!editing && <div style={{ marginBottom: 12 }}><Seg value={tab} onChange={setTab} options={[['tx', 'Transaction'], ['transfer', 'Transfer'], ['realloc', 'Category / pool transfer']]} /></div>}
      {tab === 'tx' && (
        <div class="form two">
          <Field label="Amount"><MoneyInput value={t.amount} onInput={(v) => st('amount', v)} autoFocus={!editing} /></Field>
          <Field label="Date"><DateInput value={t.date} onInput={(v) => st('date', v)} /></Field>
          <Field label="Type"><Select value={t.type} onChange={(v) => st('type', v)} options={TX_TYPES.map((y) => [y, y])} /></Field>
          <Field label="Bank account"><Select value={t.bankAccount} onChange={(v) => st('bankAccount', v)} options={accounts.length ? accounts.map((n) => [n, n]) : [[null, 'No accounts yet']]} /></Field>
          <div class="field full"><span>Category</span>
            <CategoryPicker value={t.category} type={t.type} onChange={pickCat}
              onNew={(name) => open('category', { prefill: { name, defaultType: t.type }, wsOverride: ws, onSaved: (c) => pickCat(c.name, c) })} />
          </div>
          <Field label="Pool"><Select value={t.poolId} onChange={(v) => st('poolId', v)} options={[[null, '— No pool —'], ...pools.map((p) => [p.id, `${p.icon} ${p.name}`])]} /></Field>
          <Field label="Description"><input type="text" value={t.description} placeholder="What was it for?" onInput={(e) => st('description', e.currentTarget.value)} /></Field>
          <label class="check full"><input type="checkbox" checked={t.isBusinessPayment} onChange={(e) => st('isBusinessPayment', e.currentTarget.checked)} />Business payment (Director's Loan Account)</label>
          {t.isBusinessPayment && <>
            <Field label="Business"><Select value={t.businessWorkspaceId} onChange={(v) => st('businessWorkspaceId', v)} options={fin.businessWorkspaces().map((w) => [w.id, w.name])} /></Field>
            <Field label="Business category"><input type="text" value={t.businessCategory} placeholder="e.g. Software, Travel" onInput={(e) => st('businessCategory', e.currentTarget.value)} /></Field>
            <Field label="DLA notes" class="full"><input type="text" value={t.dlaNotes} onInput={(e) => st('dlaNotes', e.currentTarget.value)} /></Field>
          </>}
        </div>
      )}
      {tab === 'transfer' && (
        <div class="form two">
          <Field label="From account"><Select value={x.fromAccount} onChange={(v) => sx('fromAccount', v)} options={accounts.map((n) => [n, n])} /></Field>
          <Field label="To account"><Select value={x.toAccount} onChange={(v) => sx('toAccount', v)} options={accounts.map((n) => [n, n])} /></Field>
          <Field label="Amount"><MoneyInput value={x.amount} onInput={(v) => sx('amount', v)} /></Field>
          <Field label="Date"><DateInput value={x.date} onInput={(v) => sx('date', v)} /></Field>
          <Field label="Notes" class="full"><input type="text" value={x.notes} onInput={(e) => sx('notes', e.currentTarget.value)} /></Field>
          <div class="small muted full">Moves cash between your accounts. It doesn't count as income or spending.</div>
        </div>
      )}
      {tab === 'realloc' && (
        <div class="form">
          <Seg value={r.kind} onChange={(v) => setR({ ...r, kind: v, fromId: null, toId: null })} options={[['category', 'Between categories'], ['pool', 'Between pools']]} />
          <Field label="From"><Select value={rFrom} onChange={(v) => sr('fromId', v)} options={rOpts} /></Field>
          <div class="small muted">{avail}</div>
          <Field label="To"><Select value={rTo} onChange={(v) => sr('toId', v)} options={rOpts} /></Field>
          <Field label="Amount"><MoneyInput value={r.amount} onInput={(v) => sr('amount', v)} /></Field>
          <Field label="Note"><input type="text" value={r.note} onInput={(e) => sr('note', e.currentTarget.value)} /></Field>
        </div>
      )}
    </Modal>
  );
}

// ===================================================================== Pools
export function PoolDialog({ onClose, pool }) {
  const { fin, ws } = useApp();
  const n = fin.pools(ws).length;
  const p = pool || {};
  const [d, setD] = useState({
    name: p.name || '', icon: p.icon || POOL_ICONS[n % POOL_ICONS.length], color: p.color || PALETTE[(n + 1) % PALETTE.length],
    connected: p.isWorkspaceConnected ?? true, mode: ['fixed', 'percent'].includes(p.fundingMode) ? p.fundingMode : 'fixed',
    value: p.fundingValue ?? '', isDefault: !!p.isDefault, description: p.description || '',
  });
  const s = (k, v) => setD((o) => ({ ...o, [k]: v }));
  const pct = d.connected && d.mode === 'percent';
  return (
    <Modal title={pool ? 'Edit pool' : 'New budget pool'} sub="Connected pools are funded from your Money at Hand. Standalone pools have their own target budget." onClose={onClose}
      onSubmit={() => fin.savePool(ws, {
        ...(pool ? { id: pool.id } : {}), name: d.name, icon: d.icon || '💷', color: d.color, isWorkspaceConnected: d.connected,
        fundingMode: d.connected ? d.mode : 'unconnected', fundingValue: num(d.value), isDefault: d.isDefault, description: d.description.trim(),
      })}>
      <div class="form two">
        <Field label="Name" class="full"><input type="text" value={d.name} autoFocus onInput={(e) => s('name', e.currentTarget.value)} /></Field>
        <div class="field"><span>Icon</span>
          <div class="row wrap" style={{ gap: 4 }}>{POOL_ICONS.map((i) => <button type="button" key={i} class={`iconbtn ${d.icon === i ? 'pill dark' : ''}`} style={d.icon === i ? { outline: '2px solid var(--text)' } : {}} onClick={() => s('icon', i)}>{i}</button>)}</div>
        </div>
        <div class="field"><span>Colour</span>
          <div class="row wrap" style={{ gap: 6 }}>
            {PALETTE.map((c) => <button type="button" key={c} aria-label={c} onClick={() => s('color', c)} style={{ width: 24, height: 24, borderRadius: '50%', border: d.color === c ? '3px solid var(--text)' : '1px solid var(--border)', background: c, cursor: 'pointer' }} />)}
            <input type="color" value={d.color} onInput={(e) => s('color', e.currentTarget.value)} style={{ width: 34, height: 28, padding: 0, border: 0, background: 'none' }} />
          </div>
        </div>
        <Field label="Funding" class="full"><Select value={d.connected ? '1' : '0'} onChange={(v) => s('connected', v === '1')} options={[['1', 'Connected: funded from Money at Hand'], ['0', 'Standalone: independent target budget']]} /></Field>
        {d.connected && <Field label="Funding mode"><Select value={d.mode} onChange={(v) => s('mode', v)} options={[['fixed', 'Fixed amount (£)'], ['percent', 'Percent of Money at Hand (%)']]} /></Field>}
        <Field label={pct ? 'Percent of Money at Hand' : 'Target budget (£)'}><MoneyInput value={d.value} onInput={(v) => s('value', v)} /></Field>
        <Field label="Description" class="full"><input type="text" value={d.description} onInput={(e) => s('description', e.currentTarget.value)} /></Field>
        <label class="check full"><input type="checkbox" checked={d.isDefault} onChange={(e) => s('isDefault', e.currentTarget.checked)} />Default pool for new categories</label>
      </div>
    </Modal>
  );
}

export function PushFunds({ onClose, metric }) {
  const { fin, ws, month } = useApp();
  const m = metric;
  const unpooled = fin.header(ws, month).unpooled;
  const [amt, setAmt] = useState('');
  const [exact, setExact] = useState(false);
  const [total, setTotal] = useState(m.allocatedBudget);
  const next = Math.max(exact ? num(total) : m.allocatedBudget + num(amt), m.budgetedLines);
  const warn = m.isWorkspaceConnected && next - m.allocatedBudget > unpooled + 0.004;
  return (
    <Modal title={`${m.isWorkspaceConnected ? 'Push funds into' : 'Raise target for'} ${m.icon} ${m.name}`}
      sub={m.isWorkspaceConnected ? 'Move unallocated Money at Hand into this pool.' : 'Standalone pool: raise its independent target budget.'}
      onClose={onClose} submitLabel={exact ? 'Set budget' : 'Push funds'}
      onSubmit={() => (exact ? fin.setPoolBudget(m.id, num(total)) : fin.pushFunds(m.id, num(amt)))}>
      <div class="strip row" style={{ marginBottom: 12, gap: 24 }}>
        <div><div class="eyebrow">Unallocated cash</div><div class="money">{fmtMoney(unpooled)}</div></div>
        <div><div class="eyebrow">Pool budget now</div><div class="money">{fmtMoney(m.allocatedBudget)}</div></div>
      </div>
      <div class="form">
        {!exact && <>
          <div class="row wrap">
            {[50, 100, 250, 500].map((v) => <button type="button" key={v} class="btn chip" onClick={() => setAmt(String(round2(num(amt) + v)))}>+£{v}</button>)}
            {m.isWorkspaceConnected && <button type="button" class="btn chip" onClick={() => setAmt(String(unpooled))}>All unallocated</button>}
          </div>
          <Field label="Add amount"><MoneyInput value={amt} onInput={setAmt} autoFocus /></Field>
        </>}
        <label class="check"><input type="checkbox" checked={exact} onChange={(e) => setExact(e.currentTarget.checked)} />Set an exact total budget instead</label>
        {exact && <Field label="Exact total"><MoneyInput value={total} onInput={setTotal} autoFocus /></Field>}
        <div class={`small ${warn ? 'warn' : 'muted'}`}>New pool budget {fmtMoney(next)} · left to spend {fmtMoney(next - m.spent)}{warn ? ' · ⚠ more than your unallocated cash' : ''}</div>
      </div>
    </Modal>
  );
}

export function DeletePool({ onClose, metric }) {
  const { fin, ws } = useApp();
  const m = metric;
  const nonEmpty = m.allocatedBudget > 0 || m.lines.length || m.spent > 0;
  const others = fin.pools(ws).filter((p) => p.id !== m.id);
  const [target, setTarget] = useState(others[0]?.id || null);
  return (
    <Modal title={`Delete ${m.name}`} danger submitLabel="Delete pool" onClose={onClose}
      sub={nonEmpty ? `This pool holds ${fmtMoney(m.allocatedBudget)} and ${m.lines.length} categories. Its budget, categories and transactions move to the pool you choose.` : 'This pool is empty and can be deleted.'}
      onSubmit={() => fin.deletePool(m.id, nonEmpty ? target : null)}>
      {nonEmpty && <Field label="Move everything to"><Select value={target} onChange={setTarget} options={others.map((p) => [p.id, `${p.icon} ${p.name}`])} /></Field>}
    </Modal>
  );
}

export function CoverOverspend({ onClose, line, metric, metrics }) {
  const { fin, month } = useApp();
  const opts = [
    ...metric.lines.filter((l) => l.id !== line.id && l.remaining > 0).map((l) => [`category:${l.id}`, `Category · ${l.name} (surplus ${fmtMoney(l.remaining)})`]),
    ...metrics.filter((m) => m.id !== metric.id && m.unassigned > 0).map((m) => [`pool:${m.id}`, `Pool · ${m.icon} ${m.name} (unassigned ${fmtMoney(m.unassigned)})`]),
  ];
  const [src, setSrc] = useState(opts[0]?.[0] || null);
  return (
    <Modal title={`Cover overspend on ${line.name}`} sub={`${line.name} is ${fmtMoney(-line.remaining)} over its line. Choose where to cover it from.`}
      onClose={onClose} submitLabel="Cover overspend" busy={!opts.length}
      onSubmit={() => { const [k, id] = src.split(':'); fin.coverOverspend(line.id, k, id, month); }}>
      {opts.length ? <Field label="Cover from"><Select value={src} onChange={setSrc} options={opts} /></Field>
        : <div class="notice">No surplus categories or pools with unassigned budget. Push funds into this pool instead.</div>}
    </Modal>
  );
}

// ================================================================ Categories
export function CategoryDialog({ onClose, cat, prefill = {}, wsOverride, onSaved }) {
  const app = useApp();
  const { fin } = app;
  const ws = wsOverride || app.ws;
  const c = cat || {};
  const dp = fin.defaultPool(ws);
  const [d, setD] = useState({
    name: c.name || prefill.name || '', defaultType: c.defaultType || prefill.defaultType || 'Expense',
    bankAccount: c.bankAccount || 'ALL', poolId: cat ? c.poolId : (prefill.poolId !== undefined ? prefill.poolId : (dp ? dp.id : null)),
    allocated: c.allocated ?? '', color: c.color || PALETTE[fin.categories(ws).length % PALETTE.length],
  });
  const s = (k, v) => setD((o) => ({ ...o, [k]: v }));
  return (
    <Modal title={cat ? 'Edit category' : 'New category'} onClose={onClose}
      onSubmit={() => { const r = fin.saveCategory(ws, { ...(cat || {}), ...d, allocated: num(d.allocated) }); onSaved?.(r); }}>
      <div class="form two">
        <Field label="Name" class="full"><input type="text" value={d.name} disabled={c.isProtected} autoFocus onInput={(e) => s('name', e.currentTarget.value)} /></Field>
        <Field label="Default type"><Select value={d.defaultType} onChange={(v) => s('defaultType', v)} options={TX_TYPES.map((t) => [t, t])} /></Field>
        <Field label="Bank account"><Select value={d.bankAccount} onChange={(v) => s('bankAccount', v)} options={[['ALL', 'All accounts'], ...fin.accountNames(ws).map((n) => [n, n])]} /></Field>
        <Field label="Pool"><Select value={d.poolId} onChange={(v) => s('poolId', v)} options={[[null, '— Unpooled —'], ...fin.pools(ws).map((p) => [p.id, `${p.icon} ${p.name}`])]} /></Field>
        <Field label="Allocated (monthly budget line)"><MoneyInput value={d.allocated} onInput={(v) => s('allocated', v)} /></Field>
        <div class="field full"><span>Colour</span>
          <div class="row wrap" style={{ gap: 6 }}>
            {PALETTE.map((x) => <button type="button" key={x} aria-label={x} onClick={() => s('color', x)} style={{ width: 24, height: 24, borderRadius: '50%', border: d.color === x ? '3px solid var(--text)' : '1px solid var(--border)', background: x, cursor: 'pointer' }} />)}
          </div>
        </div>
        {c.isProtected && <div class="small muted full">{c.name} is a core category: it can't be renamed or deleted.</div>}
      </div>
    </Modal>
  );
}

export function RemapDialog({ onClose, ids }) {
  const { fin, ws, open } = useApp();
  const [cat, setCat] = useState('');
  return (
    <Modal title={`Remap ${ids.length} transaction${ids.length === 1 ? '' : 's'}`} sub="Their category (and pool) change to the one you pick." onClose={onClose}
      submitLabel="Remap" onSubmit={() => fin.remapCategory(ws, ids, cat)}>
      <CategoryPicker value={cat} onChange={(n) => setCat(n)} onNew={(name) => open('category', { prefill: { name }, onSaved: (c) => setCat(c.name) })} />
    </Modal>
  );
}

// ================================================================== Bills, goals
export function BillDialog({ onClose, bill }) {
  const { fin, ws, open } = useApp();
  const b = bill || {};
  const accounts = fin.accountNames(ws);
  const [d, setD] = useState({
    billName: b.billName || '', category: b.category || 'Utilities', dueDay: b.dueDay || 1, amount: b.amount ?? '',
    bankAccount: b.bankAccount || accounts[0] || '', reminderTime: b.reminderTime || '09:00', reminderEnabled: b.reminderEnabled ?? true, notes: b.notes || '',
  });
  const s = (k, v) => setD((o) => ({ ...o, [k]: v }));
  return (
    <Modal title={bill ? 'Edit bill' : 'New recurring bill'} sub="You'll get a reminder on the due day at the reminder time until it's marked paid." onClose={onClose}
      onSubmit={() => fin.saveBill(ws, { ...(bill ? { id: bill.id } : {}), ...d, billName: d.billName.trim(), category: d.category || d.billName.trim(), amount: num(d.amount), notes: d.notes.trim() })}>
      <div class="form two">
        <Field label="Bill name" class="full"><input type="text" value={d.billName} autoFocus onInput={(e) => s('billName', e.currentTarget.value)} /></Field>
        <div class="field full"><span>Category</span>
          <CategoryPicker value={d.category} type="Bills" includeIncome={false} onChange={(n) => s('category', n)} onNew={(name) => open('category', { prefill: { name, defaultType: 'Bills' }, onSaved: (c) => s('category', c.name) })} />
        </div>
        <Field label="Due day (1–31)"><input type="number" min="1" max="31" value={d.dueDay} onInput={(e) => s('dueDay', e.currentTarget.value)} /></Field>
        <Field label="Amount"><MoneyInput value={d.amount} onInput={(v) => s('amount', v)} /></Field>
        <Field label="Bank account"><Select value={d.bankAccount} onChange={(v) => s('bankAccount', v)} options={accounts.map((n) => [n, n])} /></Field>
        <Field label="Reminder time"><input type="time" value={d.reminderTime} onInput={(e) => s('reminderTime', e.currentTarget.value)} /></Field>
        <label class="check full"><input type="checkbox" checked={d.reminderEnabled} onChange={(e) => s('reminderEnabled', e.currentTarget.checked)} />Remind me</label>
        <Field label="Notes" class="full"><input type="text" value={d.notes} onInput={(e) => s('notes', e.currentTarget.value)} /></Field>
      </div>
    </Modal>
  );
}

export function GoalDialog({ onClose, goal }) {
  const { fin, ws, open } = useApp();
  const g = goal || {};
  const [d, setD] = useState({ category: g.category || '', amount: g.amount ?? '', type: g.type || 'Expense' });
  const s = (k, v) => setD((o) => ({ ...o, [k]: v }));
  return (
    <Modal title="Budget goal" onClose={onClose} onSubmit={() => {
      if (!d.category) throw new FinanceError('Choose a category from the list.');
      fin.saveGoal(ws, { ...(goal ? { id: goal.id } : {}), category: d.category, amount: num(d.amount), type: d.type });
    }}>
      <div class="form">
        <div class="field"><span>Category</span>
          <CategoryPicker value={d.category} type={d.type} onChange={(n, c) => setD({ ...d, category: n, type: c ? c.defaultType : d.type })}
            onNew={(name) => open('category', { prefill: { name }, onSaved: (c) => s('category', c.name) })} />
        </div>
        <Field label="Monthly target"><MoneyInput value={d.amount} onInput={(v) => s('amount', v)} /></Field>
        <Field label="Type"><Select value={d.type} onChange={(v) => s('type', v)} options={TX_TYPES.map((t) => [t, t])} /></Field>
      </div>
    </Modal>
  );
}

// ================================================================== Accounts
export function AccountDialog({ onClose, account }) {
  const { fin, ws } = useApp();
  const [name, setName] = useState(account?.name || '');
  const [bal, setBal] = useState(account?.initialBalance ?? '');
  return (
    <Modal title={account ? 'Edit account' : 'New bank account'} sub="Renaming an account updates every transaction, transfer and bill that uses it." onClose={onClose}
      onSubmit={() => fin.saveAccount(ws, name, num(bal), account?.id || null)}>
      <div class="form">
        <Field label="Account name"><input type="text" value={name} autoFocus onInput={(e) => setName(e.currentTarget.value)} placeholder="e.g. Monzo, Barclays Current" /></Field>
        <Field label="Starting balance (£) — use minus for an overdrawn or credit card account">
          <input type="number" step="0.01" class="money-input" value={bal} onInput={(e) => setBal(e.currentTarget.value)} />
        </Field>
      </div>
    </Modal>
  );
}

export function DeleteAccount({ onClose, account }) {
  const { fin, ws } = useApp();
  const used = fin.accountUsage(ws, account.name);
  const others = fin.accountNames(ws).filter((n) => n !== account.name);
  const [to, setTo] = useState(others[0] || null);
  return (
    <Modal title={`Delete ${account.name}`} danger submitLabel="Delete account" onClose={onClose}
      sub={used ? `${used} transactions and transfers use this account. Choose an account to move them to.` : 'Nothing uses this account.'}
      onSubmit={() => fin.deleteAccount(ws, account.id, used ? to : null)} busy={used > 0 && !others.length}>
      {used > 0 && (others.length ? <Field label="Move them to"><Select value={to} onChange={setTo} options={others.map((n) => [n, n])} /></Field>
        : <div class="notice">Add another account first, so its records have somewhere to go.</div>)}
    </Modal>
  );
}

// ================================================================== Workspaces
export function WorkspaceDialog({ onClose }) {
  const { fin, ws, setWs, open } = useApp();
  const [name, setName] = useState('');
  const [kind, setKind] = useState('business');
  const [edit, setEdit] = useState(null);
  const list = fin.workspaces();
  return (
    <Modal title="Workspaces" sub="Each workspace has its own accounts, pools, categories and bills. Business workspaces can receive DLA payments." onClose={onClose} noSubmit>
      <div class="col" style={{ gap: 6 }}>
        {list.map((w) => (
          <div class="strip row wrap" key={w.id}>
            {edit && edit.id === w.id ? <>
              <input type="text" value={edit.name} onInput={(e) => setEdit({ ...edit, name: e.currentTarget.value })} />
              <select style={{ width: 130 }} value={edit.kind} onChange={(e) => setEdit({ ...edit, kind: e.currentTarget.value })}><option value="personal">Personal</option><option value="business">Business</option></select>
              <button type="button" class="btn sm primary" onClick={() => { try { fin.renameWorkspace(w.id, edit.name, edit.kind); setEdit(null); } catch (ex) { alert(ex.message); } }}>Save</button>
            </> : <>
              <div class="row" style={{ flex: '1 1 150px', minWidth: 0 }}><b class="grow" style={{ overflowWrap: 'anywhere' }}>{w.name}</b><span class="pill">{w.kind === 'business' ? 'Business' : 'Personal'}</span></div>
              {w.id === ws ? <span class="pill emerald">Open</span> : <button type="button" class="btn sm" onClick={() => { setWs(w.id); onClose(); }}>Open</button>}
              <button type="button" class="btn sm ghost" onClick={() => setEdit({ id: w.id, name: w.name, kind: w.kind })}>Rename</button>
              <button type="button" class="btn sm ghost danger" disabled={list.length <= 1} onClick={() => open('confirm', {
                title: `Delete ${w.name}?`, body: 'This deletes the workspace and everything in it: accounts, transactions, pools, bills. Make an Excel backup first if you might need it.', label: 'Delete workspace',
                action: () => { fin.deleteWorkspace(w.id); if (w.id === ws) setWs(fin.workspaces()[0].id); },
              })}>Delete</button>
            </>}
          </div>
        ))}
      </div>
      <h3 style={{ margin: '16px 0 8px' }}>Add a workspace</h3>
      <div class="row wrap">
        <input type="text" style={{ flex: '2 1 200px', width: 'auto' }} placeholder="e.g. FitChic" value={name} onInput={(e) => setName(e.currentTarget.value)} />
        <select style={{ flex: '1 1 120px', width: 'auto' }} value={kind} onChange={(e) => setKind(e.currentTarget.value)}><option value="business">Business</option><option value="personal">Personal</option></select>
        <button type="button" class="btn primary" onClick={() => {
          try { const w = fin.createWorkspace(name, kind); setName(''); setWs(w.id); onClose(); } catch (ex) { alert(ex.message); }
        }}>Add</button>
      </div>
    </Modal>
  );
}

export function Confirm({ onClose, title, body, label = 'OK', action, danger = true }) {
  return <Modal title={title} onClose={onClose} danger={danger} submitLabel={label} onSubmit={action}>{body && <p style={{ margin: 0 }}>{body}</p>}</Modal>;
}
