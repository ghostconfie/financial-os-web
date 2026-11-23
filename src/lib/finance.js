// Business logic: balances, budget pools, P&L, bills, DLA and analysis.
// A line-by-line port of the desktop app's services.py, so the numbers match.

import {
  OUTFLOW_TYPES, TX_TYPES, addDays, daysInMonth, dayDiff, fmtMoney, monthBounds, monthKey, nowLondon,
  ordinal, round2, signedAmount, todayStr, weekStart,
} from './util.js';

export const PRESET_WORKSPACES = [['Personal', 'personal'], ['Scrumbb', 'business'], ['Clean and Serve', 'business']];
export const PROTECTED_CATEGORIES = [
  ['Groceries', 'Expense', '#10b981'], ['Utilities', 'Bills', '#f59e0b'],
  ['Rent', 'Bills', '#6366f1'], ['Insurance', 'Bills', '#0ea5e9'],
];
export const PALETTE = ['#10b981', '#6366f1', '#f59e0b', '#ec4899', '#0ea5e9', '#8b5cf6', '#ef4444', '#14b8a6',
  '#f97316', '#84cc16', '#06b6d4', '#a855f7'];
export const POOL_ICONS = ['🛒', '🏠', '💡', '🎉', '🚗', '💼', '🎯', '📈', '🏖️', '🍽️', '💳', '🧾'];

export class FinanceError extends Error {}

const lc = (s) => (s || '').toLowerCase();
const byName = (a, b) => lc(a.name).localeCompare(lc(b.name));
const byOrder = (a, b) => (a.order - b.order) || lc(a.name).localeCompare(lc(b.name));
const byDateDesc = (a, b) => (b.date || '').localeCompare(a.date || '') || (b.createdAt || '').localeCompare(a.createdAt || '');

export class Finance {
  constructor(store) {
    this.db = store;
  }

  /** Create the preset workspaces on a brand-new, empty data set. */
  ensureSeeded() {
    if (this.db.all('workspaces').length) return false;
    PRESET_WORKSPACES.forEach(([name, kind], i) => this.createWorkspace(name, kind, true, i, false));
    this.db.commit();
    return true;
  }

  // ============================================================ workspaces
  workspaces() { return this.db.all('workspaces').sort(byOrder); }
  workspace(id) { return this.db.get('workspaces', id); }
  businessWorkspaces() { return this.workspaces().filter((w) => w.kind === 'business'); }

  createWorkspace(name, kind = 'personal', preset = false, order = null, commit = true) {
    name = (name || '').trim();
    if (!name) throw new FinanceError('Workspace name is required.');
    if (this.db.all('workspaces').some((w) => lc(w.name) === lc(name))) {
      throw new FinanceError(`A workspace called "${name}" already exists.`);
    }
    if (order === null) order = this.db.all('workspaces').length;
    const ws = this.db.insert('workspaces', { name, kind, isPreset: preset, order });
    this._seedWorkspace(ws.id);
    if (commit) this.db.commit();
    return ws;
  }

  _seedWorkspace(wsId) {
    const pool = this.db.insert('budget_pools', {
      workspaceId: wsId, name: 'Everyday Spending', color: '#10b981', icon: '🛒', isWorkspaceConnected: true,
      fundingMode: 'fixed', fundingValue: 0, isDefault: true, order: 0, description: 'Default pool for day-to-day costs.',
    });
    for (const [name, type, color] of PROTECTED_CATEGORIES) {
      this.db.insert('categories', {
        workspaceId: wsId, name, defaultType: type, bankAccount: 'ALL', color, poolId: pool.id, allocated: 0, isProtected: true,
      });
    }
    this.db.insert('categories', {
      workspaceId: wsId, name: 'Salary', defaultType: 'Income', bankAccount: 'ALL', color: '#22c55e', poolId: null,
      allocated: 0, isProtected: false,
    });
    this.db.insert('bank_accounts', { workspaceId: wsId, name: 'Current Account', initialBalance: 0 });
  }

  renameWorkspace(wsId, name, kind) {
    name = (name || '').trim();
    if (!name) throw new FinanceError('Workspace name is required.');
    if (this.workspaces().some((w) => lc(w.name) === lc(name) && w.id !== wsId)) {
      throw new FinanceError(`A workspace called "${name}" already exists.`);
    }
    this.db.update('workspaces', wsId, kind ? { name, kind } : { name });
    for (const t of this.db.all('transactions', { businessWorkspaceId: wsId })) {
      this.db.update('transactions', t.id, { businessWorkspaceName: name });
    }
    this.db.commit();
  }

  deleteWorkspace(wsId) {
    if (this.workspaces().length <= 1) throw new FinanceError('You need at least one workspace.');
    for (const table of ['transactions', 'transfers', 'categories', 'budget_pools', 'pool_transfers', 'bills',
      'budget_goals', 'bank_accounts']) {
      for (const r of this.db.all(table, { workspaceId: wsId })) this.db.delete(table, r.id);
    }
    this.db.delete('workspaces', wsId);
    this.db.commit();
  }

  // ============================================================== accounts
  accounts(ws) { return this.db.all('bank_accounts', { workspaceId: ws }).sort(byName); }
  accountNames(ws) { return this.accounts(ws).map((a) => a.name); }

  _renameField(table, ws, field, from, to) {
    for (const r of this.db.raw(table)) {
      if (r.workspaceId === ws && r[field] === from) this.db.update(table, r.id, { [field]: to });
    }
  }

  saveAccount(ws, name, initial, id = null, commit = true) {
    name = (name || '').trim();
    if (!name) throw new FinanceError('Account name is required.');
    if (this.accounts(ws).some((a) => lc(a.name) === lc(name) && a.id !== id)) {
      throw new FinanceError(`An account called "${name}" already exists.`);
    }
    let out;
    if (id) {
      const old = this.db.get('bank_accounts', id);
      if (old && old.name !== name) {
        this._renameField('transactions', ws, 'bankAccount', old.name, name);
        this._renameField('transfers', ws, 'fromAccount', old.name, name);
        this._renameField('transfers', ws, 'toAccount', old.name, name);
        this._renameField('categories', ws, 'bankAccount', old.name, name);
        this._renameField('bills', ws, 'bankAccount', old.name, name);
      }
      out = this.db.update('bank_accounts', id, { name, initialBalance: initial });
    } else {
      out = this.db.insert('bank_accounts', { workspaceId: ws, name, initialBalance: initial });
    }
    if (commit) this.db.commit();
    return out;
  }

  accountUsage(ws, name) {
    let n = 0;
    for (const t of this.db.raw('transactions')) if (t.workspaceId === ws && t.bankAccount === name) n++;
    for (const t of this.db.raw('transfers')) if (t.workspaceId === ws && (t.fromAccount === name || t.toAccount === name)) n++;
    return n;
  }

  deleteAccount(ws, id, reassignTo = null) {
    const acc = this.db.get('bank_accounts', id);
    if (!acc) return;
    const used = this.accountUsage(ws, acc.name);
    if (used && !reassignTo) {
      throw new FinanceError(`"${acc.name}" has ${used} linked records. Choose an account to move them to.`);
    }
    if (reassignTo) {
      this._renameField('transactions', ws, 'bankAccount', acc.name, reassignTo);
      this._renameField('transfers', ws, 'fromAccount', acc.name, reassignTo);
      this._renameField('transfers', ws, 'toAccount', acc.name, reassignTo);
      this._renameField('bills', ws, 'bankAccount', acc.name, reassignTo);
      for (const t of this.db.all('transfers', { workspaceId: ws })) {
        if (t.fromAccount === t.toAccount) this.db.delete('transfers', t.id);
      }
    }
    this.db.delete('bank_accounts', id);
    this.db.commit();
  }

  accountSummaries(ws) {
    const agg = {};
    const get = (n) => (agg[n] ||= { income: 0, expenses: 0, tIn: 0, tOut: 0 });
    for (const t of this.db.raw('transactions')) {
      if (t.workspaceId !== ws) continue;
      const a = get(t.bankAccount);
      if (t.type === 'Income') a.income += t.amount; else a.expenses -= t.amount;
    }
    for (const t of this.db.raw('transfers')) {
      if (t.workspaceId !== ws) continue;
      get(t.toAccount).tIn += t.amount;
      get(t.fromAccount).tOut += t.amount;
    }
    return this.accounts(ws).map((a) => {
      const x = agg[a.name] || { income: 0, expenses: 0, tIn: 0, tOut: 0 };
      return {
        ...a, income: round2(x.income), expenses: round2(x.expenses), transfersIn: round2(x.tIn),
        transfersOut: round2(x.tOut), netTransfers: round2(x.tIn - x.tOut),
        balance: round2(a.initialBalance + x.income - x.expenses + x.tIn - x.tOut),
      };
    });
  }

  moneyAtHand(ws) { return round2(this.accountSummaries(ws).reduce((s, a) => s + a.balance, 0)); }

  // ========================================================== transactions
  transactions(ws, f = {}) {
    const q = f.search ? lc(f.search) : '';
    const out = [];
    for (const t of this.db.raw('transactions')) {
      if (t.workspaceId !== ws) continue;
      if (f.account && t.bankAccount !== f.account) continue;
      if (f.category && t.category !== f.category) continue;
      if (f.type && t.type !== f.type) continue;
      if (f.month && t.date.slice(0, 7) !== f.month) continue;
      if (f.start && t.date < f.start) continue;
      if (f.end && t.date > f.end) continue;
      if (f.poolId && t.poolId !== f.poolId) continue;
      if (q && !(lc(t.description).includes(q) || lc(t.category).includes(q) || lc(t.bankAccount).includes(q))) continue;
      out.push({ ...t });
    }
    return out.sort(byDateDesc);
  }

  saveTransaction(data, commit = true) {
    const d = { ...data };
    if (!TX_TYPES.includes(d.type)) throw new FinanceError('Choose a transaction type.');
    if (!d.date) throw new FinanceError('Date is required.');
    if (!d.category) throw new FinanceError('Category is required.');
    const ws = d.workspaceId;
    d.amount = signedAmount(d.type, d.amount);
    const cat = this.ensureCategory(ws, d.category, d.type);
    if (!d.poolId) d.poolId = cat.poolId;
    const pool = d.poolId ? this.db.get('budget_pools', d.poolId) : null;
    d.poolName = pool ? pool.name : null;
    if (d.isBusinessPayment && d.businessWorkspaceId) {
      const bw = this.workspace(d.businessWorkspaceId);
      d.businessWorkspaceName = bw ? bw.name : d.businessWorkspaceName;
    } else {
      d.isBusinessPayment = !!d.isBusinessPayment;
    }
    const out = d.id && this.db.get('transactions', d.id) ? this.db.update('transactions', d.id, d) : this.db.insert('transactions', d);
    if (commit) this.db.commit();
    return out;
  }

  deleteTransactions(ids) {
    for (const i of ids) this.db.delete('transactions', i);
    this.db.commit();
  }

  remapCategory(ws, ids, newCategory) {
    if (!newCategory) throw new FinanceError('Pick a category to remap to.');
    const cat = this.ensureCategory(ws, newCategory, 'Expense');
    const pool = cat.poolId ? this.db.get('budget_pools', cat.poolId) : null;
    for (const i of ids) {
      this.db.update('transactions', i, { category: cat.name, poolId: cat.poolId, poolName: pool ? pool.name : null });
    }
    this.db.commit();
  }

  setTransactionsPool(ids, poolId) {
    const pool = poolId ? this.db.get('budget_pools', poolId) : null;
    for (const i of ids) this.db.update('transactions', i, { poolId: poolId || null, poolName: pool ? pool.name : null });
    this.db.commit();
  }

  // ============================================================= transfers
  transfers(ws, start = null, end = null) {
    return this.db.all('transfers', { workspaceId: ws })
      .filter((r) => (!start || r.date >= start) && (!end || r.date <= end))
      .sort((a, b) => b.date.localeCompare(a.date));
  }

  saveTransfer(data, commit = true) {
    const d = { ...data };
    if (!d.fromAccount || !d.toAccount) throw new FinanceError('Choose both accounts.');
    if (d.fromAccount === d.toAccount) throw new FinanceError('From and To accounts must be different.');
    d.amount = Math.abs(Number(d.amount) || 0);
    if (d.amount <= 0) throw new FinanceError('Transfer amount must be more than £0.00.');
    if (!d.date) throw new FinanceError('Date is required.');
    const out = d.id && this.db.get('transfers', d.id) ? this.db.update('transfers', d.id, d) : this.db.insert('transfers', d);
    if (commit) this.db.commit();
    return out;
  }

  deleteTransfer(id) { this.db.delete('transfers', id); this.db.commit(); }

  // ============================================================ categories
  categories(ws) { return this.db.all('categories', { workspaceId: ws }).sort(byName); }

  categoryByName(ws, name) {
    const n = lc((name || '').trim());
    for (const c of this.db.raw('categories')) if (c.workspaceId === ws && lc(c.name) === n) return { ...c };
    return null;
  }

  defaultPool(ws) {
    const pools = this.pools(ws);
    return pools.find((p) => p.isDefault) || pools[0] || null;
  }

  ensureCategory(ws, name, type = 'Expense') {
    const c = this.categoryByName(ws, name);
    if (c) return c;
    const pool = type === 'Income' ? null : this.defaultPool(ws);
    const n = this.categories(ws).length;
    return this.db.insert('categories', {
      workspaceId: ws, name: name.trim(), defaultType: type, bankAccount: 'ALL', color: PALETTE[n % PALETTE.length],
      poolId: pool ? pool.id : null, allocated: 0, isProtected: false,
    });
  }

  saveCategory(ws, data) {
    const d = { ...data };
    const name = (d.name || '').trim();
    if (!name) throw new FinanceError('Category name is required.');
    const existing = this.categoryByName(ws, name);
    if (existing && existing.id !== d.id) throw new FinanceError(`A category called "${name}" already exists.`);
    d.workspaceId = ws;
    d.name = name;
    let out;
    if (d.id) {
      const old = this.db.get('categories', d.id);
      if (old && old.isProtected && old.name !== name) {
        throw new FinanceError(`"${old.name}" is a protected core category and cannot be renamed.`);
      }
      if (old && old.name !== name) {
        this._renameField('transactions', ws, 'category', old.name, name);
        this._renameField('bills', ws, 'category', old.name, name);
      }
      if (old && 'poolId' in d && (old.poolId || null) !== (d.poolId || null)) {
        this.db.update('categories', d.id, { name });
        this.setCategoryPool(d.id, d.poolId, false);
      }
      out = this.db.update('categories', d.id, d);
    } else {
      d.color ||= PALETTE[this.categories(ws).length % PALETTE.length];
      d.allocated ??= 0;
      d.isProtected ??= false;
      d.bankAccount ||= 'ALL';
      out = this.db.insert('categories', d);
    }
    this.db.commit();
    return out;
  }

  setCategoryAllocated(catId, amount) {
    this.db.update('categories', catId, { allocated: Math.max(0, Number(amount) || 0) });
    this.db.commit();
  }

  /** Move a category to a pool and re-attribute its transactions. */
  setCategoryPool(catId, poolId, commit = true) {
    const cat = this.db.get('categories', catId);
    const pool = poolId ? this.db.get('budget_pools', poolId) : null;
    this.db.update('categories', catId, { poolId: poolId || null });
    for (const t of this.db.raw('transactions')) {
      if (t.workspaceId === cat.workspaceId && t.category === cat.name) {
        this.db.update('transactions', t.id, { poolId: poolId || null, poolName: pool ? pool.name : null });
      }
    }
    if (commit) this.db.commit();
  }

  /** Delete non-protected categories; returns names that were blocked. */
  deleteCategories(ids) {
    const blocked = [];
    for (const i of ids) {
      const c = this.db.get('categories', i);
      if (!c) continue;
      if (c.isProtected) { blocked.push(c.name); continue; }
      this.db.delete('categories', i);
    }
    this.db.commit();
    return blocked;
  }

  // ================================================================= pools
  pools(ws) { return this.db.all('budget_pools', { workspaceId: ws }).sort(byOrder); }

  savePool(ws, data, commit = true) {
    const d = { ...data };
    if (!(d.name || '').trim()) throw new FinanceError('Pool name is required.');
    d.name = d.name.trim();
    d.workspaceId = ws;
    if (!d.isWorkspaceConnected) d.fundingMode = 'unconnected';
    else if (d.fundingMode === 'unconnected' || !d.fundingMode) d.fundingMode = 'fixed';
    if (d.isDefault) {
      for (const p of this.pools(ws)) {
        if (p.id !== d.id && p.isDefault) this.db.update('budget_pools', p.id, { isDefault: false });
      }
    }
    let out;
    if (d.id) {
      out = this.db.update('budget_pools', d.id, d);
      for (const t of this.db.raw('transactions')) {
        if (t.poolId === out.id && t.poolName !== out.name) this.db.update('transactions', t.id, { poolName: out.name });
      }
    } else {
      d.order ??= this.pools(ws).length;
      d.fundingValue ??= 0;
      if (!this.pools(ws).length) d.isDefault = true;
      out = this.db.insert('budget_pools', d);
    }
    if (commit) this.db.commit();
    return out;
  }

  _configuredBudget(pool, mah) {
    if (pool.fundingMode === 'percent') return round2(mah * pool.fundingValue / 100);
    return pool.fundingValue;
  }

  _spendIndex(ws, month) {
    const byCat = new Map(), byPool = new Map();
    for (const t of this.db.raw('transactions')) {
      if (t.workspaceId !== ws || t.type === 'Income') continue;
      if (month && t.date.slice(0, 7) !== month) continue;
      const k = `${t.poolId}|${lc(t.category)}`;
      byCat.set(k, (byCat.get(k) || 0) - t.amount);
      byPool.set(t.poolId, (byPool.get(t.poolId) || 0) - t.amount);
    }
    return [byCat, byPool];
  }

  poolMetrics(ws, month) {
    const mah = this.moneyAtHand(ws);
    const cats = this.categories(ws);
    const [byCat, byPool] = this._spendIndex(ws, month);
    return this.pools(ws).map((p) => {
      const lines = cats.filter((c) => c.poolId === p.id).map((c) => {
        const spent = round2(byCat.get(`${p.id}|${lc(c.name)}`) || 0);
        const pct = c.allocated ? spent / c.allocated * 100 : (spent ? 100 : 0);
        return { ...c, spent, remaining: round2(c.allocated - spent), pctUsed: pct };
      });
      const budgeted = round2(lines.reduce((s, l) => s + l.allocated, 0));
      const configured = this._configuredBudget(p, mah);
      const allocated = round2(Math.max(configured, budgeted));
      const spent = round2(byPool.get(p.id) || 0);
      return {
        ...p, configuredBudget: configured, allocatedBudget: allocated, spent, budgetedLines: budgeted,
        leftToSpend: round2(allocated - spent), unassigned: round2(allocated - budgeted),
        pctSpent: allocated ? spent / allocated * 100 : (spent ? 100 : 0), lines,
      };
    });
  }

  header(ws, month, metrics = null) {
    metrics ||= this.poolMetrics(ws, month);
    const mah = this.moneyAtHand(ws);
    const assigned = round2(metrics.filter((m) => m.isWorkspaceConnected).reduce((s, m) => s + m.allocatedBudget, 0));
    return {
      moneyAtHand: mah, assigned, unpooled: round2(Math.max(0, mah - assigned)),
      standalone: round2(metrics.filter((m) => !m.isWorkspaceConnected).reduce((s, m) => s + m.allocatedBudget, 0)),
    };
  }

  _poolMetric(poolId, month = null) {
    const pool = this.db.get('budget_pools', poolId);
    return this.poolMetrics(pool.workspaceId, month).find((m) => m.id === poolId);
  }

  /** Push cash at hand into a pool by raising its explicit budget. */
  pushFunds(poolId, amount) {
    if (!(amount > 0)) throw new FinanceError('Amount must be more than £0.00.');
    const m = this._poolMetric(poolId);
    this.setPoolBudget(poolId, m.allocatedBudget + amount, 'Pushed from cash at hand');
  }

  setPoolBudget(poolId, total, note = 'Set exact total budget') {
    const pool = this.db.get('budget_pools', poolId);
    const m = this._poolMetric(poolId);
    total = Math.max(0, Number(total) || 0);
    const fields = { fundingValue: total };
    if (pool.fundingMode === 'percent') fields.fundingMode = 'fixed';
    this.db.update('budget_pools', poolId, fields);
    const delta = round2(total - m.allocatedBudget);
    if (delta) {
      const cash = pool.isWorkspaceConnected ? 'Cash at Hand' : 'External / Standalone';
      this.db.insert('pool_transfers', {
        workspaceId: pool.workspaceId, fromPoolId: delta > 0 ? null : poolId, toPoolId: delta > 0 ? poolId : null,
        fromPoolName: delta > 0 ? cash : pool.name, toPoolName: delta > 0 ? pool.name : cash,
        amount: Math.abs(delta), note, date: todayStr(),
      });
    }
    this.db.commit();
  }

  poolTransfer(ws, fromId, toId, amount, note = '') {
    if (fromId === toId) throw new FinanceError('Choose two different pools.');
    amount = round2(amount);
    if (amount <= 0) throw new FinanceError('Amount must be more than £0.00.');
    const src = this._poolMetric(fromId), dst = this._poolMetric(toId);
    if (amount > src.allocatedBudget + 0.001) {
      throw new FinanceError(`${src.name} only has ${fmtMoney(src.allocatedBudget)} allocated.`);
    }
    const newSrc = src.allocatedBudget - amount;
    if (newSrc < src.budgetedLines - 0.001) {
      throw new FinanceError(`${src.name} has ${fmtMoney(src.budgetedLines)} budgeted to categories. `
        + 'Lower those category lines first, or transfer less.');
    }
    this.db.update('budget_pools', fromId, { fundingValue: newSrc, fundingMode: src.isWorkspaceConnected ? 'fixed' : 'unconnected' });
    this.db.update('budget_pools', toId, { fundingValue: dst.allocatedBudget + amount, fundingMode: dst.isWorkspaceConnected ? 'fixed' : 'unconnected' });
    this.db.insert('pool_transfers', {
      workspaceId: ws, fromPoolId: fromId, toPoolId: toId, fromPoolName: src.name, toPoolName: dst.name,
      amount, note, date: todayStr(),
    });
    this.db.commit();
  }

  categoryTransfer(fromCat, toCat, amount, note = '', commit = true) {
    const a = this.db.get('categories', fromCat), b = this.db.get('categories', toCat);
    amount = round2(amount);
    if (!a || !b) throw new FinanceError('Choose both categories.');
    if (a.id === b.id) throw new FinanceError('Choose two different categories.');
    if (amount <= 0 || amount > a.allocated + 0.001) throw new FinanceError(`${a.name} only has ${fmtMoney(a.allocated)} allocated.`);
    if (a.poolId !== b.poolId && a.poolId && b.poolId) {
      const pa = this._poolMetric(a.poolId), pb = this._poolMetric(b.poolId);
      this.db.update('budget_pools', pa.id, { fundingValue: Math.max(0, pa.allocatedBudget - amount) });
      this.db.update('budget_pools', pb.id, { fundingValue: pb.allocatedBudget + amount });
    }
    this.db.update('categories', a.id, { allocated: a.allocated - amount });
    this.db.update('categories', b.id, { allocated: b.allocated + amount });
    const pa = a.poolId ? this.db.get('budget_pools', a.poolId) : null;
    const pb = b.poolId ? this.db.get('budget_pools', b.poolId) : null;
    this.db.insert('pool_transfers', {
      workspaceId: a.workspaceId, fromPoolId: a.poolId, toPoolId: b.poolId,
      fromPoolName: `${pa ? pa.name : '—'} · ${a.name}`, toPoolName: `${pb ? pb.name : '—'} · ${b.name}`,
      amount, note: note || 'Category reallocation', date: todayStr(),
    });
    if (commit) this.db.commit();
  }

  /** Cover a category's deficit from a surplus category or another pool. */
  coverOverspend(catId, sourceKind, sourceId, month = null) {
    const cat = this.db.get('categories', catId);
    const m = this._poolMetric(cat.poolId, month);
    const line = m.lines.find((l) => l.id === catId);
    const deficit = round2(-line.remaining);
    if (deficit <= 0) throw new FinanceError(`${cat.name} is not overspent.`);
    let amt;
    if (sourceKind === 'category') {
      const src = m.lines.find((l) => l.id === sourceId);
      amt = Math.min(deficit, src.remaining);
      this.categoryTransfer(sourceId, catId, amt, `Cover overspend on ${cat.name}`);
    } else {
      const src = this._poolMetric(sourceId, month);
      const spare = src.allocatedBudget - src.budgetedLines;
      amt = Math.min(deficit, Math.max(spare, 0));
      if (amt <= 0) throw new FinanceError(`${src.name} has no unassigned budget to give.`);
      this.poolTransfer(cat.workspaceId, sourceId, cat.poolId, amt, `Cover overspend on ${cat.name}`);
      this.db.update('categories', catId, { allocated: cat.allocated + amt });
      this.db.commit();
    }
    return amt;
  }

  deletePool(poolId, targetPoolId = null) {
    const pool = this.db.get('budget_pools', poolId);
    const ws = pool.workspaceId;
    if (this.pools(ws).length <= 1) throw new FinanceError('A workspace needs at least one pool.');
    const m = this._poolMetric(poolId);
    const cats = this.categories(ws).filter((c) => c.poolId === poolId);
    const nonEmpty = m.allocatedBudget > 0 || cats.length || m.spent > 0;
    if (nonEmpty && !targetPoolId) {
      throw new FinanceError("This pool isn't empty. Choose a pool to receive its balance and categories.");
    }
    if (targetPoolId) {
      const tgt = this._poolMetric(targetPoolId);
      for (const c of cats) this.setCategoryPool(c.id, targetPoolId, false);
      const target = this.db.get('budget_pools', targetPoolId);
      for (const t of this.db.raw('transactions')) {
        if (t.poolId === poolId) this.db.update('transactions', t.id, { poolId: targetPoolId, poolName: target.name });
      }
      if (m.allocatedBudget > 0) {
        this.db.update('budget_pools', targetPoolId, { fundingValue: tgt.allocatedBudget + m.allocatedBudget });
        this.db.insert('pool_transfers', {
          workspaceId: ws, fromPoolId: poolId, toPoolId: targetPoolId, fromPoolName: pool.name, toPoolName: target.name,
          amount: m.allocatedBudget, note: 'Pool deleted, balance moved', date: todayStr(),
        });
      }
      if (pool.isDefault) this.db.update('budget_pools', targetPoolId, { isDefault: true });
    } else if (pool.isDefault) {
      const other = this.pools(ws).find((p) => p.id !== poolId);
      this.db.update('budget_pools', other.id, { isDefault: true });
    }
    this.db.delete('budget_pools', poolId);
    this.db.commit();
  }

  poolTransfers(ws, poolId = null) {
    let rows = this.db.all('pool_transfers', { workspaceId: ws }).sort(byDateDesc);
    if (poolId) rows = rows.filter((r) => r.fromPoolId === poolId || r.toPoolId === poolId);
    return rows;
  }

  categoryLookup(ws, query, month) {
    const q = lc(query.trim());
    if (!q) return [];
    const hits = [];
    for (const m of this.poolMetrics(ws, month)) {
      for (const l of m.lines) if (lc(l.name).includes(q)) hits.push({ ...l, poolName: m.name, poolIcon: m.icon });
    }
    for (const c of this.categories(ws)) {
      if (!c.poolId && lc(c.name).includes(q)) hits.push({ ...c, spent: 0, remaining: c.allocated, poolName: null, poolIcon: '' });
    }
    return hits;
  }

  // ================================================================= bills
  bills(ws) {
    return this.db.all('bills', { workspaceId: ws }).sort((a, b) => (a.dueDay - b.dueDay) || lc(a.billName).localeCompare(lc(b.billName)));
  }

  saveBill(ws, data, commit = true) {
    const d = { ...data };
    if (!(d.billName || '').trim()) throw new FinanceError('Bill name is required.');
    d.dueDay = Math.max(1, Math.min(31, parseInt(d.dueDay, 10) || 1));
    d.workspaceId = ws;
    if (d.category) this.ensureCategory(ws, d.category, 'Bills');
    let out;
    if (d.id && this.db.get('bills', d.id)) out = this.db.update('bills', d.id, d);
    else {
      d.paidMonths ||= [];
      d.reminderTime ||= '09:00';
      out = this.db.insert('bills', d);
    }
    if (commit) this.db.commit();
    return out;
  }

  deleteBill(id) { this.db.delete('bills', id); this.db.commit(); }

  billStatus(bill, on = null) {
    on ||= todayStr();
    const key = monthKey(on);
    const day = Math.min(bill.dueDay, daysInMonth(key));
    const due = `${key}-${String(day).padStart(2, '0')}`;
    const paid = (bill.paidMonths || []).includes(key);
    const daysLeft = dayDiff(due, on);
    let status, tone;
    if (paid) [status, tone] = ['Paid', 'emerald'];
    else if (daysLeft < 0) [status, tone] = [`Overdue ${-daysLeft}d`, 'rose'];
    else if (daysLeft === 0) [status, tone] = ['Due today', 'amber'];
    else [status, tone] = [`${daysLeft} day${daysLeft !== 1 ? 's' : ''} left`, 'neutral'];
    return { dueDate: due, dueLabel: ordinal(bill.dueDay), paid, daysLeft, status, tone, monthKey: key };
  }

  toggleBillPaid(billId, month = null) {
    const b = this.db.get('bills', billId);
    const key = month || monthKey();
    const months = (b.paidMonths || []).filter((m) => m !== key);
    if (months.length === (b.paidMonths || []).length) months.push(key);
    this.db.update('bills', billId, { paidMonths: months.sort() });
    this.db.commit();
    return months.includes(key);
  }

  pendingBillsCount(ws) { return this.bills(ws).filter((b) => !this.billStatus(b).paid).length; }

  /** Unpaid bills, across all workspaces, whose reminder time has arrived today. */
  billsToNotify() {
    const now = nowLondon();
    const out = [];
    for (const b of this.db.all('bills')) {
      if (!b.reminderEnabled) continue;
      const st = this.billStatus(b, now.date);
      if (st.paid || st.dueDate !== now.date) continue;
      if (now.time < (b.reminderTime || '09:00')) continue;
      if (b.lastNotifiedKey === st.monthKey) continue;
      out.push({ ...b, ...st, notifyKey: st.monthKey });
    }
    return out;
  }

  markNotified(billId, key) { this.db.update('bills', billId, { lastNotifiedKey: key }); this.db.commit(); }

  // ================================================================= goals
  goals(ws) { return this.db.all('budget_goals', { workspaceId: ws }).sort((a, b) => lc(a.category).localeCompare(lc(b.category))); }

  saveGoal(ws, data, commit = true) {
    const d = { ...data, workspaceId: ws };
    const out = d.id && this.db.get('budget_goals', d.id) ? this.db.update('budget_goals', d.id, d) : this.db.insert('budget_goals', d);
    if (commit) this.db.commit();
    return out;
  }

  deleteGoal(id) { this.db.delete('budget_goals', id); this.db.commit(); }

  // =========================================================== P&L/charts
  static totals(txs) {
    const t = Object.fromEntries(TX_TYPES.map((k) => [k, 0]));
    for (const x of txs) t[x.type] = (t[x.type] || 0) + Math.abs(x.amount);
    const outflow = OUTFLOW_TYPES.reduce((s, k) => s + t[k], 0);
    return {
      income: t.Income, expenses: t.Expense, bills: t.Bills, debt: t['Debt Payment'], savings: t.Savings,
      investment: t.Investment, outflow, net: t.Income - outflow, count: txs.length,
    };
  }

  monthlyPL(ws) {
    const txs = this.db.all('transactions', { workspaceId: ws });
    const trs = this.db.all('transfers', { workspaceId: ws });
    const months = [...new Set([...txs.map((t) => t.date.slice(0, 7)), ...trs.map((t) => t.date.slice(0, 7)), monthKey()])]
      .sort().reverse();
    const byM = {};
    for (const t of txs) (byM[t.date.slice(0, 7)] ||= []).push(t);
    return months.map((m) => ({
      month: m, ...Finance.totals(byM[m] || []), transfers: trs.filter((t) => t.date.slice(0, 7) === m).length,
    }));
  }

  dailyTotals(ws, month) {
    const out = {};
    const get = (d) => (out[d] ||= { income: 0, outflow: 0, count: 0, transfers: 0 });
    for (const t of this.transactions(ws, { month })) {
      const d = get(t.date);
      if (t.type === 'Income') d.income += t.amount; else d.outflow -= t.amount;
      d.count++;
    }
    const [s, e] = monthBounds(month);
    for (const t of this.transfers(ws, s, e)) get(t.date).transfers++;
    return out;
  }

  /** Total money at hand at the end of each of the last `days` days. */
  balanceSeries(ws, days = 30) {
    const end = todayStr();
    const start = addDays(end, -(days - 1));
    let bal = this.accounts(ws).reduce((s, a) => s + a.initialBalance, 0);
    const deltas = {};
    for (const t of this.db.raw('transactions')) {
      if (t.workspaceId !== ws) continue;
      if (t.date < start) bal += t.amount;
      else deltas[t.date] = (deltas[t.date] || 0) + t.amount;
    }
    const out = [];
    for (let i = 0; i < days; i++) {
      const d = addDays(start, i);
      bal += deltas[d] || 0;
      out.push([d, round2(bal)]);
    }
    return out;
  }

  spendByCategory(ws, month) {
    const colors = Object.fromEntries(this.categories(ws).map((c) => [lc(c.name), c.color]));
    const agg = {};
    for (const t of this.transactions(ws, { month })) {
      if (t.type !== 'Income') agg[t.category] = (agg[t.category] || 0) - t.amount;
    }
    return Object.entries(agg).sort((a, b) => b[1] - a[1]).map(([k, v]) => [k, round2(v), colors[lc(k)] || '#a1a1aa']);
  }

  // =================================================================== DLA
  dlaRows(businessWs = null, search = '') {
    const q = lc(search);
    const names = Object.fromEntries(this.workspaces().map((w) => [w.id, w.name]));
    return this.db.all('transactions')
      .filter((t) => t.isBusinessPayment && (!businessWs || t.businessWorkspaceId === businessWs))
      .filter((t) => !q || [t.description, t.category, t.businessCategory, t.dlaNotes].some((x) => lc(x).includes(q)))
      .sort((a, b) => b.date.localeCompare(a.date))
      .map((r) => ({ ...r, sourceWorkspace: names[r.workspaceId] || '?', dlaEffect: -r.amount }));
  }

  dlaBalance(businessWs = null) { return round2(this.dlaRows(businessWs).reduce((s, r) => s + r.dlaEffect, 0)); }

  // ============================================================== analysis
  period(mode, start = null, end = null) {
    const t = todayStr();
    if (mode === 'WTD') return [weekStart(t), t];
    if (mode === 'MTD') return [t.slice(0, 8) + '01', t];
    return [start || t.slice(0, 8) + '01', end || t];
  }

  analysis(ws, start, end, type = null, search = '') {
    const txs = this.transactions(ws, { start, end });
    const totals = Finance.totals(txs);
    const agg = new Map();
    for (const t of txs) {
      if (type && t.type !== type) continue;
      const k = `${t.category}|${t.type}`;
      const a = agg.get(k) || { category: t.category, type: t.type, total: 0, count: 0 };
      a.total += Math.abs(t.amount); a.count++;
      agg.set(k, a);
    }
    let cats = [...agg.values()];
    if (search) cats = cats.filter((c) => lc(c.category).includes(lc(search)));
    const grand = cats.reduce((s, c) => s + c.total, 0) || 1;
    for (const c of cats) c.pct = c.total / grand * 100;
    cats.sort((a, b) => b.total - a.total);
    return { totals, categories: cats, start, end };
  }
}
