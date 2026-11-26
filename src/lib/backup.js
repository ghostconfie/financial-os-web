// Full Excel backup and restore.
//
// One .xlsx holds everything (all workspaces). It opens and edits normally in Excel: references use
// names (workspace, pool, account), dates are real Excel dates and money is £ formatted. Restoring it
// into an empty app — on any device, in any new copy of the app — rebuilds exactly the same data.

import * as XLSXns from 'xlsx';
import { SCHEMA, TABLES, clean } from './store.js';
import { TX_TYPES, newId, nowIso, parseAmount, parseBool, parseDate, round2 } from './util.js';

const XLSX = XLSXns.utils ? XLSXns : XLSXns.default;
export const BACKUP_MARK = 'Emperio Finances backup';
const OLD_MARKS = ['Financial OS backup']; // backups made before the rename still restore
export const BACKUP_VERSION = 1;

const yes = (b) => (b ? 'Yes' : 'No');
const MONEY = '£#,##0.00;[Red]-£#,##0.00';
const DATE = 'dd/mm/yyyy';

function serial(iso) {
  if (!iso) return '';
  return Math.round((Date.parse(iso + 'T00:00:00Z') - Date.UTC(1899, 11, 30)) / 86400000);
}

// Each sheet: [sheet name, table, columns]. Column: [header, kind, toCell(rec, ctx), fromCell(v, row, ctx)]
// kind: text | money | date | int | bool | num
const SHEETS = [
  ['Workspaces', 'workspaces', [
    ['ID', 'text', (r) => r.id, 'id'],
    ['Name', 'text', (r) => r.name, 'name'],
    ['Kind', 'text', (r) => (r.kind === 'business' ? 'Business' : 'Personal'), 'kind'],
    ['Order', 'int', (r) => r.order, 'order'],
    ['Preset', 'bool', (r) => r.isPreset, 'isPreset'],
  ]],
  ['Bank Accounts', 'bank_accounts', [
    ['ID', 'text', (r) => r.id, 'id'],
    ['Workspace', 'text', (r, c) => c.wsName(r.workspaceId), 'workspace'],
    ['Account Name', 'text', (r) => r.name, 'name'],
    ['Initial Balance', 'money', (r) => r.initialBalance, 'initialBalance'],
  ]],
  ['Budget Pools', 'budget_pools', [
    ['ID', 'text', (r) => r.id, 'id'],
    ['Workspace', 'text', (r, c) => c.wsName(r.workspaceId), 'workspace'],
    ['Pool Name', 'text', (r) => r.name, 'name'],
    ['Icon', 'text', (r) => r.icon, 'icon'],
    ['Colour', 'text', (r) => r.color, 'color'],
    ['Connected to Money at Hand', 'bool', (r) => r.isWorkspaceConnected, 'isWorkspaceConnected'],
    ['Funding Mode', 'text', (r) => r.fundingMode, 'fundingMode'],
    ['Funding Value', 'num', (r) => r.fundingValue, 'fundingValue'],
    ['Money Put In', 'money', (r) => r.funded, 'funded'],
    ['Budget Start', 'date', (r) => r.budgetStart, 'budgetStart'],
    ['Filled Month', 'text', (r) => r.filledMonth, 'filledMonth'],
    ['Default Pool', 'bool', (r) => r.isDefault, 'isDefault'],
    ['Order', 'int', (r) => r.order, 'order'],
    ['Description', 'text', (r) => r.description, 'description'],
  ]],
  ['Categories', 'categories', [
    ['ID', 'text', (r) => r.id, 'id'],
    ['Workspace', 'text', (r, c) => c.wsName(r.workspaceId), 'workspace'],
    ['Category', 'text', (r) => r.name, 'name'],
    ['Default Type', 'text', (r) => r.defaultType, 'defaultType'],
    ['Bank Account', 'text', (r) => (r.bankAccount === 'ALL' || !r.bankAccount ? 'All accounts' : r.bankAccount), 'bankAccount'],
    ['Pool', 'text', (r, c) => c.poolName(r.poolId), 'pool'],
    ['Allocated', 'money', (r) => r.allocated, 'allocated'],
    ['Colour', 'text', (r) => r.color, 'color'],
    ['Protected', 'bool', (r) => r.isProtected, 'isProtected'],
  ]],
  ['Transactions', 'transactions', [
    ['ID', 'text', (r) => r.id, 'id'],
    ['Workspace', 'text', (r, c) => c.wsName(r.workspaceId), 'workspace'],
    ['Date', 'date', (r) => r.date, 'date'],
    ['Type', 'text', (r) => r.type, 'type'],
    ['Category', 'text', (r) => r.category, 'category'],
    ['Bank Account', 'text', (r) => r.bankAccount, 'bankAccount'],
    ['Amount', 'money', (r) => r.amount, 'amount'],
    ['Description', 'text', (r) => r.description, 'description'],
    ['Pool', 'text', (r, c) => (r.poolId ? c.poolName(r.poolId) || r.poolName : ''), 'pool'],
    ['Business Payment (DLA)', 'bool', (r) => r.isBusinessPayment, 'isBusinessPayment'],
    ['Business Workspace', 'text', (r, c) => (r.businessWorkspaceId ? c.wsName(r.businessWorkspaceId) : r.businessWorkspaceName), 'businessWorkspace'],
    ['Business Category', 'text', (r) => r.businessCategory, 'businessCategory'],
    ['DLA Notes', 'text', (r) => r.dlaNotes, 'dlaNotes'],
    ['Created', 'text', (r) => r.createdAt, 'createdAt'],
  ]],
  ['Transfers', 'transfers', [
    ['ID', 'text', (r) => r.id, 'id'],
    ['Workspace', 'text', (r, c) => c.wsName(r.workspaceId), 'workspace'],
    ['Date', 'date', (r) => r.date, 'date'],
    ['From Account', 'text', (r) => r.fromAccount, 'fromAccount'],
    ['To Account', 'text', (r) => r.toAccount, 'toAccount'],
    ['Amount', 'money', (r) => r.amount, 'amount'],
    ['Notes', 'text', (r) => r.notes, 'notes'],
    ['Created', 'text', (r) => r.createdAt, 'createdAt'],
  ]],
  ['Pool Transfers', 'pool_transfers', [
    ['ID', 'text', (r) => r.id, 'id'],
    ['Workspace', 'text', (r, c) => c.wsName(r.workspaceId), 'workspace'],
    ['Date', 'date', (r) => r.date, 'date'],
    ['From', 'text', (r) => r.fromPoolName, 'fromPoolName'],
    ['To', 'text', (r) => r.toPoolName, 'toPoolName'],
    ['Amount', 'money', (r) => r.amount, 'amount'],
    ['Note', 'text', (r) => r.note, 'note'],
    ['From Pool ID', 'text', (r) => r.fromPoolId, 'fromPoolId'],
    ['To Pool ID', 'text', (r) => r.toPoolId, 'toPoolId'],
    ['Created', 'text', (r) => r.createdAt, 'createdAt'],
  ]],
  ['Bills', 'bills', [
    ['ID', 'text', (r) => r.id, 'id'],
    ['Workspace', 'text', (r, c) => c.wsName(r.workspaceId), 'workspace'],
    ['Bill Name', 'text', (r) => r.billName, 'billName'],
    ['Category', 'text', (r) => r.category, 'category'],
    ['Due Day', 'int', (r) => r.dueDay, 'dueDay'],
    ['Amount', 'money', (r) => r.amount, 'amount'],
    ['Bank Account', 'text', (r) => r.bankAccount, 'bankAccount'],
    ['Reminder Time', 'text', (r) => r.reminderTime, 'reminderTime'],
    ['Reminder On', 'bool', (r) => r.reminderEnabled, 'reminderEnabled'],
    ['Notes', 'text', (r) => r.notes, 'notes'],
    ['Paid Months', 'text', (r) => (r.paidMonths || []).join(', '), 'paidMonths'],
    ['Last Reminded', 'text', (r) => r.lastNotifiedKey, 'lastNotifiedKey'],
  ]],
  ['Budget Goals', 'budget_goals', [
    ['ID', 'text', (r) => r.id, 'id'],
    ['Workspace', 'text', (r, c) => c.wsName(r.workspaceId), 'workspace'],
    ['Category', 'text', (r) => r.category, 'category'],
    ['Monthly Target', 'money', (r) => r.amount, 'amount'],
    ['Type', 'text', (r) => r.type, 'type'],
  ]],
  ['Plans', 'plan_items', [
    ['ID', 'text', (r) => r.id, 'id'],
    ['Workspace', 'text', (r, c) => c.wsName(r.workspaceId), 'workspace'],
    ['What', 'text', (r) => r.name, 'name'],
    ['Price', 'money', (r) => r.cost, 'cost'],
    ['Extra One-off Costs', 'money', (r) => r.extraCost, 'extraCost'],
    ['Ongoing Cost per Month', 'money', (r) => r.monthlyCost, 'monthlyCost'],
    ['Status', 'text', (r) => STATUS_LABEL[r.status] || 'Idea', 'status'],
    ['When (YYYY-MM)', 'text', (r) => r.targetMonth, 'targetMonth'],
    ['Notes', 'text', (r) => r.notes, 'notes'],
    ['Created', 'text', (r) => r.createdAt, 'createdAt'],
  ]],
  ['Plan Notes', 'plan_notes', [
    ['ID', 'text', (r) => r.id, 'id'],
    ['Workspace', 'text', (r, c) => c.wsName(r.workspaceId), 'workspace'],
    ['Title', 'text', (r) => r.title, 'title'],
    ['Note', 'text', (r) => r.body, 'body'],
    ['Created', 'text', (r) => r.createdAt, 'createdAt'],
  ]],
  ['Forecast', 'forecasts', [
    ['ID', 'text', (r) => r.id, 'id'],
    ['Workspace', 'text', (r, c) => c.wsName(r.workspaceId), 'workspace'],
    ['Start From Money at Hand', 'bool', (r) => r.useMoneyAtHand, 'useMoneyAtHand'],
    ['Starting Amount', 'money', (r) => r.startAmount, 'startAmount'],
    ['Saving per Month', 'money', (r) => r.monthlySaving, 'monthlySaving'],
    ['Interest % a Year', 'num', (r) => r.interestRate, 'interestRate'],
    ['Years', 'int', (r) => r.years, 'years'],
    ['Take Off Planned Purchases', 'bool', (r) => r.includePlans, 'includePlans'],
  ]],
];
// sheets added later: older backups don't have them, and that's fine
const OPTIONAL_SHEETS = new Set(['Plans', 'Plan Notes', 'Forecast']);
const STATUS_LABEL = { idea: 'Idea', saving: 'Saving up', bought: 'Bought' };

const ORDER_SORT = {
  workspaces: (a, b) => a.order - b.order,
  transactions: (a, b) => a.date.localeCompare(b.date) || (a.createdAt || '').localeCompare(b.createdAt || ''),
  transfers: (a, b) => a.date.localeCompare(b.date),
  pool_transfers: (a, b) => (a.date || '').localeCompare(b.date || '') || (a.createdAt || '').localeCompare(b.createdAt || ''),
};

/** Build the backup workbook. Returns an XLSX workbook object. */
export function buildBackup(store) {
  const ws = Object.fromEntries(store.all('workspaces').map((w) => [w.id, w]));
  const pools = Object.fromEntries(store.all('budget_pools').map((p) => [p.id, p]));
  const ctx = { wsName: (id) => (ws[id] ? ws[id].name : ''), poolName: (id) => (pools[id] ? pools[id].name : '') };
  const wb = XLSX.utils.book_new();
  const counts = {};
  const sheets = [];
  for (const [name, table, cols] of SHEETS) {
    let recs = store.all(table);
    const wsOrder = Object.fromEntries(store.all('workspaces').map((w) => [w.id, w.order]));
    recs.sort((a, b) => ((wsOrder[a.workspaceId] ?? 0) - (wsOrder[b.workspaceId] ?? 0)) || (ORDER_SORT[table] ? ORDER_SORT[table](a, b) : 0));
    counts[name] = recs.length;
    const aoa = [cols.map((c) => c[0])];
    for (const r of recs) {
      aoa.push(cols.map(([, kind, get]) => {
        const v = get(r, ctx);
        if (kind === 'bool') return yes(v);
        if (kind === 'date') return v ? serial(v) : '';
        if (v === null || v === undefined) return '';
        return v;
      }));
    }
    const sh = XLSX.utils.aoa_to_sheet(aoa);
    // formats
    cols.forEach(([, kind], ci) => {
      if (kind !== 'money' && kind !== 'date') return;
      for (let ri = 1; ri < aoa.length; ri++) {
        const cell = sh[XLSX.utils.encode_cell({ r: ri, c: ci })];
        if (cell && cell.t === 'n') cell.z = kind === 'money' ? MONEY : DATE;
      }
    });
    sh['!cols'] = cols.map(([h, kind], ci) => {
      let w = h.length + 2;
      for (let ri = 1; ri < Math.min(aoa.length, 400); ri++) w = Math.max(w, String(aoa[ri][ci] ?? '').length + 2);
      if (h === 'ID' || h.endsWith('Pool ID')) w = 14;
      if (kind === 'date') w = 12;
      if (kind === 'money') w = Math.max(w, 13);
      return { wch: Math.min(w, 48) };
    });
    sh['!autofilter'] = { ref: XLSX.utils.encode_range({ s: { r: 0, c: 0 }, e: { r: Math.max(0, aoa.length - 1), c: cols.length - 1 } }) };
    sheets.push([name, sh]);
  }
  const about = XLSX.utils.aoa_to_sheet([
    [BACKUP_MARK],
    ['Format version', BACKUP_VERSION],
    ['Saved', nowIso()],
    [],
    ['What this file is'],
    ['A complete copy of everything in Emperio Finances: every workspace, account, transaction, transfer, category, pool, bill, goal, plan, note and forecast.'],
    ['To restore: open Emperio Finances, choose Menu → Restore from Excel backup, and pick this file.'],
    ['You can edit it in Excel. Keep the sheet names and the header row. Leave ID blank for new rows.'],
    ['Workspace, Pool and Account columns use names, so they must match the names on the other sheets.'],
    ['Amounts in Transactions: income is positive, spending is negative (the sign is fixed from Type on restore).'],
    [],
    ['Sheet', 'Rows'],
    ...Object.entries(counts),
  ]);
  about['!cols'] = [{ wch: 28 }, { wch: 28 }];
  XLSX.utils.book_append_sheet(wb, about, 'About');
  for (const [name, sh] of sheets) XLSX.utils.book_append_sheet(wb, sh, name);
  return wb;
}

export function backupBytes(store) {
  return XLSX.write(buildBackup(store), { type: 'array', bookType: 'xlsx', compression: true });
}

export function backupFileName() {
  return `Emperio Finances backup ${nowIso().slice(0, 10)}.xlsx`;
}

/** Is this workbook (bytes) an Emperio Finances (or older Financial OS) backup? */
export function isBackup(buf) {
  try {
    const wb = XLSX.read(buf, { type: 'array', sheetRows: 2 });
    const a = wb.Sheets.About;
    return !!(a && a.A1 && [BACKUP_MARK, ...OLD_MARKS].includes(String(a.A1.v).trim())) || SHEETS.every(([n]) => OPTIONAL_SHEETS.has(n) || wb.SheetNames.includes(n));
  } catch {
    return false;
  }
}

function cellToValue(cell) {
  if (!cell || cell.v === undefined || cell.v === null) return '';
  if (cell.t === 'n' && cell.z && XLSX.SSF.is_date(cell.z)) return { __date: cell.v };
  if (cell.t === 'e') return '';
  return cell.v;
}

const text = (v) => (v === '' || v === null || v === undefined ? null : (typeof v === 'object' ? null : String(v).trim() || null));
const dateOf = (v) => {
  if (v && v.__date !== undefined) return parseDate(Math.floor(v.__date));
  return parseDate(v);
};
const num = (v) => {
  if (v && v.__date !== undefined) return v.__date;
  const n = parseAmount(v);
  return n === null ? 0 : n;
};
const boolOf = (v) => (typeof v === 'object' && v ? false : parseBool(v));

/** Read a backup workbook into {data, problems, counts}. Nothing is changed yet. */
export function readBackup(buf) {
  const wb = XLSX.read(buf, { type: 'array', cellDates: false, cellNF: true });
  const problems = [];
  const out = Object.fromEntries(TABLES.map((t) => [t, []]));
  const rawBy = {};
  for (const [name, table, cols] of SHEETS) {
    const sh = wb.Sheets[name];
    if (!sh || !sh['!ref']) { rawBy[table] = []; if (!sh && !OPTIONAL_SHEETS.has(name)) problems.push(`Sheet “${name}” is missing, so it was treated as empty.`); continue; }
    const range = XLSX.utils.decode_range(sh['!ref']);
    const header = [];
    for (let c = 0; c <= range.e.c; c++) header.push(String(cellToValue(sh[XLSX.utils.encode_cell({ r: 0, c })])).trim().toLowerCase());
    const idx = cols.map(([h]) => header.indexOf(h.toLowerCase()));
    const rows = [];
    for (let r = 1; r <= range.e.r; r++) {
      const vals = idx.map((ci) => (ci >= 0 ? cellToValue(sh[XLSX.utils.encode_cell({ r, c: ci })]) : ''));
      if (vals.every((v) => v === '' || v === null)) continue;
      const rec = { _row: r + 1 };
      cols.forEach(([, kind, , key], i) => {
        const v = vals[i];
        if (kind === 'date') rec[key] = dateOf(v);
        else if (kind === 'money' || kind === 'num') rec[key] = num(v);
        else if (kind === 'int') rec[key] = Math.trunc(num(v));
        else if (kind === 'bool') rec[key] = boolOf(v);
        else rec[key] = text(v);
      });
      rows.push(rec);
    }
    rawBy[table] = rows;
  }

  // ---- workspaces
  const wsByName = new Map();
  const addWs = (name, kind = 'personal') => {
    const w = { id: newId(), name, kind, order: wsByName.size, isPreset: false };
    out.workspaces.push(w);
    wsByName.set(name.toLowerCase(), w);
    return w;
  };
  for (const r of rawBy.workspaces) {
    if (!r.name) { problems.push(`Workspaces row ${r._row}: no name, skipped.`); continue; }
    if (wsByName.has(r.name.toLowerCase())) { problems.push(`Workspaces row ${r._row}: “${r.name}” is listed twice, kept the first.`); continue; }
    const w = { id: r.id || newId(), name: r.name, kind: /bus/i.test(r.kind || '') ? 'business' : 'personal', order: r.order, isPreset: r.isPreset };
    out.workspaces.push(w);
    wsByName.set(r.name.toLowerCase(), w);
  }
  const wsId = (name, sheet, row) => {
    if (!name) {
      if (out.workspaces.length === 1) return out.workspaces[0].id;
      problems.push(`${sheet} row ${row}: no workspace named, skipped.`);
      return null;
    }
    const w = wsByName.get(name.toLowerCase()) || addWs(name);
    return w.id;
  };

  // ---- pools first (other sheets point at them by name)
  const poolByKey = new Map();
  for (const r of rawBy.budget_pools) {
    const w = wsId(r.workspace, 'Budget Pools', r._row);
    if (!w || !r.name) continue;
    const mode = ['fixed', 'percent', 'unconnected'].includes((r.fundingMode || '').toLowerCase()) ? r.fundingMode.toLowerCase() : 'fixed';
    const p = {
      id: r.id || newId(), workspaceId: w, name: r.name, icon: r.icon || '💷', color: r.color || '#6366f1',
      isWorkspaceConnected: r.isWorkspaceConnected, fundingMode: r.isWorkspaceConnected ? (mode === 'unconnected' ? 'fixed' : mode) : 'unconnected',
      fundingValue: r.fundingValue, isDefault: r.isDefault, order: r.order, description: r.description,
      // older backups have no budget start: the app then keeps each pool's old budget as its starting money
      funded: r.budgetStart ? r.funded : 0, budgetStart: r.budgetStart || null,
      filledMonth: /^\d{4}-\d{2}$/.test(r.filledMonth || '') ? r.filledMonth : null,
    };
    out.budget_pools.push(p);
    poolByKey.set(`${w}|${p.name.toLowerCase()}`, p);
  }
  const poolsById = new Map(out.budget_pools.map((p) => [p.id, p]));
  const poolId = (w, name) => (name ? (poolByKey.get(`${w}|${name.toLowerCase()}`) || null) : null);

  for (const r of rawBy.bank_accounts) {
    const w = wsId(r.workspace, 'Bank Accounts', r._row);
    if (!w || !r.name) continue;
    out.bank_accounts.push({ id: r.id || newId(), workspaceId: w, name: r.name, initialBalance: r.initialBalance });
  }
  for (const r of rawBy.categories) {
    const w = wsId(r.workspace, 'Categories', r._row);
    if (!w || !r.name) continue;
    const p = poolId(w, r.pool);
    if (r.pool && !p) problems.push(`Categories row ${r._row}: pool “${r.pool}” not found, left unpooled.`);
    out.categories.push({
      id: r.id || newId(), workspaceId: w, name: r.name, defaultType: TX_TYPES.includes(r.defaultType) ? r.defaultType : 'Expense',
      bankAccount: !r.bankAccount || /^all/i.test(r.bankAccount) ? 'ALL' : r.bankAccount, poolId: p ? p.id : null,
      allocated: Math.max(0, r.allocated), color: r.color || '#a1a1aa', isProtected: r.isProtected,
    });
  }
  for (const r of rawBy.transactions) {
    const w = wsId(r.workspace, 'Transactions', r._row);
    if (!w) continue;
    if (!r.date) { problems.push(`Transactions row ${r._row}: no readable date, skipped.`); continue; }
    const type = TX_TYPES.find((t) => t.toLowerCase() === (r.type || '').toLowerCase()) || (r.amount >= 0 ? 'Income' : 'Expense');
    const p = poolId(w, r.pool);
    const bw = r.isBusinessPayment && r.businessWorkspace ? wsByName.get(r.businessWorkspace.toLowerCase()) : null;
    out.transactions.push({
      id: r.id || newId(), workspaceId: w, date: r.date, type, category: r.category || 'Uncategorised',
      bankAccount: r.bankAccount, amount: type === 'Income' ? Math.abs(r.amount) : -Math.abs(r.amount),
      description: r.description, poolId: p ? p.id : null, poolName: p ? p.name : null,
      isBusinessPayment: !!r.isBusinessPayment, businessWorkspaceId: bw ? bw.id : null,
      businessWorkspaceName: r.isBusinessPayment ? (bw ? bw.name : r.businessWorkspace) : null,
      businessCategory: r.businessCategory, dlaNotes: r.dlaNotes, createdAt: r.createdAt || undefined,
    });
  }
  for (const r of rawBy.transfers) {
    const w = wsId(r.workspace, 'Transfers', r._row);
    if (!w) continue;
    if (!r.date || !r.fromAccount || !r.toAccount) { problems.push(`Transfers row ${r._row}: missing date or account, skipped.`); continue; }
    out.transfers.push({
      id: r.id || newId(), workspaceId: w, date: r.date, fromAccount: r.fromAccount, toAccount: r.toAccount,
      amount: Math.abs(r.amount), notes: r.notes, createdAt: r.createdAt || undefined,
    });
  }
  for (const r of rawBy.pool_transfers) {
    const w = wsId(r.workspace, 'Pool Transfers', r._row);
    if (!w) continue;
    const pick = (id, name) => (id && poolsById.has(id) ? id : (poolId(w, name)?.id || null));
    out.pool_transfers.push({
      id: r.id || newId(), workspaceId: w, date: r.date, fromPoolName: r.fromPoolName, toPoolName: r.toPoolName,
      fromPoolId: pick(r.fromPoolId, r.fromPoolName), toPoolId: pick(r.toPoolId, r.toPoolName),
      amount: Math.abs(r.amount), note: r.note, createdAt: r.createdAt || undefined,
    });
  }
  for (const r of rawBy.bills) {
    const w = wsId(r.workspace, 'Bills', r._row);
    if (!w || !r.billName) continue;
    const tm = (r.reminderTime || '').match(/^(\d{1,2})[:.](\d{2})/);
    out.bills.push({
      id: r.id || newId(), workspaceId: w, billName: r.billName, category: r.category, dueDay: Math.max(1, Math.min(31, r.dueDay || 1)),
      amount: Math.abs(r.amount), bankAccount: r.bankAccount, reminderTime: tm ? `${tm[1].padStart(2, '0')}:${tm[2]}` : '09:00',
      reminderEnabled: r.reminderEnabled, notes: r.notes,
      paidMonths: (r.paidMonths || '').split(/[,\s;]+/).filter((m) => /^\d{4}-\d{2}$/.test(m)),
      lastNotifiedKey: r.lastNotifiedKey,
    });
  }
  for (const r of rawBy.budget_goals) {
    const w = wsId(r.workspace, 'Budget Goals', r._row);
    if (!w || !r.category) continue;
    out.budget_goals.push({
      id: r.id || newId(), workspaceId: w, category: r.category, amount: Math.abs(r.amount),
      type: TX_TYPES.includes(r.type) ? r.type : 'Expense',
    });
  }
  for (const r of rawBy.plan_items) {
    const w = wsId(r.workspace, 'Plans', r._row);
    if (!w || !r.name) continue;
    const st = (r.status || '').toLowerCase();
    const tm = String(r.targetMonth || '').match(/^(\d{4})-(\d{1,2})/);
    out.plan_items.push({
      id: r.id || newId(), workspaceId: w, name: r.name, cost: Math.abs(r.cost), extraCost: Math.abs(r.extraCost),
      monthlyCost: Math.abs(r.monthlyCost), status: st.startsWith('bought') ? 'bought' : st.startsWith('sav') ? 'saving' : 'idea',
      targetMonth: tm ? `${tm[1]}-${tm[2].padStart(2, '0')}` : null, notes: r.notes, createdAt: r.createdAt || undefined,
    });
  }
  for (const r of rawBy.plan_notes) {
    const w = wsId(r.workspace, 'Plan Notes', r._row);
    if (!w || (!r.title && !r.body)) continue;
    out.plan_notes.push({ id: r.id || newId(), workspaceId: w, title: r.title, body: r.body, createdAt: r.createdAt || undefined });
  }
  const fcSeen = new Set();
  for (const r of rawBy.forecasts) {
    const w = wsId(r.workspace, 'Forecast', r._row);
    if (!w || fcSeen.has(w)) continue;
    fcSeen.add(w);
    out.forecasts.push({
      id: r.id || newId(), workspaceId: w, useMoneyAtHand: r.useMoneyAtHand, startAmount: r.startAmount, monthlySaving: r.monthlySaving,
      interestRate: r.interestRate, years: Math.max(1, Math.min(40, r.years || 5)), includePlans: r.includePlans,
    });
  }
  // every workspace needs a pool and a default
  for (const w of out.workspaces) {
    const ps = out.budget_pools.filter((p) => p.workspaceId === w.id);
    if (ps.length && !ps.some((p) => p.isDefault)) ps[0].isDefault = true;
  }
  // de-duplicate ids
  for (const t of TABLES) {
    const seen = new Set();
    out[t] = out[t].filter((r) => (seen.has(r.id) ? false : seen.add(r.id)));
    out[t] = out[t].map((r) => clean(t, { ...r, createdAt: r.createdAt || nowIso(), updatedAt: nowIso() }));
  }
  const counts = Object.fromEntries(SHEETS.map(([name, table]) => [name, out[table].length]));
  if (!out.workspaces.length) problems.unshift('No workspaces found: this does not look like an Emperio Finances backup.');
  return { data: out, problems, counts };
}

/** Replace everything in the store with a backup's data. */
export function restoreBackup(store, data) {
  store.replaceAll(data);
  store.commit();
}

/** Compare two data snapshots ignoring timestamps (used by tests and the self-check). */
export function sameData(a, b) {
  const strip = (t, r) => {
    const c = { ...r };
    delete c.updatedAt;
    if (!['transactions', 'transfers', 'pool_transfers', 'plan_items', 'plan_notes'].includes(t)) delete c.createdAt;
    for (const k of Object.keys(SCHEMA[t])) if (typeof c[k] === 'number') c[k] = round2(c[k]);
    return JSON.stringify(c, Object.keys(c).sort());
  };
  for (const t of TABLES) {
    const x = (a[t] || []).map((r) => strip(t, r)).sort();
    const y = (b[t] || []).map((r) => strip(t, r)).sort();
    if (x.length !== y.length) return `${t}: ${x.length} vs ${y.length} rows`;
    for (let i = 0; i < x.length; i++) if (x[i] !== y[i]) return `${t}: ${x[i]} !== ${y[i]}`;
  }
  return true;
}
