// Business logic: balances, budget pools, P&L, bills, DLA and analysis.
// A line-by-line port of the desktop app's services.py, so the numbers match.

import {
  OUTFLOW_TYPES, TX_TYPES, addDays, daysInMonth, dayDiff, fmtMoney, monthBounds, monthKey, nowLondon,
  ordinal, round2, shiftMonth, signedAmount, todayStr, weekStart,
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
      funded: 0, budgetStart: `${monthKey()}-01`,
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
      'budget_goals', 'bank_accounts', 'plan_items', 'plan_notes', 'forecasts']) {
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

  /** Money at hand counts only what you actually have: accounts below £0 don't reduce it. */
  moneyAtHand(ws) { return round2(this.accountSummaries(ws).reduce((s, a) => s + Math.max(0, a.balance), 0)); }

  /** What's owed on overdrawn accounts (shown as a positive number, kept separate from money at hand). */
  owed(ws) { return round2(this.accountSummaries(ws).reduce((s, a) => s + Math.max(0, -a.balance), 0)); }

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
  // Zero-based budgeting with pools:
  //   • Every pound in your bank accounts (Money at Hand) should sit in a pool.
  //   • "Left to assign" = Money at Hand − money sitting in connected pools. Aim for £0.00.
  //   • Assigning moves money from "Left to assign" into a pool. Spending takes it out of the pool.
  //   • Income raises "Left to assign"; unspent pool money carries over to next month.
  //   • Each pool has a monthly amount (its plan). "Fill pools" gives every pool its monthly amount once a month.
  // A pool's money = funded − spending in that pool since budgetStart.
  pools(ws) { return this.db.all('budget_pools', { workspaceId: ws }).sort(byOrder); }

  _monthStart(month = monthKey()) { return `${month}-01`; }

  savePool(ws, data, commit = true) {
    const d = { ...data };
    if (!(d.name || '').trim()) throw new FinanceError('Pool name is required.');
    d.name = d.name.trim();
    d.workspaceId = ws;
    if (d.fundingMode === 'percent') {
      // old "% of money at hand" pools become a fixed monthly amount
      d.fundingValue = round2(this.moneyAtHand(ws) * (Number(d.fundingValue) || 0) / 100);
    }
    if (d.isWorkspaceConnected === undefined && d.id) d.isWorkspaceConnected = this.db.get('budget_pools', d.id)?.isWorkspaceConnected ?? true;
    d.fundingMode = d.isWorkspaceConnected ? 'fixed' : 'unconnected';
    if (d.fundingValue !== undefined) d.fundingValue = Math.max(0, Number(d.fundingValue) || 0);
    if (d.isDefault) {
      for (const p of this.pools(ws)) {
        if (p.id !== d.id && p.isDefault) this.db.update('budget_pools', p.id, { isDefault: false });
      }
    }
    let out;
    if (d.id) {
      this._ensureBudget(d.id);
      delete d.funded; delete d.budgetStart; delete d.filledMonth;
      out = this.db.update('budget_pools', d.id, d);
      for (const t of this.db.raw('transactions')) {
        if (t.poolId === out.id && t.poolName !== out.name) this.db.update('transactions', t.id, { poolName: out.name });
      }
    } else {
      d.order ??= this.pools(ws).length;
      d.fundingValue ??= 0;
      d.funded ??= 0;
      d.budgetStart ||= this._monthStart();
      if (!this.pools(ws).length) d.isDefault = true;
      out = this.db.insert('budget_pools', d);
    }
    if (commit) this.db.commit();
    return out;
  }

  /** Older data: pool budget = max(fixed / % value, category lines). */
  _legacyBudget(pool, ws) {
    let v = pool.fundingValue || 0;
    if (pool.fundingMode === 'percent') v = round2(this.moneyAtHand(ws) * v / 100);
    let lines = 0;
    for (const c of this.db.raw('categories')) if (c.poolId === pool.id) lines += c.allocated || 0;
    return round2(Math.max(v, lines));
  }

  /** Pools saved before zero-based budgeting get a starting balance equal to their old budget (no money lost). */
  _budgetFields(pool) {
    if (pool.budgetStart) return pool;
    const legacy = this._legacyBudget(pool, pool.workspaceId);
    return {
      ...pool, budgetStart: this._monthStart(), funded: legacy, filledMonth: monthKey(),
      fundingMode: pool.isWorkspaceConnected ? 'fixed' : 'unconnected',
      fundingValue: pool.fundingMode === 'percent' ? legacy : pool.fundingValue,
    };
  }

  _ensureBudget(poolId) {
    const p = this.db.get('budget_pools', poolId);
    if (!p || p.budgetStart) return p;
    const f = this._budgetFields(p);
    return this.db.update('budget_pools', poolId, {
      budgetStart: f.budgetStart, funded: f.funded, filledMonth: f.filledMonth, fundingMode: f.fundingMode, fundingValue: f.fundingValue,
    });
  }

  /** Save the starting balance on any pool that doesn't have one yet. Safe to call often. */
  migrateBudgets() {
    let n = 0;
    for (const p of this.db.all('budget_pools')) if (!p.budgetStart) { this._ensureBudget(p.id); n++; }
    if (n) this.db.commit();
    return n;
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
    const cats = this.categories(ws);
    const [byCat, byPool] = this._spendIndex(ws, month);
    const pools = this.pools(ws).map((p) => this._budgetFields(p));
    const since = new Map();
    const starts = new Map(pools.map((p) => [p.id, p.budgetStart]));
    for (const t of this.db.raw('transactions')) {
      if (t.workspaceId !== ws || t.type === 'Income' || !starts.has(t.poolId)) continue;
      if (t.date < starts.get(t.poolId)) continue;
      since.set(t.poolId, (since.get(t.poolId) || 0) - t.amount);
    }
    const cur = monthKey();
    return pools.map((p) => {
      const lines = cats.filter((c) => c.poolId === p.id).map((c) => {
        const spent = round2(byCat.get(`${p.id}|${lc(c.name)}`) || 0);
        const pct = c.allocated ? spent / c.allocated * 100 : (spent ? 100 : 0);
        return { ...c, spent, remaining: round2(c.allocated - spent), pctUsed: pct };
      });
      const budgetedLines = round2(lines.reduce((s, l) => s + l.allocated, 0));
      const spent = round2(byPool.get(p.id) || 0);
      const available = round2(p.funded - (since.get(p.id) || 0));
      const monthly = round2(Math.max(p.fundingValue || 0, budgetedLines));
      const base = spent + Math.max(available, 0);
      return {
        ...p, available, monthly, spent, budgetedLines, lines, filledThisMonth: p.filledMonth === cur,
        // kept for older screens
        leftToSpend: available, allocatedBudget: round2(spent + available),
        pctSpent: base > 0 ? spent / base * 100 : (spent ? 100 : 0),
      };
    });
  }

  /** The top of the budget: what you have, what's in pools, and what's left to assign (aim: £0.00). */
  header(ws, month, metrics = null) {
    metrics ||= this.poolMetrics(ws, month);
    const mah = this.moneyAtHand(ws);
    const conn = metrics.filter((m) => m.isWorkspaceConnected);
    const inPools = round2(conn.reduce((s, m) => s + m.available, 0));
    const toAssign = round2(mah - inPools);
    const toFill = conn.filter((m) => !m.filledThisMonth && m.monthly > 0);
    return {
      moneyAtHand: mah, owed: this.owed(ws), inPools, toAssign, assigned: inPools, unpooled: toAssign,
      standalone: round2(metrics.filter((m) => !m.isWorkspaceConnected).reduce((s, m) => s + m.available, 0)),
      fillNeeded: round2(toFill.reduce((s, m) => s + m.monthly, 0)), fillCount: toFill.length,
      overspent: metrics.filter((m) => m.available < -0.004),
    };
  }

  _poolMetric(poolId, month = null) {
    const pool = this.db.get('budget_pools', poolId);
    if (!pool) throw new FinanceError('That pool no longer exists.');
    return this.poolMetrics(pool.workspaceId, month).find((m) => m.id === poolId);
  }

  _log(ws, fromId, toId, fromName, toName, amount, note) {
    this.db.insert('pool_transfers', {
      workspaceId: ws, fromPoolId: fromId, toPoolId: toId, fromPoolName: fromName, toPoolName: toName,
      amount: round2(Math.abs(amount)), note, date: todayStr(),
    });
  }

  /**
   * Give a pool money from "Left to assign" (or take it back with a negative amount).
   * Connected pools can only be given money you actually have.
   */
  assign(poolId, amount, note = '', commit = true) {
    amount = round2(amount);
    if (!amount) throw new FinanceError('Enter an amount.');
    this._ensureBudget(poolId);
    const m = this._poolMetric(poolId);
    const cash = m.isWorkspaceConnected ? 'Left to assign' : 'Outside money';
    if (amount > 0 && m.isWorkspaceConnected) {
      const left = this.header(m.workspaceId).toAssign;
      if (amount > left + 0.004) {
        throw new FinanceError(left > 0
          ? `You only have ${fmtMoney(left)} left to assign. Assign that, or move money from another pool.`
          : 'You have no money left to assign. Add income first, or move money from another pool.');
      }
    }
    if (amount < 0 && -amount > Math.max(m.available, 0) + 0.004) {
      throw new FinanceError(`${m.name} only has ${fmtMoney(Math.max(m.available, 0))} to take back.`);
    }
    this.db.update('budget_pools', poolId, { funded: round2(m.funded + amount) });
    if (amount > 0) this._log(m.workspaceId, null, poolId, cash, m.name, amount, note || 'Assigned');
    else this._log(m.workspaceId, poolId, null, m.name, cash, amount, note || 'Taken back');
    if (commit) this.db.commit();
  }

  /** Give every connected pool its monthly amount for this month (once per month), as far as the money goes. */
  fillPools(ws) {
    const cur = monthKey();
    let left = this.header(ws).toAssign;
    const done = [], short = [];
    for (const m of this.poolMetrics(ws)) {
      if (m.filledMonth === cur || !(m.monthly > 0)) continue;
      let give = m.monthly;
      if (m.isWorkspaceConnected) give = round2(Math.min(give, Math.max(left, 0)));
      if (give < m.monthly - 0.004) short.push(m.name);
      this._ensureBudget(m.id);
      if (give > 0) {
        this.db.update('budget_pools', m.id, { funded: round2(m.funded + give), filledMonth: cur });
        this._log(ws, null, m.id, m.isWorkspaceConnected ? 'Left to assign' : 'Outside money', m.name, give, `Monthly amount for ${cur}`);
        if (m.isWorkspaceConnected) left = round2(left - give);
        done.push([m.name, give]);
      }
    }
    this.db.commit();
    return { done, short, total: round2(done.reduce((s, d) => s + d[1], 0)) };
  }

  /** Move money between two pools. */
  poolTransfer(ws, fromId, toId, amount, note = '', commit = true) {
    if (fromId === toId) throw new FinanceError('Choose two different pools.');
    amount = round2(amount);
    if (amount <= 0) throw new FinanceError('Amount must be more than £0.00.');
    this._ensureBudget(fromId); this._ensureBudget(toId);
    const src = this._poolMetric(fromId), dst = this._poolMetric(toId);
    if (!!src.isWorkspaceConnected !== !!dst.isWorkspaceConnected) {
      throw new FinanceError('Standalone pools use outside money, so they can only swap money with other standalone pools.');
    }
    if (amount > Math.max(src.available, 0) + 0.004) {
      throw new FinanceError(`${src.name} only has ${fmtMoney(Math.max(src.available, 0))} in it.`);
    }
    this.db.update('budget_pools', fromId, { funded: round2(src.funded - amount) });
    this.db.update('budget_pools', toId, { funded: round2(dst.funded + amount) });
    this._log(ws, fromId, toId, src.name, dst.name, amount, note);
    if (commit) this.db.commit();
  }

  // kept so older calls still work
  pushFunds(poolId, amount) {
    if (!(amount > 0)) throw new FinanceError('Amount must be more than £0.00.');
    this.assign(poolId, amount, 'Assigned');
  }

  /** Move part of one category's monthly plan to another. Across pools, the money moves too. */
  categoryTransfer(fromCat, toCat, amount, note = '', commit = true) {
    const a = this.db.get('categories', fromCat), b = this.db.get('categories', toCat);
    amount = round2(amount);
    if (!a || !b) throw new FinanceError('Choose both categories.');
    if (a.id === b.id) throw new FinanceError('Choose two different categories.');
    if (amount <= 0 || amount > a.allocated + 0.001) throw new FinanceError(`${a.name} only has ${fmtMoney(a.allocated)} planned.`);
    if (a.poolId !== b.poolId && a.poolId && b.poolId) {
      this.poolTransfer(a.workspaceId, a.poolId, b.poolId, amount, note || `${a.name} → ${b.name}`, false);
    } else {
      const pa = a.poolId ? this.db.get('budget_pools', a.poolId) : null;
      this._log(a.workspaceId, a.poolId, b.poolId, `${pa ? pa.name : '—'} · ${a.name}`, `${pa ? pa.name : '—'} · ${b.name}`, amount, note || 'Category plan moved');
    }
    this.db.update('categories', a.id, { allocated: a.allocated - amount });
    this.db.update('categories', b.id, { allocated: b.allocated + amount });
    if (commit) this.db.commit();
  }

  /** Cover an overspent pool from "Left to assign" ('cash') or from another pool. Returns the amount moved. */
  coverPool(poolId, source) {
    const m = this._poolMetric(poolId);
    const deficit = round2(-m.available);
    if (deficit <= 0) throw new FinanceError(`${m.name} is not overspent.`);
    let amt;
    if (source === 'cash') {
      const left = this.header(m.workspaceId).toAssign;
      amt = round2(Math.min(deficit, Math.max(left, 0)));
      if (amt <= 0) throw new FinanceError('There is nothing left to assign. Cover it from another pool.');
      this.assign(poolId, amt, 'Cover overspending');
    } else {
      const src = this._poolMetric(source);
      amt = round2(Math.min(deficit, Math.max(src.available, 0)));
      if (amt <= 0) throw new FinanceError(`${src.name} has no money to give.`);
      this.poolTransfer(m.workspaceId, source, poolId, amt, 'Cover overspending');
    }
    return amt;
  }

  /** Older call: cover a category from a pool (now moves pool money). */
  coverOverspend(catId, sourceKind, sourceId, month = null) {
    const cat = this.db.get('categories', catId);
    const m = this._poolMetric(cat.poolId, month);
    const line = m.lines.find((l) => l.id === catId);
    const deficit = round2(-line.remaining);
    if (deficit <= 0) throw new FinanceError(`${cat.name} is not overspent.`);
    if (sourceKind === 'category') {
      const src = m.lines.find((l) => l.id === sourceId);
      const amt = Math.min(deficit, src.remaining);
      this.categoryTransfer(sourceId, catId, amt, `Cover overspend on ${cat.name}`);
      return amt;
    }
    const src = this._poolMetric(sourceId, month);
    const amt = round2(Math.min(deficit, Math.max(src.available, 0)));
    if (amt <= 0) throw new FinanceError(`${src.name} has no money to give.`);
    this.poolTransfer(cat.workspaceId, sourceId, cat.poolId, amt, `Cover overspend on ${cat.name}`, false);
    this.db.update('categories', catId, { allocated: cat.allocated + amt });
    this.db.commit();
    return amt;
  }

  deletePool(poolId, targetPoolId = null) {
    const pool = this.db.get('budget_pools', poolId);
    const ws = pool.workspaceId;
    if (this.pools(ws).length <= 1) throw new FinanceError('A workspace needs at least one pool.');
    const m = this._poolMetric(poolId);
    const cats = this.categories(ws).filter((c) => c.poolId === poolId);
    const nonEmpty = Math.abs(m.available) > 0.004 || cats.length || m.spent > 0 || m.funded > 0;
    if (nonEmpty && !targetPoolId) {
      throw new FinanceError("This pool isn't empty. Choose a pool to receive its money and categories.");
    }
    if (targetPoolId) {
      this._ensureBudget(poolId); this._ensureBudget(targetPoolId);
      const target = this.db.get('budget_pools', targetPoolId);
      const want = round2(this._poolMetric(targetPoolId).available + m.available);
      for (const c of cats) this.setCategoryPool(c.id, targetPoolId, false);
      for (const t of this.db.raw('transactions')) {
        if (t.poolId === poolId) this.db.update('transactions', t.id, { poolId: targetPoolId, poolName: target.name });
      }
      // the target ends up holding both pools' money
      if (pool.isDefault) this.db.update('budget_pools', targetPoolId, { isDefault: true });
      this.db.delete('budget_pools', poolId);
      const got = this._poolMetric(targetPoolId).available;
      this.db.update('budget_pools', targetPoolId, { funded: round2(target.funded + want - got) });
      if (Math.abs(m.available) > 0.004) {
        this._log(ws, poolId, targetPoolId, pool.name, target.name, m.available, 'Pool deleted, money moved');
      }
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

  // ======================================================= plans & forecast
  planItems(ws) {
    const rank = { idea: 0, saving: 1, bought: 2 };
    return this.db.all('plan_items', { workspaceId: ws }).sort((a, b) => ((rank[a.status] ?? 0) - (rank[b.status] ?? 0))
      || (a.targetMonth || '9999').localeCompare(b.targetMonth || '9999') || byName(a, b));
  }

  savePlanItem(ws, data) {
    const d = { ...data, workspaceId: ws, name: (data.name || '').trim() };
    if (!d.name) throw new FinanceError('Give it a name.');
    for (const k of ['cost', 'extraCost', 'monthlyCost']) d[k] = Math.abs(Number(d[k]) || 0);
    if (!['idea', 'saving', 'bought'].includes(d.status)) d.status = 'idea';
    d.targetMonth = /^\d{4}-\d{2}$/.test(d.targetMonth || '') ? d.targetMonth : null;
    const out = d.id && this.db.get('plan_items', d.id) ? this.db.update('plan_items', d.id, d) : this.db.insert('plan_items', d);
    this.db.commit();
    return out;
  }

  deletePlanItem(id) { this.db.delete('plan_items', id); this.db.commit(); }

  planNotes(ws) {
    return this.db.all('plan_notes', { workspaceId: ws }).sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || ''));
  }

  savePlanNote(ws, data) {
    const d = { ...data, workspaceId: ws, title: (data.title || '').trim(), body: (data.body || '').trim() };
    if (!d.title && !d.body) throw new FinanceError('Write something first.');
    const out = d.id && this.db.get('plan_notes', d.id) ? this.db.update('plan_notes', d.id, d) : this.db.insert('plan_notes', d);
    this.db.commit();
    return out;
  }

  deletePlanNote(id) { this.db.delete('plan_notes', id); this.db.commit(); }

  /** The workspace's forecast settings (defaults until first saved). */
  forecastSettings(ws) {
    const f = this.db.all('forecasts', { workspaceId: ws })[0];
    return f || { id: null, workspaceId: ws, startAmount: 0, useMoneyAtHand: true, monthlySaving: 200, interestRate: 0, years: 5, includePlans: true };
  }

  saveForecastSettings(ws, fields) {
    const cur = this.forecastSettings(ws);
    const d = { ...cur, ...fields, workspaceId: ws };
    d.years = Math.max(1, Math.min(40, parseInt(d.years, 10) || 1));
    d.interestRate = Math.max(-50, Math.min(100, Number(d.interestRate) || 0));
    d.monthlySaving = Number(d.monthlySaving) || 0;
    d.startAmount = Number(d.startAmount) || 0;
    const out = cur.id && this.db.get('forecasts', cur.id) ? this.db.update('forecasts', cur.id, d) : this.db.insert('forecasts', { ...d, id: undefined });
    this.db.commit();
    return out;
  }

  /**
   * Month-by-month savings forecast. Interest is a yearly % added monthly. Purchases not yet bought and
   * with a "when" month come out in that month (price + extras), and their running cost every month after.
   * Returns {start, months:[{month, plain, withPlans}], years:[...], items:[{id, affordMonth}]}.
   */
  forecast(ws, settings = null, fromMonth = null) {
    const s = settings || this.forecastSettings(ws);
    const start = round2(s.useMoneyAtHand ? this.moneyAtHand(ws) : s.startAmount);
    const n = Math.max(1, Math.min(40, s.years || 1)) * 12;
    const r = (Number(s.interestRate) || 0) / 100 / 12;
    const first = fromMonth || shiftMonth(monthKey(), 1);
    const items = this.planItems(ws).filter((p) => p.status !== 'bought');
    const dated = s.includePlans ? items.filter((p) => p.targetMonth) : [];
    let plain = start, withPlans = start;
    const months = [];
    const yrs = [];
    let yr = { saved: 0, interest: 0, spent: 0 };
    for (let i = 0; i < n; i++) {
      const m = shiftMonth(first, i);
      const intPlain = plain * r;
      const intPlans = withPlans * r;
      let spent = 0;
      for (const p of dated) {
        if (p.targetMonth === m || (i === 0 && p.targetMonth < m)) spent += p.cost + p.extraCost;
        if (p.targetMonth <= m) spent += p.monthlyCost;
      }
      plain += intPlain + (s.monthlySaving || 0);
      withPlans += intPlans + (s.monthlySaving || 0) - spent;
      yr.saved += s.monthlySaving || 0; yr.interest += s.includePlans ? intPlans : intPlain; yr.spent += spent;
      months.push({ month: m, plain: round2(plain), withPlans: round2(withPlans) });
      if ((i + 1) % 12 === 0) {
        yrs.push({ year: (i + 1) / 12, month: m, saved: round2(yr.saved), interest: round2(yr.interest), spent: round2(yr.spent), balance: round2(s.includePlans ? withPlans : plain) });
        yr = { saved: 0, interest: 0, spent: 0 };
      }
    }
    // when could each purchase be paid for outright (on the plain forecast)?
    const afford = {};
    for (const p of items) {
      const need = p.cost + p.extraCost;
      afford[p.id] = need <= start ? 'now' : (months.find((x) => x.plain >= need)?.month || null);
    }
    return { start, months, years: yrs, afford, end: months[months.length - 1] };
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

  /** Total money at hand at the end of each of the last `days` days (overdrawn accounts count as £0). */
  balanceSeries(ws, days = 30) {
    const end = todayStr();
    const start = addDays(end, -(days - 1));
    const bal = Object.fromEntries(this.accounts(ws).map((a) => [a.name, a.initialBalance]));
    const deltas = {};
    const add = (date, acc, amt) => {
      if (date < start) bal[acc] = (bal[acc] || 0) + amt;
      else ((deltas[date] ||= {})[acc] = (deltas[date][acc] || 0) + amt);
    };
    for (const t of this.db.raw('transactions')) if (t.workspaceId === ws) add(t.date, t.bankAccount, t.amount);
    for (const t of this.db.raw('transfers')) {
      if (t.workspaceId !== ws) continue;
      add(t.date, t.fromAccount, -t.amount);
      add(t.date, t.toAccount, t.amount);
    }
    const out = [];
    for (let i = 0; i < days; i++) {
      const d = addDays(start, i);
      for (const [acc, amt] of Object.entries(deltas[d] || {})) bal[acc] = (bal[acc] || 0) + amt;
      out.push([d, round2(Object.values(bal).reduce((s, v) => s + Math.max(0, v), 0))]);
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
