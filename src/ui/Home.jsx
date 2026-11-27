import { useMemo, useState } from 'preact/hooks';
import { fmtDate, fmtMoney, monthKey, monthLabel, round2, shiftMonth } from '../lib/util.js';
import { Bar, Donut, Empty, Icon, Money, Pill, Seg, Sparkline, Stat, TxRow, useApp, useCatColors } from './components.jsx';

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

function PoolCard({ m, active, onPick, month }) {
  const { open } = useApp();
  const over = m.available < -0.004;
  return (
    <div class={`card pool ${active ? 'on' : ''}`} onClick={onPick}>
      <div class="row">
        <div class="icon" style={{ background: `${m.color}22` }}>{m.icon || '💷'}</div>
        <div class="grow">
          <div style={{ fontWeight: 650 }}>{m.name}</div>
          <div class="row" style={{ gap: 4, marginTop: 2 }}>
            {!m.isWorkspaceConnected && <Pill tone="amber">Standalone</Pill>}
            {m.isDefault && <Pill tone="dark">Default</Pill>}
            {m.filledThisMonth && m.monthly > 0 && <Pill tone="emerald">Filled ✓</Pill>}
          </div>
        </div>
      </div>
      <div>
        <div class="eyebrow">Money in this pool</div>
        <div class={`left ${over ? 'neg' : ''}`}>{fmtMoney(m.available)}</div>
      </div>
      <Bar pct={m.pctSpent} color={over ? 'var(--rose)' : m.pctSpent >= 90 ? 'var(--amber)' : m.color} />
      <div class={`small ${over ? 'neg' : 'muted'}`}>{over ? `Overspent by ${fmtMoney(-m.available)}` : `${fmtMoney(m.spent)} spent ${month ? 'this month' : 'in total'}`}</div>
      <div class="nums">
        <div><div class="eyebrow" style={{ fontSize: 10 }}>Monthly amount</div><div class="v">{fmtMoney(m.monthly)}</div></div>
        <div><div class="eyebrow" style={{ fontSize: 10 }}>Spent</div><div class="v">{fmtMoney(m.spent)}</div></div>
      </div>
      {over
        ? <button class="btn danger block" onClick={(e) => { e.stopPropagation(); open('cover', { metric: m }); }}>Cover {fmtMoney(-m.available)}</button>
        : <button class="btn primary block" onClick={(e) => { e.stopPropagation(); open('push', { metric: m }); }}>+ Assign money</button>}
      <div class="row" onClick={(e) => e.stopPropagation()}>
        <button class="btn sm ghost" onClick={() => open('pool', { pool: m })}>Edit</button>
        <button class="btn sm ghost" onClick={() => open('quick', { mode: 'realloc', prefill: { kind: 'pool', fromId: m.id } })}>⇄ Move money</button>
        <span class="spacer" />
        <button class="btn sm ghost danger" onClick={() => open('deletePool', { metric: m })}>Delete</button>
      </div>
    </div>
  );
}

/** The zero-based budget bar: how much is left to give a job, and the next thing to do. */
function AssignBar({ head, ws }) {
  const { fin, open, toast } = useApp();
  const left = head.toAssign;
  const zero = Math.abs(left) < 0.005;
  const fill = () => {
    const r = fin.fillPools(ws);
    if (!r.done.length) toast('Nothing to fill: add income first, or every pool is already filled this month.');
    else toast(`Filled ${r.done.length} pool${r.done.length === 1 ? '' : 's'} with ${fmtMoney(r.total)}${r.short.length ? ` · not enough for all of ${r.short.join(', ')}` : ''}`);
  };
  const tone = left < -0.004 ? 'over' : zero ? 'done' : 'todo';
  return (
    <div class={`card assignbar ${tone}`} id="assignbar">
      <div class="grow">
        <div class="eyebrow">Left to assign</div>
        <div class="atotal">{fmtMoney(left)}</div>
        <div class="small">
          {left < -0.004 ? `You've put ${fmtMoney(-left)} more into pools than you have. Take some back from a pool.`
            : zero ? '✓ Every pound has a job. Your budget is balanced.'
              : 'Give every pound a job: assign this to your pools until it reads £0.00.'}
        </div>
        {head.overspent.length > 0 && (
          <div class="small neg" style={{ marginTop: 4 }}>⚠ Overspent: {head.overspent.map((m) => `${m.name} (${fmtMoney(-m.available)})`).join(', ')}. Tap “Cover” on the pool.</div>
        )}
      </div>
      <div class="row wrap" style={{ gap: 8 }}>
        {head.fillCount > 0 && left > 0.004 && (
          <button class="btn primary" onClick={fill}>Fill pools · {fmtMoney(head.fillNeeded)}</button>
        )}
        {left > 0.004 && <button class="btn" onClick={() => open('push', {})}>Assign…</button>}
        {left < -0.004 && <button class="btn" onClick={() => open('push', { takeBack: true })}>Take money back</button>}
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
  const others = fin.categories(ws).filter((c) => c.poolId !== m.id && c.defaultType !== 'Income');
  const poolNames = Object.fromEntries(pools.map((p) => [p.id, p.name]));
  const feed = fin.poolTransfers(ws, m.id);
  const over = m.available < -0.004;
  const planDiff = round2(m.budgetedLines - (m.fundingValue || 0));
  return (
    <div class="card" style={{ marginTop: 4 }} id="sector">
      <div class="row wrap sector-head" style={{ marginBottom: 14 }}>
        <div class="row" style={{ flex: '1 1 260px', minWidth: 0 }}>
          <div class="icon" style={{ width: 42, height: 42, borderRadius: '50%', display: 'grid', placeItems: 'center', fontSize: 20, background: `${m.color}22`, flex: 'none' }}>{m.icon}</div>
          <div style={{ minWidth: 0 }}>
            <h2>{m.name}</h2>
            <div class="muted small">{m.description || (m.isWorkspaceConnected ? 'Funded from your bank accounts' : 'Standalone pool: outside money')}</div>
          </div>
        </div>
        <button class="btn" onClick={() => open('quick', { mode: 'realloc', prefill: { kind: 'pool', toId: m.id } })}>⇄ Move money</button>
        <button class="btn primary" onClick={() => open('quick', { mode: 'tx', prefill: { poolId: m.id } })}>+ Log transaction</button>
      </div>
      <div class="grid c4">
        <Stat label="Money in this pool" value={m.available} cls={`focal ${over ? 'over' : ''}`} sub={over ? 'Overspent: tap Cover' : 'Goes down as you spend, carries over'} />
        <Stat label="Monthly amount" value={m.monthly} sub={m.filledThisMonth ? 'Filled this month ✓' : 'Not filled this month yet'}>
          <button class="btn sm" style={{ marginTop: 6 }} onClick={() => open(over ? 'cover' : 'push', { metric: m })}>{over ? 'Cover' : '+ Assign'}</button>
        </Stat>
        <Stat label="Spent" value={m.spent} sub={month ? monthLabel(month) : 'All time'} />
        <Stat label="Planned in categories" value={m.budgetedLines} sub={`${m.lines.length} categor${m.lines.length === 1 ? 'y' : 'ies'} · optional`} />
      </div>
      {planDiff > 0.004 && (
        <div class="notice" style={{ marginTop: 12 }}>Your category plans add up to {fmtMoney(planDiff)} more than this pool's monthly amount, so the monthly amount uses the category total.</div>
      )}
      <div class="row wrap sector-tools" style={{ margin: '14px 0 10px' }}>
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
      <div class="mlist">
        {lines.map((l) => (
          <div class="mitem" key={l.id}>
            <div class="top">
              <span class="swatch" style={{ background: l.color }} />
              <span class="name grow">{l.name}</span>{l.isProtected && <Pill>Core</Pill>}
              <Money v={l.remaining} tone class="big" />
            </div>
            <Bar pct={l.pctUsed} />
            <div class="acts">
              <span class="small muted">Spent <Money v={l.spent} /> of plan</span>
              <AllocInput line={l} />
              <span class="spacer" />
              <button class="btn sm" onClick={() => open('category', { cat: l })}>Edit</button>
            </div>
          </div>
        ))}
        {!lines.length && <Empty>No category lines {filter !== 'ALL' ? 'of this type ' : ''}in this pool yet. Use “+ New line” or pull a category in.</Empty>}
      </div>
      <div class="tablewrap desk">
        <table class="t">
          <thead><tr>
            <th>Category</th><th class="hide-sm">Type</th><th class="hide-sm">Pool</th><th class="money">Monthly plan</th><th class="money">Spent</th>
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
                  <button class="btn sm ghost" onClick={() => open('category', { cat: l })}>Edit</button>
                </td>
              </tr>
            ))}
            {!lines.length && <tr><td colSpan={8}><Empty>No category lines {filter !== 'ALL' ? 'of this type ' : ''}in this pool yet. Use “+ New line” or pull a category in.</Empty></td></tr>}
          </tbody>
        </table>
      </div>
      <button class="btn ghost sm" style={{ marginTop: 10 }} onClick={() => setShowFeed(!showFeed)}>{showFeed ? '▾' : '▸'} Money moves ({feed.length})</button>
      {showFeed && (
        <div class="tablewrap" style={{ marginTop: 6 }}>
          <table class="t">
            <thead><tr><th>Date</th><th>From</th><th>To</th><th class="money">Amount</th><th class="hide-sm">Note</th></tr></thead>
            <tbody>
              {feed.map((f) => <tr key={f.id}><td class="nowrap">{fmtDate(f.date)}</td><td>{f.fromPoolName}</td><td>{f.toPoolName}</td><td class="money"><Money v={f.amount} /></td><td class="hide-sm muted">{f.note}</td></tr>)}
              {!feed.length && <tr><td colSpan={5}><Empty>No money assigned or moved yet.</Empty></td></tr>}
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
  const { fin, ws, month, open, go, workspace, version } = useApp();
  const colors = useCatColors();
  const latest = useMemo(() => fin.transactions(ws, {}).slice(0, 5), [version, ws]);
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
          <div class="sub">{workspace?.name} · zero-based budget · {month ? monthLabel(month) : 'All time'}</div>
        </div>
        <MonthBar />
      </div>
      <div class="hero">
        <div class="card balance-card">
          <div class="balance">
            <div class="b-label">Money at hand</div>
            <div class="b-sub">GBP · across {accounts} bank account{accounts === 1 ? '' : 's'}</div>
            <div class={`mah ${head.moneyAtHand < 0 ? 'neg' : ''}`}>{fmtMoney(head.moneyAtHand)}</div>
            <div class="kpis">
              <div><div class="k">In pools</div><div class="v">{fmtMoney(head.inPools)}</div></div>
              <div><div class="k">Left to assign</div><div class={`v ${Math.abs(head.toAssign) > 0.004 ? 'warn' : ''}`}>{fmtMoney(head.toAssign)}</div></div>
              {head.owed > 0.004 && <div><div class="k">Overdrawn (not counted)</div><div class="v warn">{fmtMoney(-head.owed)}</div></div>}
              {Math.abs(head.standalone) > 0.004 && <div><div class="k">Standalone</div><div class="v">{fmtMoney(head.standalone)}</div></div>}
            </div>
          </div>
          <div class="actions">
            <button onClick={() => open('quick', { mode: 'tx' })}><span class="ib"><Icon name="plus" /></span>Add</button>
            <button onClick={() => open('quick', { mode: 'transfer' })}><span class="ib"><Icon name="transfer" /></span>Transfer</button>
            <button onClick={() => open('pool', {})}><span class="ib"><Icon name="pool" /></span>New pool</button>
            <button onClick={() => open('import')}><span class="ib"><Icon name="upload" /></span>Import</button>
          </div>
          <div class="spark">
            <div class="row small muted"><span class="grow">Balance · last 30 days</span><span class="money">{fmtMoney(series[series.length - 1]?.[1])}</span></div>
            <Sparkline data={series} height={70} />
          </div>
        </div>
        <div class="card">
          <div class="card-head"><h3>Latest transactions</h3><button class="link" onClick={() => go('tx')}>See all</button></div>
          <div class="txrows inset">
            {latest.map((t) => (
              <TxRow key={t.id} t={t} color={colors[(t.category || '').toLowerCase()]} sub={`${fmtDate(t.date)} · ${t.category}`}
                onClick={() => open('quick', { mode: 'tx', prefill: t })} />
            ))}
            {!latest.length && <Empty>No transactions yet. Tap “Add” to log one.</Empty>}
          </div>
        </div>
        <div class="card">
          <h3 style={{ marginBottom: 12 }}>Spending by category</h3>
          <div class="donut-wrap">
            <Donut items={top} center={fmtMoney(totalSpend).replace(/\.\d\d$/, '')} sub={month ? 'spent this month' : 'spent all time'} />
            <div class="legend">
              {top.map(([n, v, c]) => (
                <div class="li" key={n}><span class="swatch" style={{ background: c }} /><span class="n">{n}</span>
                  <span class="money">{fmtMoney(v)}</span><span class="faint hide-sm" style={{ width: 32, textAlign: 'right' }}>{totalSpend ? Math.round(v / totalSpend * 100) : 0}%</span></div>
              ))}
              {!top.length && <div class="muted">No spending yet.</div>}
            </div>
          </div>
        </div>
      </div>

      <AssignBar head={head} ws={ws} />

      <div class="card flat" style={{ padding: 8, borderRadius: 999, marginTop: 16 }}>
        <input type="search" style={{ borderRadius: 999, background: 'transparent' }} placeholder="🔍  Find a category across all pools…" value={q} onInput={(e) => setQ(e.currentTarget.value)} />
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
        {metrics.map((m) => <PoolCard key={m.id} m={m} month={month} active={cur && cur.id === m.id} onPick={() => pick(m.id)} />)}
      </div>
      {cur && <Sector m={cur} metrics={metrics} />}
    </div>
  );
}
