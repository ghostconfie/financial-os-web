import { useEffect, useState } from 'preact/hooks';

// A short, friendly walkthrough. Opens by itself the first time, and from Menu → How to use Emperio.
export const TOUR_KEY = 'fos.tourDone';

const STEPS = [
  {
    art: <img src="icons/icon-192.png" alt="" />,
    title: 'Welcome to Emperio Finances',
    body: <>
      <p>Emperio helps you give every pound a job, so you always know what your money is for.</p>
      <p>This quick guide takes about a minute.</p>
    </>,
  },
  {
    art: '🏦',
    title: 'Workspaces and accounts',
    body: <>
      <p>At the top, pick a workspace: Personal, Scrumbb or Clean and Serve. Each one has its own accounts, pools and transactions.</p>
      <p>Add your bank accounts under <b>More → Accounts</b> with the balance they have today.</p>
    </>,
  },
  {
    art: '🫙',
    title: 'Pools are pots for your money',
    body: <>
      <p>A pool is a pot for one job, like <b>Bills</b>, <b>Food</b> or <b>Savings</b>. Each category (like Groceries) belongs to a pool.</p>
      <p>When you spend, the money comes out of that category's pool. Give each pool a <b>monthly amount</b> with “Edit”.</p>
    </>,
  },
  {
    art: '🎯',
    title: 'The goal: £0.00 left to assign',
    body: <>
      <p><b>Money at hand</b> is all the money in your accounts. <b>Left to assign</b> is the part that isn't in a pool yet.</p>
      <p>Keep putting money into pools until Left to assign reads <b>£0.00</b>. That's zero-based budgeting: every pound has a job.</p>
    </>,
  },
  {
    art: '🗓️',
    title: 'Your monthly routine',
    body: <ol>
      <li>When money comes in, add it as <b>Income</b> (or import your bank statement).</li>
      <li>Press <b>Fill pools</b>. Each pool gets its monthly amount.</li>
      <li>Anything left? Tap <b>+ Assign money</b> on a pool until Left to assign is £0.00.</li>
      <li>Log spending with the <b>+</b> button. It comes out of its pool.</li>
    </ol>,
  },
  {
    art: '🛟',
    title: 'If a pool goes red',
    body: <>
      <p>Red means you've spent more than the pool had. Tap <b>Cover</b> to move money in from another pool.</p>
      <p>Money you don't spend stays in its pool and carries over to next month.</p>
    </>,
  },
  {
    art: '💾',
    title: 'Keep a backup',
    body: <>
      <p><b>Menu → Back up everything to Excel</b> saves a full copy of your data.</p>
      <p>You can open this guide again any time from <b>Menu → How to use Emperio</b>.</p>
    </>,
  },
];

export function Tour({ onClose }) {
  const [i, setI] = useState(0);
  const last = i === STEPS.length - 1;
  const done = () => { try { localStorage.setItem(TOUR_KEY, '1'); } catch { /* private mode */ } onClose(); };
  useEffect(() => {
    const k = (e) => {
      if (e.key === 'Escape') done();
      if (e.key === 'ArrowRight') setI((n) => Math.min(n + 1, STEPS.length - 1));
      if (e.key === 'ArrowLeft') setI((n) => Math.max(n - 1, 0));
    };
    window.addEventListener('keydown', k);
    return () => window.removeEventListener('keydown', k);
  }, []);
  const s = STEPS[i];
  return (
    <div class="overlay" onMouseDown={(e) => { if (e.target === e.currentTarget) done(); }}>
      <div class="modal tour" role="dialog" aria-label="How to use Emperio Finances">
        <div class="mb" style={{ paddingTop: 20 }}>
          <div class="art">{s.art}</div>
          <div class="eyebrow" style={{ marginBottom: 4 }}>Step {i + 1} of {STEPS.length}</div>
          <h2>{s.title}</h2>
          {s.body}
          <div class="dots">{STEPS.map((_, n) => <i key={n} class={n === i ? 'on' : ''} />)}</div>
        </div>
        <div class="mf">
          {!last && <button type="button" class="btn ghost" style={{ marginRight: 'auto' }} onClick={done}>Skip</button>}
          {i > 0 && <button type="button" class="btn" onClick={() => setI(i - 1)}>Back</button>}
          <button type="button" class="btn primary" onClick={() => (last ? done() : setI(i + 1))}>{last ? 'Start budgeting' : 'Next'}</button>
        </div>
      </div>
    </div>
  );
}
