// Optional sample data (Menu → Load demo data) so the dashboards have something to show.
import { addDays, monthKey, shiftMonth, todayStr } from './util.js';

function rng(seed) {
  let s = seed >>> 0;
  const next = () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; };
  return {
    random: next,
    uniform: (a, b) => a + (b - a) * next(),
    choice: (arr) => arr[Math.floor(next() * arr.length)],
  };
}
const r2 = (v) => Math.round(v * 100) / 100;

export function loadDemo(fin, seed = 7) {
  const rnd = rng(seed);
  const db = fin.db;
  const wss = Object.fromEntries(fin.workspaces().map((w) => [w.name, w]));
  const personal = wss.Personal || fin.createWorkspace('Personal');
  const ws = personal.id;

  for (const a of fin.accounts(ws)) if (a.name === 'Current Account') fin.saveAccount(ws, 'Current Account', 2150, a.id, false);
  if (!fin.accountNames(ws).includes('Savings Pot')) fin.saveAccount(ws, 'Savings Pot', 4800, null, false);
  if (!fin.accountNames(ws).includes('Credit Card')) fin.saveAccount(ws, 'Credit Card', 0, null, false);

  const pools = Object.fromEntries(fin.pools(ws).map((p) => [p.name, p]));
  const everyday = pools['Everyday Spending'] || fin.defaultPool(ws);
  const home = pools['Bills & Home'] || fin.savePool(ws, { name: 'Bills & Home', color: '#6366f1', icon: '🏠', isWorkspaceConnected: true, fundingMode: 'fixed', fundingValue: 1450, description: 'Rent, utilities and insurance.' }, false);
  const fun = pools['Fun Money'] || fin.savePool(ws, { name: 'Fun Money', color: '#ec4899', icon: '🎉', isWorkspaceConnected: false, fundingMode: 'unconnected', fundingValue: 250, description: 'Standalone treat budget.' }, false);
  const goals = pools['Savings Goals'] || fin.savePool(ws, { name: 'Savings Goals', color: '#0ea5e9', icon: '🎯', isWorkspaceConnected: true, fundingMode: 'fixed', fundingValue: 400, description: 'Holiday & emergency fund.' }, false);
  db.update('budget_pools', everyday.id, { fundingValue: 650 });

  const spec = [
    ['Groceries', 'Expense', everyday, 380, '#10b981'], ['Transport', 'Expense', everyday, 120, '#f97316'],
    ['Eating Out', 'Expense', everyday, 90, '#ef4444'], ['Rent', 'Bills', home, 1100, '#6366f1'],
    ['Utilities', 'Bills', home, 180, '#f59e0b'], ['Insurance', 'Bills', home, 65, '#0ea5e9'],
    ['Phone & Internet', 'Bills', home, 55, '#8b5cf6'], ['Subscriptions', 'Expense', fun, 40, '#a855f7'],
    ['Hobbies', 'Expense', fun, 120, '#ec4899'], ['Holiday Fund', 'Savings', goals, 250, '#06b6d4'],
    ['Index Fund', 'Investment', goals, 150, '#84cc16'], ['Credit Card Repayment', 'Debt Payment', everyday, 0, '#64748b'],
  ];
  for (const [name, typ, pool, alloc, color] of spec) {
    const c = fin.ensureCategory(ws, name, typ);
    db.update('categories', c.id, { defaultType: typ, color, allocated: alloc });
    fin.setCategoryPool(c.id, pool.id, false);
  }

  const tx = (o) => fin.saveTransaction({ workspaceId: ws, bankAccount: 'Current Account', ...o }, false);
  const t = todayStr();
  for (let d = addDays(t, -95); d <= t; d = addDays(d, 1)) {
    const day = +d.slice(8);
    const dow = (new Date(d + 'T00:00:00Z').getUTCDay() + 6) % 7;
    if (day === 25) tx({ date: d, type: 'Income', category: 'Salary', amount: 3150, description: 'Monthly salary' });
    if (day === 1) {
      for (const [name, amt] of [['Rent', 1100], ['Insurance', 64.2], ['Phone & Internet', 52.99]]) tx({ date: d, type: 'Bills', category: name, amount: amt, description: name });
      tx({ date: d, type: 'Savings', category: 'Holiday Fund', amount: 250, description: 'Holiday pot' });
    }
    if (day === 8) tx({ date: d, type: 'Bills', category: 'Utilities', amount: r2(rnd.uniform(140, 190)), description: 'Energy & water' });
    if (dow === 2 || dow === 5) {
      tx({ date: d, type: 'Expense', category: 'Groceries', bankAccount: rnd.choice(['Current Account', 'Credit Card']), amount: r2(rnd.uniform(28, 72)), description: rnd.choice(['Tesco', "Sainsbury's", 'Aldi', 'Co-op']) });
    }
    if (rnd.random() < 0.25) tx({ date: d, type: 'Expense', category: 'Transport', amount: r2(rnd.uniform(4, 35)), description: rnd.choice(['TfL', 'Trainline', 'Petrol', 'Uber']) });
    if (rnd.random() < 0.15) tx({ date: d, type: 'Expense', category: 'Eating Out', bankAccount: 'Credit Card', amount: r2(rnd.uniform(12, 48)), description: rnd.choice(['Dishoom', 'Pret', "Nando's", 'Local pub']) });
    if (day === 14) {
      tx({ date: d, type: 'Expense', category: 'Subscriptions', bankAccount: 'Credit Card', amount: 15.99, description: 'Streaming' });
      tx({ date: d, type: 'Investment', category: 'Index Fund', amount: 150, description: 'S&S ISA' });
    }
    if (day === 20) tx({ date: d, type: 'Debt Payment', category: 'Credit Card Repayment', amount: 180, description: 'Card repayment' });
    if (rnd.random() < 0.06) tx({ date: d, type: 'Expense', category: 'Hobbies', bankAccount: 'Credit Card', amount: r2(rnd.uniform(20, 85)), description: rnd.choice(['Climbing', 'Books', 'Gig tickets']) });
  }

  const biz = fin.businessWorkspaces();
  [['Domain renewal', 24.99, 'Software'], ['Cleaning supplies', 86.4, 'Supplies'], ['Client lunch', 42.5, 'Entertainment'], ['Laptop stand', 39, 'Equipment']]
    .forEach(([desc, amt, bcat], i) => {
      if (!biz.length) return;
      const bw = biz[i % biz.length];
      tx({ date: addDays(t, -(5 + i * 9)), type: 'Expense', category: 'Business Costs', bankAccount: 'Credit Card', amount: amt, description: desc, isBusinessPayment: true, businessWorkspaceId: bw.id, businessCategory: bcat, dlaNotes: 'Reclaim via DLA' });
    });
  if (biz.length) {
    tx({ date: addDays(t, -3), type: 'Income', category: 'DLA Repayment', amount: 50, description: 'Part repayment from company', isBusinessPayment: true, businessWorkspaceId: biz[0].id, businessCategory: "Director's Loan" });
  }
  for (let i = 0; i < 3; i++) {
    const d = `${shiftMonth(monthKey(t), -i)}-26`;
    if (d <= t) fin.saveTransfer({ workspaceId: ws, date: d, fromAccount: 'Current Account', toAccount: 'Savings Pot', amount: 200, notes: 'Monthly sweep' }, false);
  }
  if (!fin.bills(ws).length) {
    for (const [name, cat, day, amt, rt] of [['Rent', 'Rent', 1, 1100, '08:00'], ['Energy', 'Utilities', 8, 165, '09:00'], ['Home insurance', 'Insurance', 1, 64.2, '09:00'], ['Broadband', 'Phone & Internet', 1, 52.99, '09:00'], ['Council tax', 'Utilities', 28, 142, '09:30'], ['Streaming', 'Subscriptions', 14, 15.99, '18:00']]) {
      const b = fin.saveBill(ws, { billName: name, category: cat, dueDay: day, amount: amt, bankAccount: 'Current Account', reminderTime: rt, reminderEnabled: true, notes: '', paidMonths: day < +t.slice(8) ? [monthKey(t)] : [] }, false);
      void b;
    }
  }
  if (!fin.goals(ws).length) {
    for (const [cat, amt, typ] of [['Groceries', 380, 'Expense'], ['Holiday Fund', 1500, 'Savings'], ['Eating Out', 90, 'Expense']]) fin.saveGoal(ws, { category: cat, amount: amt, type: typ }, false);
  }
  if (biz.length) {
    const bws = biz[0].id;
    const acc = fin.accounts(bws)[0];
    fin.saveAccount(bws, 'Business Current', 3200, acc ? acc.id : null, false);
    for (let i = 0; i < 10; i++) {
      const dd = addDays(t, -i * 9);
      fin.saveTransaction({ workspaceId: bws, date: dd, type: 'Income', category: 'Client Revenue', bankAccount: 'Business Current', amount: r2(rnd.uniform(400, 1800)), description: `Invoice #${1040 + i}` }, false);
      fin.saveTransaction({ workspaceId: bws, date: dd, type: 'Expense', category: 'Software', bankAccount: 'Business Current', amount: r2(rnd.uniform(15, 120)), description: 'SaaS tools' }, false);
    }
  }
  db.commit();
  fin.fillPools(ws); // zero-based: give each pool this month's money
  return ws;
}
