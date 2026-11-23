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
const round = (v) => Math.round(v * 100) / 100;
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

  it('zero-based: every pound of money at hand gets assigned to a pool', () => {
    const ws = wsId();
    fin.saveAccount(ws, 'Current Account', 5000, fin.accounts(ws)[0].id);
    const pool = fin.defaultPool(ws);
    let h = fin.header(ws, mk());
    expect(h.toAssign).toBe(5000);
    fin.assign(pool.id, 300);
    h = fin.header(ws, mk());
    expect(h.inPools).toBe(300);
    expect(h.toAssign).toBe(4700);
    expect(() => fin.assign(pool.id, 4700.01)).toThrow(FinanceError);
    fin.assign(pool.id, 4700);
    expect(fin.header(ws, mk()).toAssign).toBe(0);
    fin.assign(pool.id, -200);
    expect(fin.header(ws, mk()).toAssign).toBe(200);
  });

  it('spending comes out of the pool, not out of left to assign; income adds to it', () => {
    const ws = wsId();
    const pool = fin.defaultPool(ws);
    fin.saveTransaction({ workspaceId: ws, date: `${mk()}-01`, type: 'Income', category: 'Salary', bankAccount: 'Current Account', amount: 1000 });
    fin.assign(pool.id, 500);
    fin.saveTransaction({ workspaceId: ws, date: `${mk()}-02`, type: 'Expense', category: 'Groceries', bankAccount: 'Current Account', amount: 120 });
    fin.saveTransaction({ workspaceId: ws, date: '2020-01-05', type: 'Expense', category: 'Groceries', bankAccount: 'Current Account', amount: 30 });
    const m = fin.poolMetrics(ws, mk())[0];
    expect(m.spent).toBe(120);
    expect(m.available).toBe(380);
    expect(fin.poolMetrics(ws, null)[0].spent).toBe(150);
    const h = fin.header(ws, mk());
    expect(h.moneyAtHand).toBe(850);
    expect(h.toAssign).toBe(470); // 850 − 380: the old 2020 spend was before budgeting started
    expect(round(h.inPools + h.toAssign)).toBe(h.moneyAtHand);
  });

  it('fill pools gives each pool its monthly amount once a month', () => {
    const ws = wsId();
    fin.saveAccount(ws, 'Current Account', 1000, fin.accounts(ws)[0].id);
    const a = fin.defaultPool(ws);
    fin.savePool(ws, { id: a.id, name: a.name, fundingValue: 400 });
    const b = fin.savePool(ws, { name: 'Bills', isWorkspaceConnected: true, fundingValue: 800 });
    const r = fin.fillPools(ws);
    expect(r.total).toBe(1000);
    expect(r.short).toEqual(['Bills']);
    const ms = Object.fromEntries(fin.poolMetrics(ws, mk()).map((m) => [m.name, m]));
    expect(ms['Everyday Spending'].available).toBe(400);
    expect(ms.Bills.available).toBe(600);
    expect(fin.header(ws).toAssign).toBe(0);
    expect(fin.fillPools(ws).total).toBe(0);
    expect(b.budgetStart).toBe(`${mk()}-01`);
  });

  it('old pools keep their budget as starting money (no data lost)', () => {
    const ws = wsId();
    const p = fin.defaultPool(ws);
    // what older versions saved: no budgetStart, a % budget and category lines
    fin.db.update('budget_pools', p.id, { budgetStart: null, funded: 0, fundingMode: 'fixed', fundingValue: 300 });
    fin.setCategoryAllocated(fin.categoryByName(ws, 'Groceries').id, 450);
    fin.saveTransaction({ workspaceId: ws, date: `${mk()}-02`, type: 'Expense', category: 'Groceries', bankAccount: 'Current Account', amount: 100 });
    const before = fin.poolMetrics(ws, mk())[0];
    expect(before.available).toBe(350); // old "left to spend": 450 − 100
    expect(fin.migrateBudgets()).toBe(1);
    const after = fin.poolMetrics(ws, mk())[0];
    expect(after.available).toBe(350);
    expect(after.budgetStart).toBe(`${mk()}-01`);
    expect(after.filledThisMonth).toBe(true);
    expect(fin.migrateBudgets()).toBe(0);
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
    fin.saveAccount(ws, 'Current Account', 1000, fin.accounts(ws)[0].id);
    const a = fin.defaultPool(ws);
    const b = fin.savePool(ws, { name: 'Spare', isWorkspaceConnected: true, fundingValue: 200 });
    fin.assign(a.id, 50);
    fin.assign(b.id, 200);
    fin.poolTransfer(ws, b.id, a.id, 20);
    expect(() => fin.poolTransfer(ws, b.id, a.id, 500)).toThrow(FinanceError);
    fin.saveTransaction({ workspaceId: ws, date: `${mk()}-03`, type: 'Expense', category: 'Groceries', bankAccount: 'Current Account', amount: 100 });
    let ms = Object.fromEntries(fin.poolMetrics(ws, mk()).map((m) => [m.name, m]));
    expect(ms['Everyday Spending'].available).toBe(-30);
    expect(fin.header(ws).overspent.map((m) => m.name)).toEqual(['Everyday Spending']);
    expect(fin.coverPool(a.id, b.id)).toBe(30);
    ms = Object.fromEntries(fin.poolMetrics(ws, mk()).map((m) => [m.name, m]));
    expect(ms['Everyday Spending'].available).toBe(0);
    expect(ms.Spare.available).toBe(150);
    expect(() => fin.deletePool(a.id, null)).toThrow(FinanceError);
    const left = fin.header(ws).toAssign;
    fin.deletePool(b.id, a.id);
    expect(fin.poolMetrics(ws, mk())[0].available).toBe(150);
    expect(fin.header(ws).toAssign).toBe(left);
    expect(fin.categoryByName(ws, 'Groceries').poolId).toBe(a.id);
    expect(fin.defaultPool(ws).id).toBe(a.id);
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

describe('importer: any spreadsheet', () => {
  const tx = (rows) => rows.filter((r) => r.section === 'transactions').map((r) => [r.data.date, r.data.type, r.data.amount]);
  const aoaBook = (sheets, bookType = 'xlsx') => {
    const wb = XLSX.utils.book_new();
    for (const [n, aoa, opts] of sheets) XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(aoa, opts), n);
    return XLSX.write(wb, { type: 'array', bookType });
  };

  it('loose dates and amounts', () => {
    const d = { '1-Nov-26': '2026-11-01', 'Nov 1, 2026': '2026-11-01', 'November 1 2026': '2026-11-01', '1st November 2026': '2026-11-01',
      'Mon 3 Nov 2026': '2026-11-03', '2026-11-01T10:20:30Z': '2026-11-01', '2026.11.01': '2026-11-01', '03/11/2026 14:05:00': '2026-11-03',
      '25/11/2026 2:05 PM': '2026-11-25', '11/25/2026': '2026-11-25', '03.11.26': '2026-11-03', '3 Sept 2026': '2026-09-03', '20261101': '2026-11-01' };
    for (const [k, v] of Object.entries(d)) expect(parseDate(k), k).toBe(v);
    for (const bad of ['foo', '12.50', '31/31/2026', '']) expect(parseDate(bad), bad).toBeNull();
    const a = { 'GBP 12.50': 12.5, '−5.00': -5, '5.00-': -5, '£-5': -5, '-£5': -5, '+3.20': 3.2, '12.50 CR': 12.5, '12.50DR': -12.5, '€1,234.56': 1234.56, '(4.00)': -4 };
    for (const [k, v] of Object.entries(a)) expect(parseAmount(k), k).toBe(v);
    expect(parseAmount('abc')).toBeNull();
  });

  it('UK bank and card export layouts', () => {
    const ws = wsId();
    const cases = {
      starling: [['Date', 'Counter Party', 'Reference', 'Type', 'Amount (GBP)', 'Balance (GBP)', 'Spending Category', 'Notes'],
        ['01/11/2026', 'Tesco', 'TESCO STORES', 'CONTACTLESS', '-12.40', '87.60', 'GROCERIES', ''],
        ['02/11/2026', 'Client', 'INV 4', 'FASTER PAYMENT', '250.00', '337.60', 'INCOME', '']],
      revolut: [['Type', 'Product', 'Started Date', 'Completed Date', 'Description', 'Amount', 'Fee', 'Currency', 'State', 'Balance'],
        ['CARD_PAYMENT', 'Current', '2026-11-01 10:20:30', '2026-11-02 08:00:00', 'Pret', '-4.50', '0.00', 'GBP', 'COMPLETED', '95.50'],
        ['TOPUP', 'Current', '2026-11-03 09:00:00', '2026-11-03 09:00:01', 'Top-up', '100.00', '0.00', 'GBP', 'COMPLETED', '195.50']],
      barclays: [['Number', 'Date', 'Account', 'Amount', 'Subcategory', 'Memo'],
        ['', '01/11/2026', '20-00-00 12345678', '-30.00', 'Direct Debit', 'GYM'],
        ['', '02/11/2026', '20-00-00 12345678', '1500.00', 'Credit', 'SALARY']],
      hsbc: [['01 Nov 2026', 'AMAZON MARKETPLACE', '-19.99'], ['02 Nov 2026', 'PAYROLL', '1,200.00']],
      nationwide: [['Account Name:', 'FlexAccount ****1234'], ['Account Balance:', '£1,000.00'], ['Available Balance: ', '£1,000.00'], [],
        ['Date', 'Transaction type', 'Description', 'Paid out', 'Paid in', 'Balance'],
        ['01 Nov 2026', 'Contactless Payment', 'COSTA', '£3.10', '', '£996.90'],
        ['02 Nov 2026', 'Bank credit', 'WAGES', '', '£800.00', '£1,796.90']],
      lloyds: [['Transaction Date', 'Transaction Type', 'Sort Code', 'Account Number', 'Transaction Description', 'Debit Amount', 'Credit Amount', 'Balance'],
        ['01/11/2026', 'DEB', "'30-00-00", '12345678', 'SAINSBURYS', '22.15', '', '977.85'],
        ['02/11/2026', 'FPI', "'30-00-00", '12345678', 'REFUND', '', '10.00', '987.85']],
    };
    const want = {
      starling: [['2026-11-01', 'Expense', 12.4], ['2026-11-02', 'Income', 250]],
      revolut: [['2026-11-01', 'Expense', 4.5], ['2026-11-03', 'Income', 100]],
      barclays: [['2026-11-01', 'Expense', 30], ['2026-11-02', 'Income', 1500]],
      hsbc: [['2026-11-01', 'Expense', 19.99], ['2026-11-02', 'Income', 1200]],
      nationwide: [['2026-11-01', 'Expense', 3.1], ['2026-11-02', 'Income', 800]],
      lloyds: [['2026-11-01', 'Expense', 22.15], ['2026-11-02', 'Income', 10]],
    };
    for (const [k, rows] of Object.entries(cases)) expect(tx(parse(ws, `${k}.csv`, csvBuf(rows))), k).toEqual(want[k]);
    // Amex-style card export: spending positive. The "swap" option flips it.
    const [tables] = imp.detectFile('amex.csv', csvBuf([['Date', 'Description', 'Amount'], ['01/11/2026', 'HOTEL', '120.00'], ['02/11/2026', 'PAYMENT RECEIVED', '-120.00']]));
    expect(tx(imp.buildRows(fin, ws, tables)).map((r) => r[1])).toEqual(['Income', 'Expense']);
    tables[0].flip = true;
    expect(tx(imp.buildRows(fin, ws, tables))).toEqual([['2026-11-01', 'Expense', 120], ['2026-11-02', 'Income', 120]]);
  });

  it('every workbook format, odd extensions and real date cells', () => {
    const ws = wsId();
    const aoa = [['Statement for Nov'], [], ['Date', 'Description', 'Amount'],
      [new Date(Date.UTC(2026, 10, 1)), 'Lunch', -9.5], [new Date(Date.UTC(2026, 10, 2)), 'Wages', 500]];
    const want = [['2026-11-01', 'Expense', 9.5], ['2026-11-02', 'Income', 500]];
    for (const bt of ['xlsx', 'xlsb', 'xls', 'biff8', 'ods', 'fods', 'html']) {
      // (an HTML "spreadsheet" only ever holds one sheet)
      const buf = aoaBook(bt === 'html' ? [['Nov', aoa, { cellDates: true }]] : [['Notes', [['nothing here']]], ['Nov', aoa, { cellDates: true }]], bt);
      expect(tx(parse(ws, `f.${bt}`, buf)), bt).toEqual(want);
      expect(tx(parse(ws, 'no-extension', buf)), `${bt} without extension`).toEqual(want);
      expect(tx(parse(ws, 'wrong.csv', buf)), `${bt} named .csv`).toEqual(want);
    }
    // CSV named .xls (common bank download), tab and semicolon separated, Windows-1252 £
    const csvText = 'Date;Description;Amount\n01/11/2026;Caf\xe9;\xa3-3,20\n';
    expect(parse(ws, 'x.xls', new Uint8Array([...csvText].map((c) => c.charCodeAt(0))).buffer).map((r) => r.data.description)).toEqual(['Café']);
    expect(tx(parse(ws, 'x.tsv', new TextEncoder().encode('Date\tDescription\tAmount\n01/11/2026\tBus\t-2.00\n').buffer))).toEqual([['2026-11-01', 'Expense', 2]]);
  });

  it('several tables and sheets, junk rows and a huge used range', () => {
    const ws = wsId();
    const sheet = XLSX.utils.aoa_to_sheet([['Date', 'Description', 'Amount'], ['01/11/2026', 'A', '-1.00'], ['', 'Total', '-1.00'], [], [],
      ['Bills'], ['Bill', 'Due day', 'Amount'], ['Rent', '1', '900']]);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, sheet, 'Mixed');
    const rows = parse(ws, 'mixed.xlsx', XLSX.write(wb, { type: 'array', bookType: 'xlsx' }));
    // Excel sometimes reports a used range far bigger than the data: only real cells are read
    sheet['!ref'] = 'A1:XFD1048576';
    const t0 = Date.now();
    expect(imp.sheetRows(sheet)).toHaveLength(8);
    expect(Date.now() - t0).toBeLessThan(500);
    expect(tx(rows)).toEqual([['2026-11-01', 'Expense', 1]]);
    expect(rows.filter((r) => r.section === 'bills').map((r) => r.data.billName)).toEqual(['Rent']);
  });

  it('20,000 rows import quickly', () => {
    const ws = wsId();
    const aoa = [['Date', 'Description', 'Category', 'Amount']];
    for (let i = 0; i < 20000; i++) aoa.push([`${(i % 28) + 1}/10/2026`, `Item ${i}`, `Cat ${i % 30}`, (-(i % 50) - 1).toFixed(2)]);
    const t0 = Date.now();
    const rows = parse(ws, 'big.xlsx', aoaBook([['Big', aoa]]));
    expect(rows).toHaveLength(20000);
    imp.importRows(fin, ws, rows);
    expect(fin.transactions(ws)).toHaveLength(20000);
    expect(Date.now() - t0).toBeLessThan(20000);
  }, 60000);
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
    expect(f2.header(ws).toAssign).toBe(fin.header(ws).toAssign);
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
