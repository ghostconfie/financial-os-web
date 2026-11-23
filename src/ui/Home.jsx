import { useMemo, useState } from 'preact/hooks';
import { fmtDate, fmtMoney, monthKey, monthLabel, shiftMonth } from '../lib/util.js';
import { Bar, Donut, Empty, Money, Pill, Seg, Sparkline, Stat, useApp } from './components.jsx';

const FILTERS = [['ALL', 'All'], ['Expense', 'Expenses'], ['Bills', 'Bills'], ['Debt Payment', 'Debt'], ['Savings', 'Savings'], ['Investment', 'Investments']];

export function MonthBar() {
  const { month, setMonth } = useApp();
  const all = month === null;
  const cur = monthKey();
  return (
    <div class="row wrap">
      <button class="iconbtn" disabled={all} onClick={() => setMonth(shiftMonth(month, -1))} aria-label="Previous month">‹</button>
      <div style={{ minWidth: 130, textAlign: 'center', fontWeight: 650 }}>{all ? 'All time' : monthLabel(month)}</div>
      <button class="iconbtn" disabled={all} onClick={() => setMonth(shiftMonth(month, 1))} aria-label="Next month">›</button>
      {!all && month === cur ? <Pill tone="emerald">Current month</Pill>
        : <button class="btn sm ghost" onClick={() => setMonth(cur)}>Go to current</button>}
      <button class={`btn sm ${all ? 'primary' : ''}`} onClick={() => setMonth(all ? cur : null)}>All-time</button>
    </div>
  );
}

function PoolCard({ m, active, onPick }) {
  const { open } = useApp();
  const over = m.leftToSpend < -0.004;
  return (
    <div class={`card pool ${active ? 'on' : ''}`} onClick={onPick}>
      <div class="row">
        <div class="icon" style={{ background: `${m.color}22` }}>{m.icon || '💷'}</div>
        <div class="grow">
          <div style={{ fontWeight: 650 }}>{m.name}</div>
          <div class="row" style={{ gap: 4, marginTop: 2 }}>
            <Pill tone={m.isWorkspaceConnected ? '' : 'amber'}>{m.isWorkspaceConnected ? 'Connected' : 'Standalone'}</Pill>
            {m.isDefault && <Pill tone="dark">Default</Pill>}
            {m.fundingMode === 'percent' && <Pill>{m.fundingValue}% of cash</Pill>}
          </div>
        </div>
      </div>
      <div>
        <div class="eyebrow">Money left to spend</div>
        <div class={`left ${over ? 'neg' : ''}`}>{fmtMoney(m.leftToSpend)}</div>
      </div>
      <Bar pct={m.pctSpent} color={over ? 'var(--rose)' : m.pctSpent >= 90 ? 'var(--amber)' : m.color} />
      <div class={`small ${over ? 'neg' : 'muted'}`}>{Math.round(m.pctSpent)}% spent{over ? ' · overspent' : ''}</div>
      <div class="nums">
        <div><div class="eyebrow" style={{ fontSize: 10 }}>Allocated</div><div class="v">{fmtMoney(m.allocatedBudget)}</div></div>
        <div><div class="eyebrow" style={{ fontSize: 10 }}>Spent</div><div class="v">{fmtMoney(m.spent)}</div></div>
        <div><div class="eyebrow" style={{ fontSize: 10 }}>Budgeted lines</div><div class="v">{fmtMoney(m.budgetedLines)}</div></div>
      </div>
      <button class="btn primary block" onClick={(e) => { e.stopPropagation(); open('push', { metric: m }); }}>
        {m.isWorkspaceConnected ? '+ Push funds from cash at hand' : '+ Raise target budget'}
      </button>
      <div class="row" onClick={(e) => e.stopPropagation()}>
        <button class="btn sm ghost" onClick={() => open('pool', { pool: m })}>Edit</button>
        <button class="btn sm ghost" onClick={() => open('quick', { mode: 'realloc', prefill: { kind: 'pool', fromId: m.id } })}>⇄ Pool transfer</button>
        <span class="spacer" />
        <button class="btn sm ghost danger" onClick={() => open('deletePool', { metric: m })}>Delete</button>
      </div>
    </div>
  );
}

function Sector({ m, metrics }) {
  const { fin, ws, month, open } = useApp();
  const [filter, setFilter] = useState('ALL');
  const [sort, setSort] = useState('Default');
  const [showFeed, setShowFeed] = useState(false);
  const pools = fin.pools(ws);
  let lines = m.lines.filter((l) => filter === 'ALL' || l.defaultType === filter);
  if (sort === 'Lowest Remaining') lines = [...lines].sort((a, b) => a.remaining - b.remaining);
  if (sort === 'Highest % Used') lines = [...lines].sort((a, b) => b.pctUsed - a.pctUsed);
  const un = m.unassigned;
  const others = fin.categories(ws).filter((c) => c.poolId !== m.id && c.defaultType !== 'Income');
  const poolNames = Object.fromEntries(pools.map((p) => [p.id, p.name]));
  const feed = fin.poolTransfers(ws, m.id);
  const over = m.leftToSpend < -0.004;
  return (
    <div class="card" style={{ marginTop: 4 }} id="sector">
      <div class="row wrap" style={{ marginBottom: 12 }}>
        <div class="row grow">
          <div class="icon" style={{ width: 38, height: 38, borderRadius: 10, display: 'grid', placeItems: 'center', fontSize: 20, background: `${m.color}22` }}>{m.icon}</div>
          <div>
            <h2>{m.name} · Zero-based budget</h2>
            <div class="muted small">{m.description || (m.isWorkspaceConnected ? 'Connected to Money at Hand' : 'Standalone pool with its own target')}</div>
          </div>
        </div>
        <button class="btn" onClick={() => open('quick', { mode: 'realloc', prefill: { kind: 'category' } })}>Reallocate</button>
        <button class="btn primary" onClick={() => open('quick', { mode: 'tx', prefill: { poolId: m.id } })}>+ Log transaction</button>
      </div>
      <div class="grid c5">
        <Stat label="Money left to spend" value={m.leftToSpend} cls={`focal ${over ? 'over' : ''}`} sub={over ? 'Overspent: cover it below' : 'Counts down as you spend'} />
        <Stat label="Allocated pool budget" value={m.allocatedBudget}
          sub={m.fundingMode === 'percent' ? `${m.fundingValue}% of Money at Hand` : !m.isWorkspaceConnected ? 'Standalone target' : 'Fixed'}>
          <button class="btn sm" style={{ marginTop: 6 }} onClick={() => open('push', { metric: m })}>+ Add cash</button>
        </Stat>
        <Stat label="Spent" value={m.spent} sub={month ? monthLabel(month) : 'All time'} />
        <Stat label="Budgeted to categories" value={m.budgetedLines} sub={`${m.lines.length} category line${m.lines.length === 1 ? '' : 's'}`} />
        <Stat label="Unassigned in pool" value={un} cls={Math.abs(un) < 0.005 ? '' : ''}
          sub={Math.abs(un) < 0.005 ? 'Every pound has a job ✓' : 'Assign to lines'} />
      </div>
      {Math.abs(un) >= 0.005 && (
        <div class="notice" style={{ marginTop: 12 }}>⚠ {fmtMoney(un)} in {m.name} isn't assigned to a category yet. Give every pound a job until Unassigned reads £0.00.</div>
      )}
      <div class="row wrap" style={{ margin: '14px 0 10px' }}>
        <Seg value={filter} onChange={setFilter} options={FILTERS} />
        <span class="spacer" />
        <select style={{ width: 'auto' }} value={sort} onChange={(e) => setSort(e.currentTarget.value)}>
          {['Default', 'Lowest Remaining', 'Highest % Used'].map((s) => <option key={s}>{s}</option>)}
        </select>
        <select style={{ width: 'auto', maxWidth: 260 }} value="" onChange={(e) => { const v = e.currentTarget.value; if (v) fin.setCategoryPool(v, m.id); }}>
          <option value="">Pull a category into this pool…</option>
          {others.map((c) => <option key={c.id} value={c.id}>{c.name} ({poolNames[c.poolId] || 'Unpooled'})</option>)}
        </select>
        <button class="btn" onClick={() => open('category', { prefill: { poolId: m.id } })}>+ New line</button>
      </div>
      <div class="tablewrap">
        <table class="t">
          <thead><tr>
            <th>Category</th><th class="hide-sm">Type</th><th class="hide-sm">Pool</th><th class="money">Allocated</th><th class="money">Spent</th>
            <th class="money">Remaining</th><th class="hide-sm" style={{ width: 140 }}>% used</th><th />
          </tr></thead>
          <tbody>
            {lines.map((l) => (
              <tr key={l.id}>
                <td><div class="row"><span class="swatch" style={{ background: l.color }} />{l.name}{l.isProtected && <Pill>Core</Pill>}</div></td>
                <td class="hide-sm muted">{l.defaultType}</td>
                <td class="hide-sm">
                  <select value={l.poolId || ''} onChange={(e) => fin.setCategoryPool(l.id, e.currentTarget.value || null)}>
                    {pools.map((p) => <option key={p.id} value={p.id}>{p.icon} {p.name}</option>)}
                    <option value="">— Unpooled —</option>
                  </select>
                </td>
                <td class="money"><AllocInput line={l} /></td>
                <td class="money"><Money v={l.spent} /></td>
                <td class="money"><Money v={l.remaining} tone /></td>
                <td class="hide-sm"><div class="row"><div class="grow"><Bar pct={l.pctUsed} /></div><span class={`small ${l.pctUsed > 100 ? 'neg' : 'muted'}`} style={{ width: 52, textAlign: 'right' }}>{!l.allocated && l.spent ? 'no budget' : `${Math.round(l.pctUsed)}%`}</span></div></td>
                <td class="right nowrap">
                  {l.remaining < -0.004
                    ? <button class="btn sm danger" onClick={() => open('cover', { line: l, metric: m, metrics })}>Cover {fmtMoney(-l.remaining)}</button>
                    : <button class="btn sm ghost" onClick={() => open('category', { cat: l })}>Edit</button>}
                </td>
              </tr>
            ))}
            {!lines.length && <tr><td colSpan={8}><Empty>No category lines {filter !== 'ALL' ? 'of this type ' : ''}in this pool yet. Use “+ New line” or pull a category in.</Empty></td></tr>}
          </tbody>
        </table>
      </div>
      <button class="btn ghost sm" style={{ marginTop: 10 }} onClick={() => setShowFeed(!showFeed)}>{showFeed ? '▾' : '▸'} Pool transfer activity ({feed.length})</button>
      {showFeed && (
        <div class="tablewrap" style={{ marginTop: 6 }}>
          <table class="t">
            <thead><tr><th>Date</th><th>From</th><th>To</th><th class="money">Amount</th><th class="hide-sm">Note</th></tr></thead>
            <tbody>
              {feed.map((f) => <tr key={f.id}><td class="nowrap">{fmtDate(f.date)}</td><td>{f.fromPoolName}</td><td>{f.toPoolName}</td><td class="money"><Money v={f.amount} /></td><td class="hide-sm muted">{f.note}</td></tr>)}
              {!feed.length && <tr><td colSpan={5}><Empty>No transfers in or out of this pool yet.</Empty></td></tr>}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function AllocInput({ line }) {
  const { fin } = useApp();
  const [v, setV] = useState(null);
  const commit = () => {
    if (v === null) return;
    const n = parseFloat(v);
    if (!Number.isNaN(n) && Math.abs(n - line.allocated) > 0.004) fin.setCategoryAllocated(line.id, n);
    setV(null);
  };
  return (
    <input class="inline" type="number" step="0.01" min="0" value={v ?? line.allocated.toFixed(2)}
      onFocus={(e) => e.currentTarget.select()} onInput={(e) => setV(e.currentTarget.value)} onBlur={commit}
      onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); e.currentTarget.blur(); } }} aria-label={`Allocated for ${line.name}`} />
  );
}

export function Home() {
  const { fin, ws, month, open, workspace, version } = useApp();
  const [active, setActive] = useState(null);
  const [q, setQ] = useState('');
  const metrics = useMemo(() => fin.poolMetrics(ws, month), [version, ws, month]);
  const head = fin.header(ws, month, metrics);
  const accounts = fin.accounts(ws).length;
  const series = useMemo(() => fin.balanceSeries(ws, 30), [version, ws]);
  const spend = useMemo(() => fin.spendByCategory(ws, month), [version, ws, month]);
  const top = spend.slice(0, 5);
  if (spend.length > 5) top.push(['Other', spend.slice(5).reduce((s, r) => s + r[1], 0), '#a1a1aa']);
  const totalSpend = spend.reduce((s, r) => s + r[1], 0);
  const cur = metrics.find((m) => m.id === active) || metrics.find((m) => m.isDefault) || metrics[0];
  const hits = q.trim() ? fin.categoryLookup(ws, q, month) : [];
  const pick = (id) => { setActive(id); setTimeout(() => document.getElementById('sector')?.scrollIntoView({ behavior: 'smooth', block: 'start' }), 30); };

  return (
    <div>
      <div class="page-head">
        <div class="grow">
          <h1>Budget Pools</h1>
          <div class="sub">{workspace?.name} · zero-based budgeting · {month ? monthLabel(month) : 'All time'}</div>
        </div>
        <MonthBar />
      </div>
      <div class="hero">
        <div class="card main">
          <div>
            <div class="eyebrow">Money at hand</div>
            <div class={`mah ${head.moneyAtHand < 0 ? 'neg' : ''}`}>{fmtMoney(head.moneyAtHand)}</div>
            <div class="muted small">Across {accounts} bank account{accounts === 1 ? '' : 's'}</div>
            <div class="kpis">
              <div><div class="eyebrow">Assigned to pools</div><div class="v">{fmtMoney(head.assigned)}</div></div>
              <div><div class="eyebrow">Unpooled</div><div class={`v ${head.unpooled > 0 ? 'warn' : ''}`}>{fmtMoney(head.unpooled)}</div></div>
              <div><div class="eyebrow">Standalone targets</div><div class="v">{fmtMoney(head.standalone)}</div></div>
            </div>
            {head.unpooled > 0.004 && <div class="small warn" style={{ marginTop: 8 }}>{fmtMoney(head.unpooled)} of cash isn't assigned to a pool yet.</div>}
          </div>
          <div class="col">
            <div class="row"><span class="muted small grow">Balance · last 30 days</span><button class="btn primary sm" onClick={() => open('pool', {})}>+ New pool</button></div>
            <Sparkline data={series} height={118} />
            <div class="row small faint"><span class="grow">{fmtDate(series[0]?.[0])}</span><span>{fmtMoney(series[series.length - 1]?.[1])}</span></div>
          </div>
        </div>
        <div class="card">
          <h3 style={{ marginBottom: 10 }}>Spending by category</h3>
          <div class="donut-wrap">
            <Donut items={top} center={fmtMoney(totalSpend).replace(/\.\d\d$/, '')} sub={month ? 'spent this month' : 'spent all time'} />
            <div class="legend">
              {top.map(([n, v, c]) => (
                <div class="li" key={n}><span class="swatch" style={{ background: c }} /><span class="n">{n}</span>
                  <span class="money">{fmtMoney(v)}</span><span class="faint" style={{ width: 32, textAlign: 'right' }}>{totalSpend ? Math.round(v / totalSpend * 100) : 0}%</span></div>
              ))}
              {!top.length && <div class="muted">No spending yet.</div>}
            </div>
          </div>
        </div>
      </div>

      <div class="card flat" style={{ padding: 10 }}>
        <input type="search" placeholder="🔍  Find a category across all pools…" value={q} onInput={(e) => setQ(e.currentTarget.value)} />
        {q.trim() && (
          <div class="col" style={{ marginTop: 8, gap: 6 }}>
            {hits.map((h) => (
              <div class="strip row wrap" key={h.id} style={{ cursor: 'pointer' }} onClick={() => { if (h.poolId) pick(h.poolId); setQ(''); }}>
                <span class="swatch" style={{ background: h.color }} /><b class="grow">{h.name}</b>
                <Pill>{h.poolName ? `${h.poolIcon} ${h.poolName}` : 'Unpooled'}</Pill>
                <span class="small muted">Allocated <Money v={h.allocated} /></span>
                <span class="small muted">Spent <Money v={h.spent} /></span>
                <span class="small muted">Left <Money v={h.remaining} tone /></span>
              </div>
            ))}
            {!hits.length && <div class="muted small">No category matches.</div>}
          </div>
        )}
      </div>

      <div class="pools">
        {metrics.map((m) => <PoolCard key={m.id} m={m} active={cur && cur.id === m.id} onPick={() => pick(m.id)} />)}
      </div>
      {cur && <Sector m={cur} metrics={metrics} />}
    </div>
  );
}
