// In-memory data store. Every screen reads from here synchronously; changes are
// queued and handed to a persistence adapter (Firebase or this browser) on commit().

import { newId, nowIso, round2 } from './util.js';

// table -> {field: type}. Same field names as the desktop app.
export const SCHEMA = {
  workspaces: { id: 'TEXT', name: 'TEXT', kind: 'TEXT', isPreset: 'BOOL', order: 'INT', createdAt: 'TEXT', updatedAt: 'TEXT' },
  bank_accounts: { id: 'TEXT', workspaceId: 'TEXT', name: 'TEXT', initialBalance: 'REAL', createdAt: 'TEXT', updatedAt: 'TEXT' },
  transactions: {
    id: 'TEXT', workspaceId: 'TEXT', date: 'TEXT', type: 'TEXT', category: 'TEXT', bankAccount: 'TEXT', amount: 'REAL',
    description: 'TEXT', poolId: 'TEXT', poolName: 'TEXT', isBusinessPayment: 'BOOL', businessWorkspaceId: 'TEXT',
    businessWorkspaceName: 'TEXT', businessCategory: 'TEXT', dlaNotes: 'TEXT', createdAt: 'TEXT', updatedAt: 'TEXT',
  },
  transfers: {
    id: 'TEXT', workspaceId: 'TEXT', date: 'TEXT', fromAccount: 'TEXT', toAccount: 'TEXT', amount: 'REAL', notes: 'TEXT',
    createdAt: 'TEXT', updatedAt: 'TEXT',
  },
  categories: {
    id: 'TEXT', workspaceId: 'TEXT', name: 'TEXT', defaultType: 'TEXT', bankAccount: 'TEXT', color: 'TEXT', poolId: 'TEXT',
    allocated: 'REAL', isProtected: 'BOOL', createdAt: 'TEXT', updatedAt: 'TEXT',
  },
  budget_pools: {
    id: 'TEXT', workspaceId: 'TEXT', name: 'TEXT', color: 'TEXT', icon: 'TEXT', isWorkspaceConnected: 'BOOL',
    fundingMode: 'TEXT', fundingValue: 'REAL', isDefault: 'BOOL', order: 'INT', description: 'TEXT',
    createdAt: 'TEXT', updatedAt: 'TEXT',
  },
  pool_transfers: {
    id: 'TEXT', workspaceId: 'TEXT', fromPoolId: 'TEXT', toPoolId: 'TEXT', fromPoolName: 'TEXT', toPoolName: 'TEXT',
    amount: 'REAL', note: 'TEXT', date: 'TEXT', createdAt: 'TEXT', updatedAt: 'TEXT',
  },
  bills: {
    id: 'TEXT', workspaceId: 'TEXT', billName: 'TEXT', category: 'TEXT', dueDay: 'INT', amount: 'REAL', bankAccount: 'TEXT',
    reminderTime: 'TEXT', reminderEnabled: 'BOOL', notes: 'TEXT', paidMonths: 'JSON', lastNotifiedKey: 'TEXT',
    createdAt: 'TEXT', updatedAt: 'TEXT',
  },
  budget_goals: { id: 'TEXT', workspaceId: 'TEXT', category: 'TEXT', amount: 'REAL', type: 'TEXT', createdAt: 'TEXT', updatedAt: 'TEXT' },
};
export const TABLES = Object.keys(SCHEMA);

/** Coerce a record to the schema: only known fields, right types, no undefined. */
export function clean(table, data) {
  const cols = SCHEMA[table];
  const out = {};
  for (const [k, t] of Object.entries(cols)) {
    let v = data[k];
    if (t === 'BOOL') v = !!v;
    else if (t === 'REAL') v = round2(v);
    else if (t === 'INT') v = Number.isFinite(+v) && v !== null && v !== '' ? Math.trunc(+v) : 0;
    else if (t === 'JSON') v = Array.isArray(v) ? [...v] : [];
    else v = v === undefined || v === null || v === '' ? null : String(v);
    out[k] = v;
  }
  return out;
}

export class Store {
  constructor() {
    this.tables = Object.fromEntries(TABLES.map((t) => [t, new Map()]));
    this.pending = new Map(); // "table/id" -> {table, id, doc|null}
    this.subs = new Set();
    this.adapter = null;
    this.version = 0;
  }

  subscribe(fn) { this.subs.add(fn); return () => this.subs.delete(fn); }
  notify() { this.version++; for (const f of this.subs) f(this.version); }

  get(table, id) {
    if (!id) return null;
    const r = this.tables[table].get(id);
    return r ? { ...r } : null;
  }

  /** all('transactions', {workspaceId: ws}) */
  all(table, where = null) {
    const out = [];
    for (const r of this.tables[table].values()) {
      if (where) {
        let ok = true;
        for (const k in where) if (r[k] !== where[k]) { ok = false; break; }
        if (!ok) continue;
      }
      out.push({ ...r });
    }
    return out;
  }

  /** Iterate without copying (read-only use). */
  raw(table) { return this.tables[table].values(); }

  insert(table, data) {
    const d = { ...data };
    if (!d.id) d.id = newId();
    const ts = nowIso();
    d.createdAt = d.createdAt || ts;
    d.updatedAt = d.updatedAt || ts;
    const rec = clean(table, d);
    this.tables[table].set(rec.id, rec);
    this.pending.set(`${table}/${rec.id}`, { table, id: rec.id, doc: rec });
    return { ...rec };
  }

  update(table, id, fields) {
    const old = this.tables[table].get(id);
    if (!old) return null;
    const f = { ...fields };
    delete f.id;
    const rec = clean(table, { ...old, ...f, id, updatedAt: nowIso() });
    this.tables[table].set(id, rec);
    this.pending.set(`${table}/${id}`, { table, id, doc: rec });
    return { ...rec };
  }

  delete(table, id) {
    if (!this.tables[table].has(id)) return;
    this.tables[table].delete(id);
    this.pending.set(`${table}/${id}`, { table, id, doc: null });
  }

  /** Persist queued changes and refresh the screen. */
  commit() {
    const ops = [...this.pending.values()];
    this.pending.clear();
    if (ops.length && this.adapter) this.adapter.write(ops);
    this.notify();
    return ops.length;
  }

  rollback() { this.pending.clear(); }

  /** Changes coming from the cloud or local storage. */
  applyRemote(changes, { silent = false } = {}) {
    let n = 0;
    for (const { table, id, doc } of changes) {
      if (!this.tables[table]) continue;
      if (this.pending.has(`${table}/${id}`)) continue;
      if (doc) this.tables[table].set(id, clean(table, { ...doc, id }));
      else this.tables[table].delete(id);
      n++;
    }
    if (n && !silent) this.notify();
    return n;
  }

  /** Replace everything (used by restore-from-Excel). Queues deletes + inserts. */
  replaceAll(data) {
    for (const t of TABLES) {
      for (const id of [...this.tables[t].keys()]) this.delete(t, id);
    }
    for (const t of TABLES) {
      for (const r of data[t] || []) {
        const rec = clean(t, r);
        this.tables[t].set(rec.id, rec);
        this.pending.set(`${t}/${rec.id}`, { table: t, id: rec.id, doc: rec });
      }
    }
  }

  snapshot() {
    return Object.fromEntries(TABLES.map((t) => [t, this.all(t)]));
  }
}
