import { Fragment } from 'preact';
import { useEffect, useMemo, useState } from 'preact/hooks';
import { Finance } from '../lib/finance.js';
import { TX_TYPES, addDays, fmtDate, fmtMoney, monthBounds, monthKey, monthLabel, shiftMonth, todayStr } from '../lib/util.js';
import { Avatar, Bar, Empty, Icon, Money, Pill, Seg, Select, Stat, TxRow, useApp, useCatColors, useDebounced } from './components.jsx';

// ===================================================================== Accounts
export function Accounts() {
  const { fin, ws, open, go, version } = useApp();
  const accs = useMemo(() => fin.accountSummaries(ws), [version, ws]);
  const total = accs.reduce((s, a) => s + a.balance, 0);
  const transfers = fin.transfers(ws);
  const [showAll, setShowAll] = useState(false);
  return (
    <div>
      <div class="page-head">
        <h1 class="grow">Bank Accounts</h1>
        <span class="muted">Money at hand <Money v={total} class="" /></span>
        <button class="btn primary" onClick={() => open('account', {})}>+ Add account</button>
      </div>
      <div class="grid c3">
        {accs.map((a) => (
          <div class="card" key={a.id}>
            <div class="row"><Avatar name={a.name} color="#151815" /><b class="grow">{a.name}</b>{a.balance < 0 && <Pill tone="rose">Overdrawn</Pill>}</div>
            <div class="eyebrow" style={{ marginTop: 8 }}>Current balance</div>
            <div class={`money ${a.balance < 0 ? 'neg' : ''}`} style={{ fontSize: 30, fontWeight: 800, letterSpacing: '-.03em' }}>{fmtMoney(a.balance)}</div>
            <div class="col small" style={{ margin: '8px 0', gap: 2 }}>
              {[['Initial balance', a.initialBalance, false], ['Total income', a.income, true], ['Total spending', -a.expenses, true], ['Net transfers', a.netTransfers, true]].map(([l, v, s]) => (
                <div class="row" key={l}><span class="muted grow">{l}</span><Money v={v} signed={s} tone={s} /></div>
              ))}
            </div>
            <div class="row wrap">
              <button class="btn sm primary" onClick={() => open('quick', { mode: 'transfer', prefill: { fromAccount: a.name } })}>⇄ Transfer</button>
              <span class="spacer" />
              <button class="btn sm ghost" onClick={() => go('tx', { account: a.name })}>Ledger</button>
              <button class="btn sm ghost" onClick={() => open('account', { account: a })}>Edit</button>
              <button class="btn sm ghost danger" onClick={() => open('deleteAccount', { account: a })}>Delete</button>
            </div>
          </div>
        ))}
      </div>
      {!accs.length && <div class="card"><Empty>No bank accounts yet. Add one to start logging money.</Empty></div>}
      <div class="row" style={{ margin: '22px 0 8px' }}><h2 class="grow">Account transfers</h2>
        <button class="btn" onClick={() => open('quick', { mode: 'transfer' })}>+ Transfer</button></div>
      <div class="tablewrap">
        <table class="t">
          <thead><tr><th>Date</th><th class="hide-sm">From</th><th class="hide-sm">To</th><th class="show-sm">From → To</th><th class="money">Amount</th><th class="hide-sm">Notes</th><th /></tr></thead>
          <tbody>
            {(showAll ? transfers : transfers.slice(0, 15)).map((t) => (
              <tr key={t.id}>
                <td class="nowrap">{fmtDate(t.date)}</td><td class="hide-sm">{t.fromAccount}</td><td class="hide-sm">{t.toAccount}</td><td class="show-sm small">{t.fromAccount} → {t.toAccount}</td>
                <td class="money"><Money v={t.amount} /></td><td class="hide-sm muted clip">{t.notes}</td>
                <td class="right nowrap">
                  <button class="btn sm ghost" onClick={() => open('quick', { mode: 'transfer', prefill: t })}>Edit</button>
                  <button class="btn sm ghost danger hide-sm" onClick={() => open('confirm', { title: 'Delete this transfer?', body: `${fmtMoney(t.amount)} from ${t.fromAccount} to ${t.toAccount} on ${fmtDate(t.date)}.`, action: () => fin.deleteTransfer(t.id), label: 'Delete' })}>Delete</button>
                </td>
              </tr>
            ))}
            {!transfers.length && <tr><td colSpan={7}><Empty>No transfers yet. Transfers move cash between accounts and don't count as income or spending.</Empty></td></tr>}
          </tbody>
        </table>
      </div>
      {transfers.length > 15 && <button class="btn ghost sm" style={{ marginTop: 8 }} onClick={() => setShowAll(!showAll)}>{showAll ? 'Show fewer' : `Show all ${transfers.length}`}</button>}
    </div>
  );
}

// ================================================================= Transactions
const PAGE = 150;
export function Transactions() {
  const { fin, ws, open, ledgerFilter, setLedgerFilter, version, toast } = useApp();
  const blank = { search: '', account: null, category: null, type: null, month: null, poolId: null, start: '', end: '', range: false };
  const [f, setF] = useState({ ...blank, ...(ledgerFilter || {}) });
  const [sel, setSel] = useState(new Set());
  const [limit, setLimit] = useState(PAGE);
  const [showFilters, setShowFilters] = useState(false);
  const [selecting, setSelecting] = useState(false);
  const colors = useCatColors();
  useEffect(() => { if (ledgerFilter) { setF({ ...blank, ...ledgerFilter }); setLedgerFilter(null); setSel(new Set()); } }, [ledgerFilter]);
  useEffect(() => { setSel(new Set()); setLimit(PAGE); }, [ws]);
  const search = useDebounced(f.search, 150);
  const set = (k, v) => { setF({ ...f, [k]: v }); setLimit(PAGE); };
  const rows = useMemo(() => fin.transactions(ws, {
    search, account: f.account, category: f.category, type: f.type, poolId: f.poolId,
    month: f.range ? null : f.month, start: f.range ? f.start || null : null, end: f.range ? f.end || null : null,
  }), [version, ws, search, f.account, f.category, f.type, f.poolId, f.month, f.range, f.start, f.end]);
  const totalAll = fin.db.all('transactions', { workspaceId: ws }).length;
  const months = fin.monthlyPL(ws).map((r) => r.month);
  const pools = fin.pools(ws);
  const poolNames = Object.fromEntries(pools.map((p) => [p.id, `${p.icon} ${p.name}`]));
  const net = rows.reduce((s, t) => s + t.amount, 0);
  const toggle = (id) => { const n = new Set(sel); n.has(id) ? n.delete(id) : n.add(id); setSel(n); };
  const ids = [...sel].filter((id) => rows.some((r) => r.id === id));
  const need = (fn) => () => (ids.length ? fn() : toast('Tick one or more transactions first.'));
  const filtered = f.search || f.account || f.category || f.type || f.month || f.poolId || f.range;
  const nFilters = [f.account, f.category, f.type, f.month, f.poolId, f.range].filter(Boolean).length;
  const today = todayStr();
  const yday = addDays(today, -1);
  const dayLabel = (d) => (d === today ? 'Today' : d === yday ? 'Yesterday' : fmtDate(d));
  return (
    <div>
      <div class="page-head">
        <h1 class="grow">Transactions</h1>
        <span class="muted small grow">{rows.length} of {totalAll} · net <Money v={net} tone /></span>
        <button class="btn ghost" onClick={() => setF(blank)} disabled={!filtered}>Clear filters</button>
        <button class="btn primary" onClick={() => open('quick', { mode: 'tx' })}>+ Add</button>
      </div>
      <div class={`card flat filters ${showFilters ? 'open' : ''}`} style={{ padding: 12, marginBottom: 12 }}>
        <div class="row wrap">
          <input type="search" style={{ flex: '2 1 200px', width: 'auto', minWidth: 0 }} placeholder="Search description, category, account…" value={f.search} onInput={(e) => set('search', e.currentTarget.value)} />
          <button type="button" class={`btn filters-toggle ${nFilters ? 'primary' : ''}`} onClick={() => setShowFilters(!showFilters)}><Icon name="filter" size={16} />Filters{nFilters ? ` (${nFilters})` : ''}</button>
          <div class="filters-more" style={{ flex: '1 1 140px' }}><Select value={f.account} onChange={(v) => set('account', v)} options={[[null, 'All accounts'], ...fin.accountNames(ws).map((n) => [n, n])]} /></div>
          <div class="filters-more" style={{ flex: '1 1 140px' }}><Select value={f.category} onChange={(v) => set('category', v)} options={[[null, 'All categories'], ...fin.categories(ws).map((c) => [c.name, c.name])]} /></div>
          <div class="filters-more" style={{ flex: '1 1 120px' }}><Select value={f.type} onChange={(v) => set('type', v)} options={[[null, 'All types'], ...TX_TYPES.map((t) => [t, t])]} /></div>
          <div class="filters-more" style={{ flex: '1 1 140px' }}><Select value={f.poolId} onChange={(v) => set('poolId', v)} options={[[null, 'All pools'], ...pools.map((p) => [p.id, `${p.icon} ${p.name}`])]} /></div>
          {!f.range && <div class="filters-more" style={{ flex: '1 1 140px' }}><Select value={f.month} onChange={(v) => set('month', v)} options={[[null, 'All months'], ...months.map((m) => [m, monthLabel(m)])]} /></div>}
          <label class="check small filters-more"><input type="checkbox" checked={f.range} onChange={(e) => set('range', e.currentTarget.checked)} />Date range</label>
          {f.range && <>
            <input type="date" class="filters-more" style={{ flex: '1 1 140px', width: 'auto' }} value={f.start} onInput={(e) => set('start', e.currentTarget.value)} />
            <span class="muted filters-more">→</span>
            <input type="date" class="filters-more" style={{ flex: '1 1 140px', width: 'auto' }} value={f.end} onInput={(e) => set('end', e.currentTarget.value)} />
          </>}
        </div>
        <div class="row wrap" style={{ marginTop: 10 }}>
          <span class="small muted">{ids.length ? `${ids.length} selected` : <><span class="hide-sm">Tick rows to change several at once. Tap a row to edit it.</span><span class="show-sm">Tap a transaction to edit it.</span></>}</span>
          <span class="spacer" />
          <button class="btn sm show-sm" onClick={() => { if (selecting) setSel(new Set()); setSelecting(!selecting); }}>{selecting ? 'Done' : 'Select'}</button>
          <button class={`btn sm ${selecting ? '' : 'hide-sm'}`} onClick={need(() => open('remap', { ids }))}>Remap category</button>
          <select class={selecting ? '' : 'hide-sm'} style={{ width: 'auto', minHeight: 32, fontSize: 12, padding: '3px 28px 3px 12px', borderRadius: 999 }} value="" onChange={(e) => {
            const v = e.currentTarget.value; e.currentTarget.value = '';
            if (!ids.length) return toast('Tick one or more transactions first.');
            fin.setTransactionsPool(ids, v === '__none' ? null : v); toast(`Moved ${ids.length} to ${v === '__none' ? 'no pool' : poolNames[v]}`);
          }}>
            <option value="">Move to pool…</option>
            {pools.map((p) => <option key={p.id} value={p.id}>{p.icon} {p.name}</option>)}
            <option value="__none">— No pool —</option>
          </select>
          <button class={`btn sm danger ${selecting ? '' : 'hide-sm'}`} onClick={need(() => open('confirm', {
            title: `Delete ${ids.length} transaction${ids.length === 1 ? '' : 's'}?`, body: 'This cannot be undone (but your Excel backups still have them).', label: 'Delete',
            action: () => { fin.deleteTransactions(ids); setSel(new Set()); },
          }))}>Delete</button>
        </div>
      </div>
      <div class="tablewrap ledger">
        <table class="t">
          <thead><tr>
            <th class="chk"><input type="checkbox" aria-label="Select all" checked={rows.length > 0 && ids.length === Math.min(rows.length, limit)}
              onChange={(e) => setSel(e.currentTarget.checked ? new Set(rows.slice(0, limit).map((r) => r.id)) : new Set())} /></th>
            <th>Date</th><th>Type</th><th>Category</th><th>Account</th><th>Description</th><th>Pool</th><th>DLA</th><th class="money">Amount</th>
          </tr></thead>
          <tbody>
            {rows.slice(0, limit).map((t) => (
              <tr key={t.id} class={sel.has(t.id) ? 'sel' : ''} style={{ cursor: 'pointer' }} onClick={(e) => { if (e.target.type !== 'checkbox') open('quick', { mode: 'tx', prefill: t }); }}>
                <td class="chk"><input type="checkbox" checked={sel.has(t.id)} onChange={() => toggle(t.id)} aria-label="Select" /></td>
                <td class="nowrap">{fmtDate(t.date)}</td>
                <td class="muted nowrap">{t.type}</td>
                <td class="nowrap">{t.category}</td>
                <td class="muted nowrap">{t.bankAccount}</td>
                <td class="clip"><div class="row"><Avatar small name={t.description || t.category} color={colors[(t.category || '').toLowerCase()]} /><span style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>{t.description}</span></div></td>
                <td class="muted nowrap">{t.poolId ? poolNames[t.poolId] || t.poolName : '—'}</td>
                <td>{t.isBusinessPayment ? <Pill tone="amber">{t.businessWorkspaceName || 'DLA'}</Pill> : ''}</td>
                <td class="money"><Money v={t.amount} tone signed /></td>
              </tr>
            ))}
            {!rows.length && <tr><td colSpan={9}><Empty>{totalAll ? 'No transactions match these filters. Try “Clear filters”.' : 'No transactions yet. Add one with “+ Add”, or import a spreadsheet from the menu.'}</Empty></td></tr>}
          </tbody>
        </table>
      </div>
      <div class="txlist txrows" style={{ flexDirection: 'column' }}>
        {rows.slice(0, limit).map((t, i, arr) => (
          <Fragment key={t.id}>
            {(i === 0 || arr[i - 1].date !== t.date) && <div class="day-label">{dayLabel(t.date)}</div>}
            <TxRow t={t} selected={sel.has(t.id)} color={colors[(t.category || '').toLowerCase()]}
              sub={`${t.category} · ${t.bankAccount}${t.isBusinessPayment ? ' · DLA' : ''}`}
              onClick={(e) => { if (e.target.type === 'checkbox') return; if (selecting) toggle(t.id); else open('quick', { mode: 'tx', prefill: t }); }}>
              {selecting && <input type="checkbox" checked={sel.has(t.id)} onChange={() => toggle(t.id)} aria-label="Select" />}
            </TxRow>
          </Fragment>
        ))}
        {!rows.length && <div class="card"><Empty>{totalAll ? 'No transactions match these filters.' : 'No transactions yet.'}</Empty></div>}
      </div>
      {rows.length > limit && <button class="btn block" style={{ marginTop: 12 }} onClick={() => setLimit(limit + PAGE * 2)}>Show more ({rows.length - limit} left)</button>}
    </div>
  );
}

// ================================================================== Calendar
export function Calendar() {
  const { fin, ws, go, version } = useApp();
  const [month, setMonth] = useState(monthKey());
  const daily = useMemo(() => fin.dailyTotals(ws, month), [version, ws, month]);
  const pl = useMemo(() => fin.monthlyPL(ws), [version, ws]);
  const tot = Finance.totals(fin.transactions(ws, { month }));
  const [first] = monthBounds(month);
  const lead = (new Date(first + 'T00:00:00Z').getUTCDay() + 6) % 7;
  const n = +monthBounds(month)[1].slice(8);
  const today = todayStr();
  const cells = [...Array(lead).fill(null), ...Array.from({ length: n }, (_, i) => `${month}-${String(i + 1).padStart(2, '0')}`)];
  return (
    <div>
      <div class="page-head">
        <h1 class="grow">Calendar & P&amp;L</h1>
        <button class="iconbtn" onClick={() => setMonth(shiftMonth(month, -1))}>‹</button>
        <b style={{ minWidth: 130, textAlign: 'center' }}>{monthLabel(month)}</b>
        <button class="iconbtn" onClick={() => setMonth(shiftMonth(month, 1))}>›</button>
        <button class="btn" onClick={() => go('tx', { month })}>View in ledger</button>
      </div>
      <div class="grid calgrid">
        <div class="card">
          <div class="cal">
            {['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].map((d) => <div class="dow" key={d}>{d}</div>)}
            {cells.map((d, i) => {
              if (!d) return <div class="day out" key={`o${i}`} />;
              const x = daily[d];
              return (
                <div class={`day ${d === today ? 'today' : ''}`} key={d} onClick={() => go('tx', { range: true, start: d, end: d })}>
                  <span class="n">{+d.slice(8)}</span>
                  {x && x.income > 0 && <span class="money pos amt">+{fmtMoney(x.income)}</span>}
                  {x && x.outflow > 0 && <span class="money neg amt">-{fmtMoney(x.outflow)}</span>}
                  {x && x.transfers > 0 && <span class="faint amt">⇄ {x.transfers}</span>}
                  {x && <span class="dotline">{x.income > 0 && <span class="dot ok" />} {x.outflow > 0 && <span class="dot off" />}</span>}
                </div>
              );
            })}
          </div>
        </div>
        <div class="card">
          <h3>P&amp;L · {monthLabel(month)}</h3>
          <div class="col" style={{ marginTop: 10, gap: 6 }}>
            {[['Income', tot.income, 'pos'], ['Expenses', tot.expenses], ['Bills', tot.bills], ['Debt payments', tot.debt], ['Savings', tot.savings], ['Investments', tot.investment]].map(([l, v, c]) => (
              <div class="row" key={l}><span class="grow muted">{l}</span><span class={`money ${c || ''}`}>{fmtMoney(v)}</span></div>
            ))}
            <hr style={{ border: 0, borderTop: '1px solid var(--border)', width: '100%' }} />
            <div class="eyebrow">Net cashflow</div>
            <div class={`money ${tot.net < 0 ? 'neg' : 'pos'}`} style={{ fontSize: 24, fontWeight: 700 }}>{fmtMoney(tot.net, true)}</div>
            <div class="small muted">{tot.count} transactions</div>
          </div>
        </div>
      </div>
      <h2 style={{ margin: '22px 0 8px' }}>Monthly P&amp;L</h2>
      <div class="tablewrap">
        <table class="t">
          <thead><tr><th>Month</th><th class="money">Income</th><th class="money hide-sm">Expenses</th><th class="money hide-sm">Bills</th><th class="money hide-sm">Debt</th><th class="money hide-sm">Savings</th><th class="money hide-sm">Investments</th><th class="money">Net</th><th class="money hide-sm">Transfers</th></tr></thead>
          <tbody>
            {pl.map((r) => (
              <tr key={r.month} style={{ cursor: 'pointer' }} onClick={() => setMonth(r.month)} class={r.month === month ? 'sel' : ''}>
                <td class="nowrap">{monthLabel(r.month)}</td><td class="money pos">{fmtMoney(r.income)}</td>
                <td class="money hide-sm">{fmtMoney(r.expenses)}</td><td class="money hide-sm">{fmtMoney(r.bills)}</td><td class="money hide-sm">{fmtMoney(r.debt)}</td>
                <td class="money hide-sm">{fmtMoney(r.savings)}</td><td class="money hide-sm">{fmtMoney(r.investment)}</td>
                <td class="money"><Money v={r.net} tone signed /></td><td class="money hide-sm">{r.transfers}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// ================================================================ Categories
export function Categories() {
  const { fin, ws, open, version, toast } = useApp();
  const cats = fin.categories(ws);
  const pools = Object.fromEntries(fin.pools(ws).map((p) => [p.id, p]));
  const spentAll = useMemo(() => {
    const o = {};
    for (const t of fin.db.raw('transactions')) if (t.workspaceId === ws && t.type !== 'Income') o[t.category.toLowerCase()] = (o[t.category.toLowerCase()] || 0) - t.amount;
    return o;
  }, [version, ws]);
  const thisMonth = useMemo(() => {
    const o = {};
    for (const t of fin.transactions(ws, { month: monthKey() })) o[t.category.toLowerCase()] = (o[t.category.toLowerCase()] || 0) + Math.abs(t.amount);
    return o;
  }, [version, ws]);
  const [sel, setSel] = useState(new Set());
  const toggle = (id) => { const n = new Set(sel); n.has(id) ? n.delete(id) : n.add(id); setSel(n); };
  const goals = fin.goals(ws);
  return (
    <div>
      <div class="page-head">
        <div class="grow"><h1>Categories</h1><div class="sub">One master list for this workspace</div></div>
        <button class="btn danger" disabled={!sel.size} onClick={() => open('confirm', {
          title: `Delete ${sel.size} categor${sel.size === 1 ? 'y' : 'ies'}?`, body: 'Transactions keep their category name. Core categories (Groceries, Utilities, Rent, Insurance) are kept.', label: 'Delete',
          action: () => { const b = fin.deleteCategories([...sel]); setSel(new Set()); if (b.length) toast(`Kept core categories: ${b.join(', ')}`); },
        })}>Delete selected</button>
        <button class="btn primary" onClick={() => open('category', {})}>+ New category</button>
      </div>
      <div class="tablewrap">
        <table class="t">
          <thead><tr><th class="chk" /><th>Name</th><th class="hide-sm">Default type</th><th class="hide-sm">Bank account</th><th class="hide-sm">Pool</th><th class="money">Allocated</th><th class="money hide-sm">Spent (all time)</th><th /></tr></thead>
          <tbody>
            {cats.map((c) => (
              <tr key={c.id} class={sel.has(c.id) ? 'sel' : ''}>
                <td class="chk"><input type="checkbox" checked={sel.has(c.id)} onChange={() => toggle(c.id)} aria-label="Select" /></td>
                <td><div class="row"><span class="swatch" style={{ background: c.color }} />{c.name}{c.isProtected && <Pill>Core</Pill>}</div>
                  <div class="show-sm small muted" style={{ marginLeft: 18 }}>{c.poolId && pools[c.poolId] ? `${pools[c.poolId].icon} ${pools[c.poolId].name}` : 'Unpooled'}</div></td>
                <td class="hide-sm muted">{c.defaultType}</td>
                <td class="hide-sm muted">{!c.bankAccount || c.bankAccount === 'ALL' ? 'All accounts' : c.bankAccount}</td>
                <td class="nowrap hide-sm">{c.poolId && pools[c.poolId] ? `${pools[c.poolId].icon} ${pools[c.poolId].name}` : <span class="muted">Unpooled</span>}</td>
                <td class="money"><Money v={c.allocated} /></td>
                <td class="money hide-sm"><Money v={spentAll[c.name.toLowerCase()] || 0} /></td>
                <td class="right"><button class="btn sm ghost" onClick={() => open('category', { cat: c })}>Edit</button></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div class="row" style={{ margin: '22px 0 8px' }}><h2 class="grow">Budget goals</h2><button class="btn" onClick={() => open('goal', {})}>+ Add goal</button></div>
      <div class="tablewrap">
        <table class="t">
          <thead><tr><th>Category</th><th class="hide-sm">Type</th><th class="money">Goal</th><th class="money">This month</th><th class="hide-sm" style={{ width: '30%' }}>Progress</th><th /></tr></thead>
          <tbody>
            {goals.map((g) => {
              const got = thisMonth[(g.category || '').toLowerCase()] || 0;
              const pct = g.amount ? got / g.amount * 100 : 0;
              const saving = ['Savings', 'Investment', 'Income'].includes(g.type);
              return (
                <tr key={g.id}>
                  <td>{g.category}</td><td class="hide-sm muted">{g.type}</td><td class="money"><Money v={g.amount} /></td><td class="money"><Money v={got} /></td>
                  <td class="hide-sm"><div class="row"><div class="grow"><Bar pct={pct} color={saving ? 'var(--emerald)' : undefined} /></div><span class="small muted">{Math.round(pct)}%</span></div></td>
                  <td class="right nowrap">
                    <button class="btn sm ghost" onClick={() => open('goal', { goal: g })}>Edit</button>
                    <button class="btn sm ghost danger" onClick={() => open('confirm', { title: 'Delete this goal?', body: g.category, label: 'Delete', action: () => fin.deleteGoal(g.id) })}><span class="hide-sm">Delete</span><span class="show-sm" aria-label="Delete">✕</span></button>
                  </td>
                </tr>
              );
            })}
            {!goals.length && <tr><td colSpan={6}><Empty>No goals yet. A goal is a monthly target for a category, like £400 on Groceries.</Empty></td></tr>}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// ===================================================================== Bills
export function Bills() {
  const { fin, ws, open, version } = useApp();
  const bills = fin.bills(ws);
  const sts = bills.map((b) => fin.billStatus(b));
  const pending = sts.filter((s) => !s.paid);
  const due = bills.reduce((s, b, i) => s + (sts[i].paid ? 0 : b.amount), 0);
  void version;
  return (
    <div>
      <div class="page-head">
        <div class="grow"><h1>Upcoming Bills</h1><div class="sub">{pending.length} unpaid this month · {fmtMoney(due)} still to pay</div></div>
        <button class="btn primary" onClick={() => open('bill', {})}>+ Add bill</button>
      </div>
      <div class="mlist">
        {bills.map((b, i) => {
          const st = sts[i];
          return (
            <div class="mitem" key={b.id}>
              <div class="top">
                <Avatar name={b.billName} color={st.paid ? '#13a150' : '#151815'} />
                <div class="grow"><div class="name">{b.billName}</div><div class="small muted">Due {st.dueLabel} · {b.bankAccount}</div></div>
                <div class="col" style={{ alignItems: 'flex-end' }}><Money v={b.amount} class="big" /><Pill tone={st.tone === 'neutral' ? '' : st.tone}>{st.status}</Pill></div>
              </div>
              {b.notes && <div class="small muted">{b.notes}</div>}
              <div class="acts">
                <button class={`btn sm ${st.paid ? 'primary' : ''}`} onClick={() => fin.toggleBillPaid(b.id)}>{st.paid ? '✓ Paid' : 'Mark paid'}</button>
                <button class="btn sm ghost" onClick={() => open('quick', { mode: 'tx', prefill: { type: 'Bills', category: b.category, bankAccount: b.bankAccount, amount: b.amount, description: b.billName } })}>Log payment</button>
                <span class="spacer" />
                <button class="btn sm ghost" onClick={() => open('bill', { bill: b })}>Edit</button>
                <button class="btn sm ghost danger" aria-label="Delete" onClick={() => open('confirm', { title: `Delete ${b.billName}?`, label: 'Delete', action: () => fin.deleteBill(b.id) })}>✕</button>
              </div>
            </div>
          );
        })}
        {!bills.length && <div class="card"><Empty>No recurring bills yet.</Empty></div>}
      </div>
      <div class="tablewrap desk">
        <table class="t">
          <thead><tr><th>Bill</th><th class="hide-sm">Category</th><th>Due</th><th>Status</th><th class="money">Amount</th><th class="hide-sm">Account</th><th class="hide-sm">Reminder</th><th>This month</th><th /></tr></thead>
          <tbody>
            {bills.map((b, i) => {
              const st = sts[i];
              return (
                <tr key={b.id}>
                  <td><b>{b.billName}</b>{b.notes && <div class="small muted">{b.notes}</div>}</td>
                  <td class="hide-sm muted">{b.category}</td>
                  <td class="nowrap">{st.dueLabel}</td>
                  <td><Pill tone={st.tone === 'neutral' ? '' : st.tone}>{st.status}</Pill></td>
                  <td class="money"><Money v={b.amount} /></td>
                  <td class="hide-sm muted">{b.bankAccount}</td>
                  <td class="hide-sm muted">{b.reminderEnabled ? b.reminderTime : 'Off'}</td>
                  <td><button class={`btn sm ${st.paid ? 'primary' : ''}`} onClick={() => fin.toggleBillPaid(b.id)}>{st.paid ? '✓ Paid' : 'Mark paid'}</button></td>
                  <td class="right nowrap">
                    <button class="btn sm ghost hide-sm" onClick={() => open('quick', { mode: 'tx', prefill: { type: 'Bills', category: b.category, bankAccount: b.bankAccount, amount: b.amount, description: b.billName } })}>Log payment</button>
                    <button class="btn sm ghost" onClick={() => open('bill', { bill: b })}>Edit</button>
                    <button class="btn sm ghost danger" onClick={() => open('confirm', { title: `Delete ${b.billName}?`, label: 'Delete', action: () => fin.deleteBill(b.id) })}>✕</button>
                  </td>
                </tr>
              );
            })}
            {!bills.length && <tr><td colSpan={9}><Empty>No recurring bills yet.</Empty></td></tr>}
          </tbody>
        </table>
      </div>
      <p class="small muted">Reminders show inside the app (and as a phone or computer notification if you allow it) on the due day at the reminder time, while Emperio Finances is open.</p>
    </div>
  );
}

// ======================================================================= DLA
export function DLA() {
  const { fin, open, version } = useApp();
  const [biz, setBiz] = useState(null);
  const [q, setQ] = useState('');
  const rows = useMemo(() => fin.dlaRows(biz, q), [version, biz, q]);
  const paid = rows.filter((r) => r.dlaEffect > 0).reduce((s, r) => s + r.dlaEffect, 0);
  const back = -rows.filter((r) => r.dlaEffect < 0).reduce((s, r) => s + r.dlaEffect, 0);
  const businesses = fin.businessWorkspaces();
  return (
    <div>
      <div class="page-head">
        <h1 class="grow">Director's Loan Account</h1>
        <button class="btn primary" onClick={() => open('quick', { mode: 'tx', prefill: { isBusinessPayment: true, businessWorkspaceId: biz || businesses[0]?.id, type: 'Expense', category: 'Business Costs' }, personal: true })}>+ Log DLA payment</button>
      </div>
      <div class="grid c3" style={{ marginBottom: 12 }}>
        <Stat label="Owed to director" value={paid - back} cls="focal big" sub="Balance the company owes you" />
        <Stat label="Paid personally for business" value={paid} />
        <Stat label="Repaid by business" value={back} />
      </div>
      <div class="row wrap" style={{ marginBottom: 10 }}>
        <div style={{ flex: '1 1 200px' }}><Select value={biz} onChange={setBiz} options={[[null, 'All businesses'], ...businesses.map((w) => [w.id, w.name])]} /></div>
        <input type="search" style={{ flex: '2 1 240px', width: 'auto' }} placeholder="Search description or category…" value={q} onInput={(e) => setQ(e.currentTarget.value)} />
      </div>
      <div class="tablewrap">
        <table class="t">
          <thead><tr><th>Date</th><th class="hide-sm">Paid from</th><th class="hide-sm">Business</th><th>Description</th><th class="hide-sm">Business category</th><th class="hide-sm">Notes</th><th class="money">DLA effect</th></tr></thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.id} style={{ cursor: 'pointer' }} onClick={() => open('quick', { mode: 'tx', prefill: r, wsOverride: r.workspaceId })}>
                <td class="nowrap">{fmtDate(r.date)}</td><td class="hide-sm muted">{r.sourceWorkspace} · {r.bankAccount}</td>
                <td class="hide-sm">{r.businessWorkspaceName}</td><td class="clip" style={{ maxWidth: 'min(280px, 40vw)' }}>{r.description}<div class="show-sm small muted">{r.businessWorkspaceName}</div></td><td class="hide-sm muted">{r.businessCategory}</td>
                <td class="hide-sm muted clip">{r.dlaNotes}</td><td class="money"><Money v={r.dlaEffect} signed tone /></td>
              </tr>
            ))}
            {!rows.length && <tr><td colSpan={7}><Empty>No business payments yet. Tick “Business payment (DLA)” when you pay for something for a business with personal money.</Empty></td></tr>}
          </tbody>
        </table>
      </div>
      <p class="small muted">Personal money spent for a business adds to what it owes you. Income tagged as a DLA payment counts as the business paying you back.</p>
    </div>
  );
}

// ================================================================== Analysis
export function Analysis() {
  const { fin, ws, go, version } = useApp();
  const [mode, setMode] = useState('MTD');
  const [start, setStart] = useState(todayStr().slice(0, 8) + '01');
  const [end, setEnd] = useState(todayStr());
  const [type, setType] = useState(null);
  const [q, setQ] = useState('');
  const [s, e] = fin.period(mode, start, end);
  const res = useMemo(() => fin.analysis(ws, s, e, type, q), [version, ws, s, e, type, q]);
  const t = res.totals;
  return (
    <div>
      <div class="page-head">
        <h1 class="grow">Custom Analysis</h1>
        <Seg value={mode} onChange={setMode} options={[['WTD', 'Week to date'], ['MTD', 'Month to date'], ['CUSTOM', 'Custom']]} />
        {mode === 'CUSTOM' && <>
          <input type="date" style={{ width: 'auto' }} value={start} onInput={(ev) => setStart(ev.currentTarget.value)} />
          <span class="muted">→</span>
          <input type="date" style={{ width: 'auto' }} value={end} onInput={(ev) => setEnd(ev.currentTarget.value)} />
        </>}
      </div>
      <div class="muted small" style={{ marginBottom: 10 }}>{fmtDate(s)} to {fmtDate(e)}</div>
      <div class="grid c3" style={{ marginBottom: 14 }}>
        <Stat label="Income" value={t.income} /><Stat label="Expenses" value={t.expenses} /><Stat label="Bills" value={t.bills} />
        <Stat label="Debt" value={t.debt} /><Stat label="Savings" value={t.savings} /><Stat label="Net cashflow" value={t.net} tone cls="focal" />
      </div>
      <div class="row wrap" style={{ marginBottom: 8 }}>
        <h2 class="grow">Category breakdown</h2>
        <div style={{ flex: '1 1 150px', maxWidth: 200 }}><Select value={type} onChange={setType} options={[[null, 'All types'], ...TX_TYPES.map((x) => [x, x])]} /></div>
        <input type="search" style={{ flex: '1 1 150px', width: 'auto', maxWidth: 240 }} placeholder="Filter categories…" value={q} onInput={(ev) => setQ(ev.currentTarget.value)} />
      </div>
      <div class="tablewrap">
        <table class="t">
          <thead><tr><th>Category</th><th class="hide-sm">Type</th><th class="money">Count</th><th class="money">Total</th><th class="money">%</th><th class="hide-sm" style={{ width: '28%' }} /></tr></thead>
          <tbody>
            {res.categories.map((c) => (
              <tr key={c.category + c.type} style={{ cursor: 'pointer' }} onClick={() => go('tx', { category: c.category, range: true, start: s, end: e })}>
                <td>{c.category}</td><td class="hide-sm muted">{c.type}</td><td class="money">{c.count}</td>
                <td class="money"><Money v={c.total} /></td><td class="money">{c.pct.toFixed(1)}%</td>
                <td class="hide-sm"><Bar pct={c.pct} color={c.type === 'Income' ? 'var(--emerald)' : 'var(--text)'} /></td>
              </tr>
            ))}
            {!res.categories.length && <tr><td colSpan={6}><Empty>Nothing in this period.</Empty></td></tr>}
          </tbody>
        </table>
      </div>
    </div>
  );
}
