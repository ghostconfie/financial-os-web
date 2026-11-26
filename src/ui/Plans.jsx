// Plans & Forecast: a simple place to think about what to do with money.
// Possible purchases (with their extra and ongoing costs), a savings forecast, and notes.

import { useEffect, useMemo, useState } from 'preact/hooks';
import { fmtMoney, monthKey, monthShort, shiftMonth } from '../lib/util.js';
import { Empty, Field, Modal, Money, MoneyInput, Pill, Seg, Select, Stat, useApp } from './components.jsx';

const num = (v) => (v === '' || v === null || v === undefined ? 0 : parseFloat(v) || 0);
const STATUS = [['idea', 'Idea'], ['saving', 'Saving up'], ['bought', 'Bought']];
const STATUS_TONE = { idea: '', saving: 'amber', bought: 'emerald' };
const fmtWhen = (m) => (m ? monthShort(m) : 'Not sure yet');

export function Plans() {
  const { fin, ws, open, version } = useApp();
  const items = fin.planItems(ws);
  const notes = fin.planNotes(ws);
  const settings = fin.forecastSettings(ws);
  const fc = useMemo(() => fin.forecast(ws, settings), [version, ws]);
  const active = items.filter((p) => p.status !== 'bought');
  const oneOff = active.reduce((s, p) => s + p.cost + p.extraCost, 0);
  const monthly = active.reduce((s, p) => s + p.monthlyCost, 0);
  const endVal = settings.includePlans ? fc.end.withPlans : fc.end.plain;

  return (
    <div>
      <div class="page-head">
        <div class="grow"><h1>Plans &amp; Forecast</h1><div class="sub">Think through what to buy, what it costs to keep, and how your money could grow.</div></div>
        <button class="btn primary" onClick={() => open('planItem', {})}>+ Add purchase</button>
      </div>

      <div class="grid c3" style={{ marginBottom: 14 }}>
        <Stat label="Planned purchases" value={oneOff} sub={`${active.length} not bought yet · price + extras`} />
        <Stat label="Ongoing costs" value={monthly} sub={`a month once bought · ${fmtMoney(monthly * 12)} a year`} />
        <Stat label={`In ${settings.years} year${settings.years === 1 ? '' : 's'}`} value={endVal} cls="focal" tone
          sub={settings.includePlans && active.some((p) => p.targetMonth) ? 'after planned purchases' : 'if you keep saving'} />
      </div>

      <Forecast settings={settings} fc={fc} />

      <div class="grid c2 plans-grid" style={{ marginTop: 14 }}>
        <div class="card">
          <div class="card-head"><h3>Possible purchases</h3><button class="btn sm" onClick={() => open('planItem', {})}>+ Add</button></div>
          <div class="col" style={{ gap: 10 }}>
            {items.map((p) => <PlanCard key={p.id} p={p} afford={fc.afford[p.id]} />)}
            {!items.length && <Empty>Nothing here yet. Add something you're thinking of buying, like a car, a laptop or a holiday, with its price and any running costs.</Empty>}
          </div>
        </div>
        <Notes notes={notes} />
      </div>
    </div>
  );
}

function PlanCard({ p, afford }) {
  const { fin, open } = useApp();
  const firstYear = p.cost + p.extraCost + p.monthlyCost * 12;
  return (
    <div class="mitem">
      <div class="top">
        <div class="grow" style={{ minWidth: 0 }}>
          <div class="name">{p.name}</div>
          <div class="small muted">{fmtWhen(p.targetMonth)}</div>
        </div>
        <div class="col" style={{ alignItems: 'flex-end' }}>
          <Money v={p.cost + p.extraCost} class="big" />
          <Pill tone={STATUS_TONE[p.status]}>{STATUS.find((s) => s[0] === p.status)?.[1] || 'Idea'}</Pill>
        </div>
      </div>
      <div class="plan-costs small">
        <span>Price <b><Money v={p.cost} /></b></span>
        {p.extraCost > 0 && <span>Extras <b><Money v={p.extraCost} /></b></span>}
        {p.monthlyCost > 0 && <span>Then <b><Money v={p.monthlyCost} /></b>/month</span>}
        {p.monthlyCost > 0 && <span>First year <b><Money v={firstYear} /></b></span>}
      </div>
      {p.status !== 'bought' && (
        <div class="small muted">
          {afford === 'now' ? '✓ You have enough for this now.' : afford ? `On your forecast you'd have enough by ${monthShort(afford)}.` : 'Not reached within your forecast. Try saving more each month.'}
        </div>
      )}
      {p.notes && <div class="small" style={{ whiteSpace: 'pre-wrap' }}>{p.notes}</div>}
      <div class="acts">
        <span class="spacer" />
        <button class="btn sm ghost" onClick={() => open('planItem', { item: p })}>Edit</button>
        <button class="btn sm ghost danger" aria-label="Delete" onClick={() => open('confirm', { title: `Delete ${p.name}?`, label: 'Delete', action: () => fin.deletePlanItem(p.id) })}>✕</button>
      </div>
    </div>
  );
}

function Forecast({ settings, fc }) {
  const { fin, ws } = useApp();
  const [d, setD] = useState(settings);
  useEffect(() => setD(settings), [ws, settings.id, settings.updatedAt]);
  const save = (fields) => { const n = { ...d, ...fields }; setD(n); fin.saveForecastSettings(ws, n); };
  const set = (k) => (e) => setD({ ...d, [k]: e.currentTarget.value });
  const blur = (k) => (e) => { const v = num(e.currentTarget.value); if (v !== settings[k] || !settings.id) save({ [k]: v }); };
  const hasDated = fin.planItems(ws).some((p) => p.status !== 'bought' && p.targetMonth);

  return (
    <div class="card">
      <div class="card-head"><h3>How your money could grow</h3></div>
      <div class="form fc-inputs">
        <div class="field">
          <span>Start from</span>
          <Seg value={d.useMoneyAtHand ? 'mah' : 'own'} onChange={(v) => save({ useMoneyAtHand: v === 'mah' })}
            options={[['mah', `Money at hand (${fmtMoney(fin.moneyAtHand(ws))})`], ['own', 'My own amount']]} />
        </div>
        {!d.useMoneyAtHand && (
          <Field label="Starting amount (£)">
            <input type="number" inputMode="decimal" step="0.01" value={d.startAmount} onInput={set('startAmount')} onChange={blur('startAmount')} onBlur={blur('startAmount')} />
          </Field>
        )}
        <Field label="Saving each month (£)">
          <input type="number" inputMode="decimal" step="0.01" value={d.monthlySaving} onInput={set('monthlySaving')} onChange={blur('monthlySaving')} onBlur={blur('monthlySaving')} />
        </Field>
        <Field label="Interest (% a year)">
          <input type="number" inputMode="decimal" step="0.1" value={d.interestRate} onInput={set('interestRate')} onChange={blur('interestRate')} onBlur={blur('interestRate')} />
        </Field>
        <Field label="Years ahead">
          <Select value={String(d.years)} onChange={(v) => save({ years: +v })} options={[1, 2, 3, 5, 10, 15, 20, 25, 30].map((y) => [String(y), `${y} year${y === 1 ? '' : 's'}`])} />
        </Field>
      </div>
      <label class="check" style={{ marginTop: 12 }}>
        <input type="checkbox" checked={d.includePlans} onChange={(e) => save({ includePlans: e.currentTarget.checked })} />
        Take planned purchases off (in the month you plan to buy, then their monthly costs)
      </label>
      {d.includePlans && !hasDated && <div class="small muted" style={{ marginTop: 4 }}>Give a purchase a “When” month to include it here.</div>}

      <ForecastChart months={fc.months} start={fc.start} showPlans={d.includePlans && hasDated} />

      <div class="tablewrap" style={{ marginTop: 12 }}>
        <table class="t">
          <thead><tr><th>After</th><th class="money hide-sm">Saved in</th><th class="money">Interest</th>{d.includePlans && hasDated && <th class="money">Purchases</th>}<th class="money">Balance</th></tr></thead>
          <tbody>
            {fc.years.map((y) => (
              <tr key={y.year}>
                <td class="nowrap"><b>{y.year} yr</b> <span class="muted small hide-sm">{monthShort(y.month)}</span></td>
                <td class="money hide-sm"><Money v={y.saved} /></td>
                <td class="money"><Money v={y.interest} /></td>
                {d.includePlans && hasDated && <td class="money"><Money v={-y.spent} /></td>}
                <td class="money"><b><Money v={y.balance} tone /></b></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p class="small muted" style={{ marginBottom: 0 }}>This is a rough guide, not advice. Interest is worked out monthly and assumed to stay the same.</p>
    </div>
  );
}

function ForecastChart({ months, start, showPlans }) {
  if (!months.length) return null;
  const w = 640, h = 200, padL = 4, padR = 4, padT = 10, padB = 22;
  const pts = [{ month: shiftMonth(months[0].month, -1), plain: start, withPlans: start }, ...months];
  const vals = pts.flatMap((p) => (showPlans ? [p.plain, p.withPlans] : [p.plain]));
  let min = Math.min(0, ...vals), max = Math.max(...vals);
  if (max - min < 1) max = min + 1;
  const x = (i) => padL + (i / (pts.length - 1)) * (w - padL - padR);
  const y = (v) => padT + (1 - (v - min) / (max - min)) * (h - padT - padB);
  const path = (k) => pts.map((p, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(p[k]).toFixed(1)}`).join(' ');
  const main = showPlans ? 'withPlans' : 'plain';
  const area = `${path(main)} L${x(pts.length - 1).toFixed(1)},${y(Math.max(min, 0)).toFixed(1)} L${x(0).toFixed(1)},${y(Math.max(min, 0)).toFixed(1)} Z`;
  const yearTicks = pts.map((p, i) => [p, i]).filter(([, i]) => i > 0 && i % 12 === 0);
  const step = Math.ceil(yearTicks.length / 6);
  const last = pts[pts.length - 1];
  return (
    <div style={{ marginTop: 14 }}>
      <div class="row wrap small" style={{ gap: 14, marginBottom: 6 }}>
        <span class="row" style={{ gap: 6 }}><i class="legend-line" />{showPlans ? 'After purchases' : 'Savings'} <b><Money v={last[main]} /></b></span>
        {showPlans && <span class="row" style={{ gap: 6 }}><i class="legend-line dashed" />Without purchases <b><Money v={last.plain} /></b></span>}
      </div>
      <svg viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="none" style={{ width: '100%', height: h }} role="img" aria-label="Savings forecast">
        {min < 0 && <line x1={padL} x2={w - padR} y1={y(0)} y2={y(0)} stroke="var(--border)" stroke-width="1" vector-effect="non-scaling-stroke" />}
        <path d={area} fill="var(--chart-fill)" />
        {showPlans && <path d={path('plain')} fill="none" stroke="var(--muted)" stroke-width="2" stroke-dasharray="5 5" vector-effect="non-scaling-stroke" />}
        <path d={path(main)} fill="none" stroke="var(--chart)" stroke-width="2.5" vector-effect="non-scaling-stroke" />
      </svg>
      <div class="fc-axis small muted">
        <span>Now</span>
        {yearTicks.filter((_, i) => (i + 1) % step === 0 || i === yearTicks.length - 1).slice(-6).map(([p]) => <span key={p.month}>{monthShort(p.month)}</span>)}
      </div>
    </div>
  );
}

function Notes({ notes }) {
  const { fin, ws, open, toast } = useApp();
  const [text, setText] = useState('');
  const add = () => {
    const t = text.trim();
    if (!t) return;
    const [first, ...rest] = t.split('\n');
    fin.savePlanNote(ws, rest.length ? { title: first, body: rest.join('\n') } : { title: '', body: first });
    setText('');
    toast('Note saved');
  };
  return (
    <div class="card">
      <div class="card-head"><h3>Notes &amp; ideas</h3></div>
      <textarea rows="3" placeholder="Jot down an idea, a pro or con, or something to discuss…" value={text} onInput={(e) => setText(e.currentTarget.value)} />
      <div class="row" style={{ marginTop: 8, marginBottom: 12 }}><span class="spacer" /><button class="btn sm primary" disabled={!text.trim()} onClick={add}>Add note</button></div>
      <div class="col" style={{ gap: 10 }}>
        {notes.map((n) => (
          <div class="mitem" key={n.id}>
            {n.title && <div class="name" style={{ whiteSpace: 'normal' }}>{n.title}</div>}
            {n.body && <div style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{n.body}</div>}
            <div class="acts">
              <span class="small muted">{new Date(n.createdAt).toLocaleDateString('en-GB', { timeZone: 'Europe/London', day: 'numeric', month: 'short', year: 'numeric' })}</span>
              <span class="spacer" />
              <button class="btn sm ghost" onClick={() => open('planNote', { note: n })}>Edit</button>
              <button class="btn sm ghost danger" aria-label="Delete" onClick={() => open('confirm', { title: 'Delete this note?', label: 'Delete', action: () => fin.deletePlanNote(n.id) })}>✕</button>
            </div>
          </div>
        ))}
        {!notes.length && <Empty>No notes yet.</Empty>}
      </div>
    </div>
  );
}

export function PlanItemDialog({ onClose, item }) {
  const { fin, ws } = useApp();
  const p = item || {};
  const [d, setD] = useState({
    name: p.name || '', cost: p.cost ?? '', extraCost: p.extraCost || '', monthlyCost: p.monthlyCost || '',
    status: p.status || 'idea', targetMonth: p.targetMonth || null, notes: p.notes || '',
  });
  const s = (k, v) => setD((o) => ({ ...o, [k]: v }));
  const now = monthKey();
  const months = Array.from({ length: 61 }, (_, i) => shiftMonth(now, i));
  if (d.targetMonth && !months.includes(d.targetMonth)) months.unshift(d.targetMonth);
  const firstYear = num(d.cost) + num(d.extraCost) + num(d.monthlyCost) * 12;
  return (
    <Modal title={item ? 'Edit purchase' : 'Possible purchase'} sub="Add what it costs to buy, any extra one-off costs, and what it costs to keep each month." onClose={onClose}
      onSubmit={() => fin.savePlanItem(ws, { ...(item ? { id: item.id } : {}), ...d, cost: num(d.cost), extraCost: num(d.extraCost), monthlyCost: num(d.monthlyCost), notes: d.notes.trim() })}>
      <div class="form two">
        <Field label="What is it?" class="full"><input type="text" value={d.name} autoFocus placeholder="e.g. New car, Laptop, Holiday" onInput={(e) => s('name', e.currentTarget.value)} /></Field>
        <Field label="Price"><MoneyInput value={d.cost} onInput={(v) => s('cost', v)} /></Field>
        <Field label="Extra one-off costs"><MoneyInput value={d.extraCost} placeholder="e.g. delivery, setup" onInput={(v) => s('extraCost', v)} /></Field>
        <Field label="Ongoing cost each month"><MoneyInput value={d.monthlyCost} placeholder="e.g. insurance, subscription" onInput={(v) => s('monthlyCost', v)} /></Field>
        <Field label="When"><Select value={d.targetMonth} onChange={(v) => s('targetMonth', v)} options={[[null, 'Not sure yet'], ...months.map((m) => [m, monthShort(m)])]} /></Field>
        <div class="field full"><span>Status</span><Seg value={d.status} onChange={(v) => s('status', v)} options={STATUS} /></div>
        <Field label="Notes (what comes with it, pros and cons)" class="full"><textarea rows="3" value={d.notes} onInput={(e) => s('notes', e.currentTarget.value)} /></Field>
      </div>
      {firstYear > 0 && <div class="notice neutral" style={{ marginTop: 14 }}>First year total: {fmtMoney(firstYear)}{num(d.monthlyCost) > 0 ? `, then ${fmtMoney(num(d.monthlyCost) * 12)} a year` : ''}.</div>}
    </Modal>
  );
}

export function PlanNoteDialog({ onClose, note }) {
  const { fin, ws } = useApp();
  const [title, setTitle] = useState(note?.title || '');
  const [body, setBody] = useState(note?.body || '');
  return (
    <Modal title={note ? 'Edit note' : 'New note'} onClose={onClose} onSubmit={() => fin.savePlanNote(ws, { ...(note ? { id: note.id } : {}), title, body })}>
      <div class="form">
        <Field label="Title (optional)"><input type="text" value={title} autoFocus onInput={(e) => setTitle(e.currentTarget.value)} /></Field>
        <Field label="Note"><textarea rows="6" value={body} onInput={(e) => setBody(e.currentTarget.value)} /></Field>
      </div>
    </Modal>
  );
}
