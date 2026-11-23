// Core logic tests (no browser). Run: npm test
import fs from 'node:fs';
import { describe, expect, it, beforeEach } from 'vitest';
import * as XLSXns from 'xlsx';
import { Store } from '../src/lib/store.js';
import { Finance, FinanceError } from '../src/lib/finance.js';
import * as imp from '../src/lib/importer.js';
import { backupBytes, readBackup, restoreBackup, sameData, isBackup } from '../src/lib/backup.js';
import { loadDemo } from '../src/lib/demo.js';
import { fmtMoney, monthKey, ordinal, parseAmount, parseDate, setNow } from '../src/lib/util.js';

const XLSX = XLSXns.utils ? XLSXns : XLSXns.default;
let fin;
const wsId = (name = 'Personal') => fin.workspaces().find((w) => w.name === name).id;
const mk = () => monthKey();
const csvBuf = (rows) => new TextEncoder().encode(rows.map((r) => r.map((c) => (/[",\n]/.test(c) ? `"${c.replace(/"/g, '""')}"` : c)).join(',')).join('\n')).buffer;
const parse = (ws, name, buf) => imp.buildRows(fin, ws, imp.detectFile(name, buf)[0]);
const xlsxBuf = (wb) => XLSX.write(wb, { type: 'array', bookType: 'xlsx' });

beforeEach(() => {
  setNow(null);
  fin = new Finance(new Store());
  fin.ensureSeeded();
});

describe('money rules (same as desktop)', () => {
  it('presets and protected categories', () => {
    expect(fin.workspaces().map((w) => w.name)).toEqual(['Personal', 'Scrumbb', 'Clean and Serve']);
    const ws = wsId();
    const prot = new Set(fin.categories(ws).filter((c) => c.isProtected).map((c) => c.name));
    expect([...prot].sort()).toEqual(['Groceries', 'Insurance', 'Rent', 'Utilities']);
    const blocked = fin.deleteCategories(fin.categories(ws).map((c) => c.id));
    expect(new Set(blocked)).toEqual(prot);
  });

  it('balance formula; transfers do not change the total', () => {
    const ws = wsId();
    fin.saveAccount(ws, 'Savings', 100);
    fin.saveTransaction({ workspaceId: ws, date: '2026-11-01', type: 'Income', category: 'Salary', bankAccount: 'Current Account', amount: 1000 });
    fin.saveTransaction({ workspaceId: ws, date: '2026-11-02', type: 'Expense', category: 'Groceries', bankAccount: 'Current Account', amount: 40 });
    fin.saveTransfer({ workspaceId: ws, date: '2026-11-03', fromAccount: 'Current Account', toAccount: 'Savings', amount: 200 });
    const s = Object.fromEntries(fin.accountSummaries(ws).map((a) => [a.name, a]));
    expect(s['Current Account'].balance).toBeCloseTo(760);
    expect(s.Savings.balance).toBeCloseTo(300);
    expect(fin.moneyAtHand(ws)).toBeCloseTo(1060);
  });

  it('pool budget is explicit, never auto-filled', () => {
    const ws = wsId();
    fin.saveAccount(ws, 'Current Account', 5000, fin.accounts(ws)[0].id);
    let m = fin.poolMetrics(ws, mk())[0];
    expect(m.allocatedBudget).toBe(0);
    fin.pushFunds(m.id, 300);
    fin.setCategoryAllocated(fin.categoryByName(ws, 'Groceries').id, 450);
    m = fin.poolMetrics(ws, mk())[0];
    expect(m.allocatedBudget).toBe(450);
    expect(m.unassigned).toBe(0);
    const h = fin.header(ws, mk());
    expect(h.assigned).toBe(450);
    expect(h.unpooled).toBe(4550);
  });

  it('left to spend counts down and is month scoped', () => {
    const ws = wsId();
    fin.setPoolBudget(fin.defaultPool(ws).id, 500);
    fin.saveTransaction({ workspaceId: ws, date: `${mk()}-01`, type: 'Expense', category: 'Groceries', bankAccount: 'Current Account', amount: 120 });
    fin.saveTransaction({ workspaceId: ws, date: '2020-01-05', type: 'Expense', category: 'Groceries', bankAccount: 'Current Account', amount: 30 });
    const m = fin.poolMetrics(ws, mk())[0];
    expect(m.spent).toBe(120);
    expect(m.leftToSpend).toBe(380);
    expect(fin.poolMetrics(ws, null)[0].spent).toBe(150);
  });

  it('moving a category moves its spending', () => {
    const ws = wsId();
    const p2 = fin.savePool(ws, { name: 'Home', isWorkspaceConnected: true, fundingMode: 'fixed', fundingValue: 0 });
    fin.saveTransaction({ workspaceId: ws, date: `${mk()}-02`, type: 'Bills', category: 'Rent', bankAccount: 'Current Account', amount: 900 });
    fin.setCategoryPool(fin.categoryByName(ws, 'Rent').id, p2.id);
    const ms = Object.fromEntries(fin.poolMetrics(ws, mk()).map((m) => [m.name, m]));
    expect(ms.Home.spent).toBe(900);
    expect(ms['Everyday Spending'].spent).toBe(0);
    expect(fin.transactions(ws)[0].poolName).toBe('Home');
  });

  it('pool transfer, cover overspend and delete pool', () => {
    const ws = wsId();
    const a = fin.defaultPool(ws);
    const b = fin.savePool(ws, { name: 'Spare', isWorkspaceConnected: true, fundingMode: 'fixed', fundingValue: 200 });
    const groc = fin.categoryByName(ws, 'Groceries');
    fin.setCategoryAllocated(groc.id, 50);
    fin.saveTransaction({ workspaceId: ws, date: `${mk()}-03`, type: 'Expense', category: 'Groceries', bankAccount: 'Current Account', amount: 80 });
    expect(fin.coverOverspend(groc.id, 'pool', b.id, mk())).toBe(30);
    const line = fin.poolMetrics(ws, mk())[0].lines.find((l) => l.name === 'Groceries');
    expect(line.remaining).toBe(0);
    expect(() => fin.deletePool(a.id, null)).toThrow(FinanceError);
    fin.deletePool(a.id, b.id);
    expect(fin.categoryByName(ws, 'Groceries').poolId).toBe(b.id);
    expect(fin.defaultPool(ws).id).toBe(b.id);
  });

  it('bill status and reminders', () => {
    const ws = wsId();
    const b = fin.saveBill(ws, { billName: 'Rent', category: 'Rent', dueDay: 31, amount: 900, bankAccount: 'Current Account', reminderTime: '09:00', reminderEnabled: true });
    const st = fin.billStatus(b, '2026-02-10');
    expect(st.dueDate).toBe('2026-02-28');
    expect(st.dueLabel).toBe('31st');
    setNow('2026-02-28T08:00:00Z');
    expect(fin.billsToNotify()).toHaveLength(0);
    setNow('2026-02-28T09:05:00Z');
    const hits = fin.billsToNotify();
    expect(hits).toHaveLength(1);
    fin.markNotified(b.id, hits[0].notifyKey);
    expect(fin.billsToNotify()).toHaveLength(0);
  });

  it('DLA balance', () => {
    const ws = wsId(), biz = wsId('Scrumbb');
    fin.saveTransaction({ workspaceId: ws, date: '2026-11-01', type: 'Expense', category: 'Biz', bankAccount: 'Current Account', amount: 100, isBusinessPayment: true, businessWorkspaceId: biz });
    fin.saveTransaction({ workspaceId: ws, date: '2026-11-02', type: 'Income', category: 'DLA Repayment', bankAccount: 'Current Account', amount: 40, isBusinessPayment: true, businessWorkspaceId: biz });
    expect(fin.dlaBalance()).toBe(60);
    expect(fin.dlaBalance(wsId('Clean and Serve'))).toBe(0);
  });

  it('formatting and parsing', () => {
    expect(fmtMoney(1234.5)).toBe('£1,234.50');
    expect(fmtMoney(-0.001)).toBe('£0.00');
    expect(fmtMoney(-12)).toBe('-£12.00');
    expect([ordinal(1), ordinal(12), ordinal(22)]).toEqual(['1st', '12th', '22nd']);
    expect(parseDate('05/03/2026')).toBe('2026-03-05');
    expect(parseDate('31/02/2026')).toBe(null);
    expect(parseAmount('(£1,200.50)')).toBe(-1200.5);
  });
});

describe('importer (same cases as desktop)', () => {
  it('multi-section CSV', () => {
    const ws = wsId();
    const buf = csvBuf([
      ['Account Balances'], ['Account', 'Balance'], ['Current Account', '1500'], ['Amex', '-200'], [],
      ['Transactions'], ['Date', 'Type', 'Category', 'Account', 'Amount', 'Description'],
      ['01/11/2026', 'Expense', 'Groceries', 'Current Account', '45.20', 'Tesco'],
      ['01/11/2026', 'Expense', 'Groceries', 'Current Account', '45.20', 'Tesco'],
      ['02/11/2026', '', 'Coffee', 'Amex', '-3.10', 'Pret'],
      ['bad', 'Expense', 'X', 'Current Account', '1', 'broken'], [],
      ['Account Transfers'], ['Date', 'From', 'To', 'Amount', 'Notes'],
      ['03/11/2026', 'Current Account', 'Amex', '100', 'pay card'], [],
      ['Budget Goals'], ['Category', 'Amount', 'Type'], ['Groceries', '400', 'Expense'], [],
      ['Bill Due Dates'], ['Bill', 'Category', 'Due Day', 'Amount', 'Account', 'Reminder Time'],
      ['Netflix', 'Subscriptions', '14', '10.99', 'Amex', '18:00'],
    ]);
    const rows = parse(ws, 'in.csv', buf);
    const by = (s) => rows.filter((r) => r.section === s);
    expect(by('balances')).toHaveLength(2);
    expect(by('transactions').map((r) => r.status)).toEqual(['new', 'new', 'review', 'error']);
    const c = imp.importRows(fin, ws, rows);
    expect([c.transactions, c.transfers, c.bills, c.goals, c.balances]).toEqual([3, 1, 1, 1, 2]);
    const again = parse(ws, 'in.csv', buf);
    expect(again.filter((r) => ['transactions', 'transfers', 'bills'].includes(r.section)).every((r) => ['duplicate', 'error'].includes(r.status))).toBe(true);
  });

  it('month banners, subtotals and summary blocks (FitChic layout)', () => {
    const ws = wsId();
    const wb = XLSX.utils.book_new();
    const add = (name, aoa) => XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(aoa), name);
    add('Workspace Overview', [['Property', 'Value'], ['Workspace Name', 'FitChic']]);
    add('Transactions Log', [
      ['Date', 'Type', 'Category', 'Budget Pool', 'Bank Account', 'Amount (£)', 'Description / Notes'],
      ['📅 August 2026'],
      ['2026-08-30', 'Income', 'Leeway POS', 'Main Pool', 'Monzo Business Account', 3037.66, ''],
      ['Subtotal (August 2026): Income £3037.66', null, null, null, 'Month Net:', 3037.66, ''],
      ['📅 September 2026'],
      ['2026-09-01', 'Expense', 'Directors Drawing', 'Main Pool', 'Monzo Business Account', -20, ''],
      ['2026-09-01', 'Expense', 'Directors Drawing', 'Main Pool', 'Monzo Business Account', -20, ''],
      ['2026-09-01', 'Expense', 'Groceries (H)', '💰 Home', 'Cash', -17.6, 'Greggs'],
      [], ['--- OVERALL SUMMARY ---'], ['Total Income', '', '', '', 3037.66],
    ]);
    add('Recurring Bills Due', [['Bill / Vendor Name', 'Due Day of Month', 'Target Amount (£)', 'Bank Account'], ['Microsoft', 'Day 2', 10.49, 'Default']]);
    add("Director's Accounts (DLA)", [
      ['Date', 'Personal Account', 'Target Business Account', 'Business Expense Category', 'DLA Amount (£)', 'Description', 'DLA / Reimbursement Notes'],
      ['2026-10-18', 'King Monzo', 'Clean and Serve', 'Marketing', 87.9, 'GoHighLevel', 'on behalf'],
      ['TOTAL DLA INPUTS', '', '', '', 87.9, 'Total', ''],
    ]);
    add('Pool Budget Lines', [['Budget Pool', 'Category', 'Transaction Type', 'Allocated (£)', 'Spent (£)'], ['Main Pool', 'Fuel', 'Expenses', 100, 47]]);
    const [tables, meta] = imp.detectFile('by.xlsx', xlsxBuf(wb));
    expect(meta.workspaceName).toBe('FitChic');
    const secs = Object.fromEntries(tables.map((t) => [t.sheet, t.section]));
    expect(secs['Transactions Log']).toBe('transactions');
    expect(secs["Director's Accounts (DLA)"]).toBe('dla');
    expect(secs['Recurring Bills Due']).toBe('bills');
    expect(secs['Pool Budget Lines']).toBe('pool_lines');
    const rows = imp.buildRows(fin, ws, tables);
    const tx = rows.filter((r) => r.section === 'transactions');
    expect(tx).toHaveLength(4);
    expect(tx.every((r) => r.status === 'new')).toBe(true);
    const c = imp.importRows(fin, ws, rows);
    expect([c.transactions, c.dla, c.bills]).toEqual([4, 1, 1]);
    const sum = fin.transactions(ws).filter((t) => !t.isBusinessPayment).reduce((s, t) => s + t.amount, 0);
    expect(Math.round(sum * 100) / 100).toBe(2980.06);
    expect(fin.bills(ws)[0].dueDay).toBe(2);
    expect(fin.dlaBalance(wsId('Clean and Serve'))).toBe(87.9);
    const pools = new Set(fin.pools(ws).map((p) => p.name));
    expect(pools.has('Main Pool') && pools.has('Home')).toBe(true);
    expect(fin.categoryByName(ws, 'Fuel').allocated).toBe(100);
  });

  it('bank statement formats', () => {
    const ws = wsId();
    let rows = parse(ws, 'monzo.csv', csvBuf([
      ['Transaction ID', 'Date', 'Time', 'Type', 'Name', 'Category', 'Amount', 'Currency', 'Money Out', 'Money In'],
      ['tx_1', '05/11/2026', '09:00', 'Faster payment', 'Client Ltd', 'Income', '250.00', 'GBP', '', '250.00'],
      ['tx_2', '06/11/2026', '10:00', 'Card payment', 'Tesco', 'Groceries', '-12.40', 'GBP', '-12.40', ''],
    ]));
    expect(rows.map((r) => [r.data.type, r.data.amount])).toEqual([['Income', 250], ['Expense', 12.4]]);
    rows = parse(ws, 'bank.csv', csvBuf([
      ['My Bank plc statement'], ['Account: 12345678'], [],
      ['Posting Date', 'Details', 'Paid out', 'Paid in', 'Balance'],
      ['2026-11-01', 'RENT', '900.00', '', '100.00'],
      ['2026-11-02', 'SALARY', '', '2,000.00', '2100.00'],
    ]));
    expect(rows.map((r) => [r.data.type, r.data.amount, r.data.description])).toEqual([['Expense', 900, 'RENT'], ['Income', 2000, 'SALARY']]);
    rows = parse(ws, 'raw.csv', csvBuf([
      ['01/11/2026', 'COFFEE SHOP LONDON', '-3.20'], ['02/11/2026', 'TFL TRAVEL CHARGE', '-7.10'], ['03/11/2026', 'REFUND AMAZON', '15.00'],
    ]));
    expect(rows).toHaveLength(3);
    expect(rows[0].data.description).toBe('COFFEE SHOP LONDON');
    expect(rows[2].data.type).toBe('Income');
  });

  it('a table can be re-mapped by hand', () => {
    const ws = wsId();
    const [tables] = imp.detectFile('odd.csv', csvBuf([['When', 'What', 'How much'], ['2026-11-01', 'Lunch', '-9.50'], ['2026-11-02', 'Bus', '-2.00']]));
    expect(tables[0].section).toBe('transactions');
    tables[0].mapping = { date: 0, description: 1, amount: 2 };
    expect(imp.buildRows(fin, ws, tables).map((r) => r.data.amount)).toEqual([9.5, 2]);
  });

  const UP = '/mnt/project-files/uploads/hearth/';
  const real = ['6163b2b1-b232-4e4d-915a-54bd15206176', 'f3e8926b-8032-4285-913e-9f43c823a41e'].map((f) => UP + f);
  it.skipIf(!real.every((f) => fs.existsSync(f)))('real FitChic files', () => {
    const ws = fin.createWorkspace('FitChic', 'business').id;
    const b = (f) => { const x = fs.readFileSync(f); return x.buffer.slice(x.byteOffset, x.byteOffset + x.byteLength); };
    imp.importRows(fin, ws, parse(ws, 'a.xlsx', b(real[0])));
    expect(fin.transactions(ws)).toHaveLength(212);
    expect(Math.round(fin.transactions(ws).reduce((s, t) => s + t.amount, 0) * 100) / 100).toBe(5012.58);
    const second = parse(ws, 'b.xlsx', b(real[1]));
    expect(second.filter((r) => r.section === 'transactions' && r.status !== 'duplicate')).toHaveLength(0);
  });
});

describe('Excel backup', () => {
  it('round-trips everything exactly into a fresh app', () => {
    loadDemo(fin);
    const ws = wsId();
    fin.pushFunds(fin.defaultPool(ws).id, 25);
    fin.categoryTransfer(fin.categoryByName(ws, 'Groceries').id, fin.categoryByName(ws, 'Transport').id, 10);
    const before = fin.db.snapshot();
    const bytes = backupBytes(fin.db);
    expect(isBackup(bytes)).toBe(true);
    const { data, problems } = readBackup(bytes);
    expect(problems).toEqual([]);
    const fresh = new Store();
    restoreBackup(fresh, data);
    expect(sameData(before, fresh.snapshot())).toBe(true);
    const f2 = new Finance(fresh);
    expect(f2.moneyAtHand(ws)).toBe(fin.moneyAtHand(ws));
    expect(JSON.stringify(f2.poolMetrics(ws, mk()).map((m) => [m.name, m.leftToSpend, m.lines.length])))
      .toBe(JSON.stringify(fin.poolMetrics(ws, mk()).map((m) => [m.name, m.leftToSpend, m.lines.length])));
    expect(f2.dlaBalance()).toBe(fin.dlaBalance());
  });

  it('accepts rows added by hand in Excel (no IDs, text dates)', () => {
    const wb = XLSX.read(backupBytes(fin.db), { type: 'array' });
    XLSX.utils.sheet_add_aoa(wb.Sheets.Transactions, [['', 'Personal', '14/11/2026', 'Expense', 'Groceries', 'Current Account', 12.5, 'Added in Excel']], { origin: -1 });
    XLSX.utils.sheet_add_aoa(wb.Sheets['Bank Accounts'], [['', 'Scrumbb', 'Tide', 99]], { origin: -1 });
    const { data, problems } = readBackup(xlsxBuf(wb));
    expect(problems).toEqual([]);
    const s = new Store(); restoreBackup(s, data);
    const f2 = new Finance(s);
    const t = f2.transactions(f2.workspaces()[0].id)[0];
    expect([t.date, t.amount, t.poolName]).toEqual(['2026-11-14', -12.5, null]);
    expect(f2.accountNames(f2.workspaces().find((w) => w.name === 'Scrumbb').id)).toContain('Tide');
  });

  it('a backup of the FitChic import round-trips', () => {
    const f = '/mnt/project-files/uploads/hearth/6163b2b1-b232-4e4d-915a-54bd15206176';
    if (!fs.existsSync(f)) return;
    const ws = fin.createWorkspace('FitChic', 'business').id;
    const x = fs.readFileSync(f);
    imp.importRows(fin, ws, parse(ws, 'a.xlsx', x.buffer.slice(x.byteOffset, x.byteOffset + x.byteLength)));
    const before = fin.db.snapshot();
    const { data } = readBackup(backupBytes(fin.db));
    const s = new Store(); restoreBackup(s, data);
    expect(sameData(before, s.snapshot())).toBe(true);
  });
});
