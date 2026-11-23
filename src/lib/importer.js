// Smart CSV / Excel importer. A port of the desktop app's importer.py.
//
// Works out what each part of a spreadsheet is, wherever it sits: every sheet is scanned for header
// rows anywhere on the page (titles, month banners, subtotals and totals are skipped), each table is
// classified from section titles, the sheet name and its column headers, and columns are matched by
// fuzzy header names or by sniffing cell contents. Rows are only rejected when they genuinely lack a
// date or amount; anything guessed is shown as "Review" but still imported.

import * as XLSXns from 'xlsx';

const XLSX = XLSXns.SSF ? XLSXns : XLSXns.default;
import { TX_TYPES, XDate, addDays, parseAmount, parseBool, parseDate } from './util.js';

export const SECTION_TITLES = {
  transactions: 'Transactions', transfers: 'Account Transfers', balances: 'Account Balances',
  goals: 'Budget Goals', bills: 'Bill Due Dates', dla: "Director's Loan (DLA)",
  pools: 'Budget Pools', pool_lines: 'Pool Budget Lines', pool_transfers: 'Pool Transfers', skip: "Don't import",
};
export const IMPORT_ORDER = ['balances', 'pools', 'pool_lines', 'goals', 'transactions', 'transfers', 'dla', 'bills', 'pool_transfers'];

const SECTION_NAME_RULES = [
  ['skip', ['overview', 'summary', 'dashboard', 'readme', 'instructions', 'about']],
  ['dla', ['director', 'dla', 'loan account']],
  ['pool_lines', ['budget line', 'pool line', 'category line', 'allocation']],
  ['pool_transfers', ['pool transfer']],
  ['pools', ['budget pool', 'pools']],
  ['transfers', ['transfer']],
  ['bills', ['bill', 'recurring', 'due date', 'subscription']],
  ['goals', ['goal', 'target']],
  ['balances', ['balance', 'accounts']],
  ['transactions', ['transaction', 'ledger', 'statement', 'log', 'spending', 'income', 'expenses', 'activity', 'history']],
];

export const FIELDS = {
  transactions: {
    date: ['date', 'transaction date', 'posted', 'posting date', 'value date', 'completed date', 'started date', 'booking date', 'created', 'day'],
    moneyIn: ['money in', 'paid in', 'credit', 'credit amount', 'credits', 'deposit', 'deposits', 'in'],
    moneyOut: ['money out', 'paid out', 'debit', 'debit amount', 'debits', 'withdrawal', 'withdrawals', 'out'],
    amount: ['amount', 'value', 'net amount', 'transaction amount', 'total', 'sum', 'gbp', 'price', 'cost'],
    type: ['type', 'transaction type', 'kind', 'direction'],
    category: ['category', 'category name', 'cat', 'budget category', 'subcategory', 'spending category'],
    pool: ['budget pool', 'pool', 'pool name'],
    bankAccount: ['bank account', 'account', 'account name', 'bank', 'card', 'source account'],
    description: ['description', 'details', 'memo', 'narrative', 'reference', 'payee', 'merchant', 'counter party',
      'description notes', 'name', 'transaction description', 'counterparty'],
    notes: ['notes', 'note', 'comment', 'comments'],
    isBusinessPayment: ['business payment', 'dla', 'is business payment', 'business expense'],
    businessWorkspace: ['business workspace', 'target business', 'target business account', 'company'],
    businessCategory: ['business category', 'business expense category'],
  },
  transfers: {
    date: ['date', 'transfer date'],
    fromAccount: ['from account', 'from', 'source', 'source account'],
    toAccount: ['to account', 'to', 'destination', 'destination account'],
    amount: ['amount', 'value', 'total'],
    notes: ['notes', 'note', 'description', 'reference', 'memo'],
  },
  balances: {
    name: ['account name', 'account', 'bank account', 'name', 'bank'],
    balance: ['balance', 'initial balance', 'opening balance', 'current balance', 'starting balance', 'amount'],
  },
  goals: {
    category: ['category name', 'category', 'goal', 'name'],
    amount: ['monthly target', 'target', 'goal amount', 'amount', 'budget', 'limit'],
    type: ['category type', 'type', 'transaction type'],
  },
  bills: {
    billName: ['bill name', 'bill', 'bill vendor name', 'vendor', 'name', 'payee', 'description'],
    dueDay: ['due day', 'due day of month', 'due', 'day', 'due date', 'day of month'],
    amount: ['amount', 'target amount', 'value', 'cost'],
    category: ['category'],
    bankAccount: ['bank account', 'account'],
    reminderTime: ['reminder time', 'reminder', 'time'],
    notes: ['notes', 'note'],
  },
  dla: {
    date: ['date'],
    bankAccount: ['personal account', 'paid from', 'account', 'bank account'],
    businessWorkspace: ['target business account', 'target business', 'business', 'company', 'business workspace'],
    businessCategory: ['business expense category', 'business category', 'category'],
    amount: ['dla amount', 'amount', 'value', 'dla effect', 'owed to director'],
    description: ['description', 'details', 'memo'],
    notes: ['dla reimbursement notes', 'dla notes', 'notes', 'reimbursement notes'],
  },
  pools: {
    name: ['pool name', 'pool', 'name'],
    mode: ['funding mode', 'mode'],
    target: ['funding target', 'target', 'funding value'],
    allocated: ['allocated', 'allocated budget', 'pool balance', 'budget'],
    isDefault: ['default pool', 'default', 'is default'],
    description: ['description', 'notes'],
  },
  pool_lines: {
    pool: ['budget pool', 'pool', 'pool name'],
    category: ['category', 'category name', 'line'],
    type: ['transaction type', 'type', 'default type'],
    allocated: ['allocated', 'allocated budget', 'budget', 'budgeted'],
  },
  pool_transfers: {
    date: ['date'],
    fromPool: ['from pool', 'from'],
    toPool: ['to pool', 'to'],
    amount: ['amount', 'value'],
    note: ['note reason', 'note', 'reason', 'notes'],
  },
};
export const FIELD_LABELS = {
  date: 'Date', moneyIn: 'Money in', moneyOut: 'Money out', amount: 'Amount', type: 'Type', category: 'Category',
  pool: 'Budget pool', bankAccount: 'Bank account', description: 'Description', notes: 'Notes',
  isBusinessPayment: 'Business payment (DLA)', businessWorkspace: 'Business', businessCategory: 'Business category',
  fromAccount: 'From account', toAccount: 'To account', name: 'Name', balance: 'Balance', billName: 'Bill name',
  dueDay: 'Due day', reminderTime: 'Reminder time', mode: 'Funding mode', target: 'Funding target',
  allocated: 'Allocated', isDefault: 'Default pool', fromPool: 'From pool', toPool: 'To pool', note: 'Note',
};
const REQUIRED = {
  transactions: [['date'], ['amount', 'moneyIn', 'moneyOut']],
  transfers: [['fromAccount'], ['toAccount'], ['amount']],
  balances: [['name'], ['balance']],
  goals: [['category'], ['amount']],
  bills: [['billName'], ['dueDay']],
  dla: [['amount'], ['businessWorkspace']],
  pools: [['name']],
  pool_lines: [['pool'], ['category']],
  pool_transfers: [['fromPool'], ['toPool'], ['amount']],
};
const TYPE_WORDS = {
  Income: ['income', 'credit', 'in', 'revenue', 'sale', 'sales', 'deposit', 'refund', 'money in', 'received'],
  Expense: ['expense', 'expenses', 'purchase', 'debit', 'spend', 'spending', 'out', 'payment', 'card payment'],
  Bills: ['bill', 'bills', 'direct debit', 'standing order', 'subscription', 'utility'],
  'Debt Payment': ['debt', 'debt payment', 'debt payments', 'loan', 'repayment', 'credit card payment'],
  Savings: ['saving', 'savings', 'save'],
  Investment: ['investment', 'investments', 'invest', 'investing'],
};
const SUMMARY_RE = /(subtotal|sub-total|total|summary|net profit|month net|balance b\/?f|carried forward|opening balance|closing balance|^-{2,}|^={2,}|📅)/i;
const MONTH_BANNER_RE = /^\W*(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s+\d{4}\W*$/i;

// ---------------------------------------------------------------- python-ish helpers
/** str() of a cell value, the way the desktop app sees it. */
export function pyStr(v) {
  if (v === null || v === undefined) return 'None';
  if (v instanceof XDate) return v.toString();
  if (typeof v === 'boolean') return v ? 'True' : 'False';
  return String(v);
}
const isStr = (v) => typeof v === 'string';
const isBlankCell = (c) => ['', 'nan', 'None', 'NaT'].includes(pyStr(c).trim());
const isBlank = (row) => row.every(isBlankCell);
const filled = (row) => row.filter((c) => pyStr(c).trim() !== '');

export function norm(s) {
  s = (s === null || s === undefined || s === '' ? '' : pyStr(s)).toLowerCase().replace(/&/g, ' and ');
  s = s.replace(/[£$€%#()[\]/\\:._\-–—*?!']/g, ' ');
  s = s.replace(/\s+/g, ' ').trim();
  if (s !== 'gbp') s = s.replace(/\s*\b(in )?gbp\b\s*/g, ' ').trim();
  return s;
}

export function normType(value, amount = null) {
  const t = norm(value);
  for (const typ of TX_TYPES) if (t === typ.toLowerCase()) return [typ, false];
  for (const [typ, words] of Object.entries(TYPE_WORDS)) if (words.includes(t)) return [typ, false];
  const parts = t.split(' ').filter(Boolean);
  for (const [typ, words] of Object.entries(TYPE_WORDS)) {
    if (words.some((w) => !w.includes(' ') && parts.includes(w)) || words.some((w) => w.includes(' ') && t.includes(w))) {
      return [typ, false];
    }
  }
  return [(amount || 0) > 0 ? 'Income' : 'Expense', true];
}

export function colLetter(i) {
  let s = '';
  i += 1;
  while (i) { const r = (i - 1) % 26; i = Math.floor((i - 1) / 26); s = String.fromCharCode(65 + r) + s; }
  return s;
}

// ---------------------------------------------------------------- tables
export class Table {
  constructor(sheet, title, header, body, headerRow, section = 'skip', mapping = {}, reason = '') {
    Object.assign(this, { sheet, title, header, body, headerRow, section, mapping, reason });
  }
  get label() {
    const where = this.sheet || 'File';
    const pos = this.headerRow >= 0 ? `row ${this.headerRow + 1}` : 'no header';
    return `${where} · ${pos}` + (this.title ? ` · “${this.title}”` : '');
  }
  columns() {
    return this.header.map((h, i) => `${colLetter(i)}: ${pyStr(h).trim() || `(blank ${i + 1})`}`);
  }
}

function aliasScore(cell, alias) {
  if (!cell) return 0;
  if (cell === alias) return 4;
  const words = cell.split(' ');
  const a = alias.split(' ');
  if (a.length > 1 && cell.includes(alias)) return 3;
  if (a.length === 1 && words.includes(alias)) return words.length <= 3 ? 2 : 1;
  if (cell.startsWith(alias + ' ') || cell.endsWith(' ' + alias)) return 2;
  return 0;
}

export function mapHeader(header, section) {
  const cells = header.map(norm);
  const cands = [];
  Object.entries(FIELDS[section]).forEach(([f, aliases], fpri) => {
    cells.forEach((c, ci) => {
      const best = Math.max(0, ...aliases.map((a) => aliasScore(c, a)));
      if (best) cands.push([-best, fpri, ci, f]);
    });
  });
  cands.sort((x, y) => x[0] - y[0] || x[1] - y[1] || x[2] - y[2]);
  const out = {}, used = new Set();
  for (const [, , ci, f] of cands) {
    if (!(f in out) && !used.has(ci)) { out[f] = ci; used.add(ci); }
  }
  return out;
}

function headerStrength(row) {
  const texts = row.filter((c) => isStr(c) && c.trim());
  if (texts.length < 2) return 0;
  if (row.some((c) => c !== null && c !== '' && (parseAmount(c) !== null || (!isStr(c) && parseDate(c))))) return 0;
  if (texts.some((c) => parseDate(c))) return 0;
  const known = new Set();
  for (const sec of Object.keys(FIELDS)) for (const i of Object.values(mapHeader(row, sec))) known.add(i);
  return known.size;
}

function sectionFromName(name) {
  const n = norm(name);
  if (!n) return null;
  for (const [sec, words] of SECTION_NAME_RULES) if (words.some((w) => n.includes(w))) return sec;
  return null;
}

const fits = (section, mapping) => REQUIRED[section].every((g) => g.some((f) => f in mapping));

function guessSection(header, body) {
  let best = 'skip', bestScore = 0, bestMap = {};
  const hn = header.map(norm).join(' ');
  for (const sec of Object.keys(FIELDS)) {
    let m = mapHeader(header, sec);
    if (sec === 'transactions') m = sniffTransactions(header, body, m);
    if (!fits(sec, m)) continue;
    let score = Object.keys(m).length + (sec === 'transactions' ? 2 : 0);
    if (sec === 'pool_transfers' && !hn.includes('pool')) continue;
    if (sec === 'transfers' && hn.includes('pool')) continue;
    if (['balances', 'goals', 'pools', 'pool_lines'].includes(sec) && 'date' in mapHeader(header, 'transactions')) score -= 3;
    if (sec === 'dla' && !/dla|director|business/.test(hn)) continue;
    if (score > bestScore) { best = sec; bestScore = score; bestMap = m; }
  }
  return [best, bestMap];
}

const isNumberLike = (v) => typeof v === 'number' && !(v > 20000 && v < 80000);

function sniffTransactions(header, body, m) {
  m = { ...m };
  const sample = body.slice(0, 60).filter((r) => !isBlank(r));
  if (!sample.length) return m;
  const ncols = Math.max(...sample.map((r) => r.length));
  const used = new Set(Object.values(m));
  const ratio = (ci, fn) => {
    const vals = sample.filter((r) => ci < r.length && !['', 'None'].includes(pyStr(r[ci]).trim())).map((r) => r[ci]);
    return vals.length >= Math.max(2, Math.floor(sample.length / 3)) ? vals.filter(fn).length / vals.length : 0;
  };
  if (!('date' in m)) {
    for (let ci = 0; ci < ncols; ci++) {
      if (!used.has(ci) && ratio(ci, (v) => parseDate(v) !== null && !isNumberLike(v)) > 0.6) {
        m.date = ci; used.add(ci); break;
      }
    }
  }
  if (!['amount', 'moneyIn', 'moneyOut'].some((k) => k in m)) {
    for (let ci = ncols - 1; ci >= 0; ci--) {
      if (!used.has(ci) && ratio(ci, (v) => parseAmount(v) !== null) > 0.7) { m.amount = ci; used.add(ci); break; }
    }
  }
  return m;
}

// ---------------------------------------------------------------- reading
function sniffDelimiter(text) {
  const lines = text.split(/\r?\n/).filter((l) => l.trim()).slice(0, 30);
  let best = ',', bestScore = -1;
  for (const d of [',', ';', '\t', '|']) {
    const counts = lines.map((l) => parseCsvLine(l, d).length - 1);
    const nz = counts.filter((c) => c > 0);
    if (!nz.length) continue;
    const freq = {};
    for (const c of nz) freq[c] = (freq[c] || 0) + 1;
    const top = Math.max(...Object.values(freq));
    const score = top * 10 + nz.length;
    if (score > bestScore) { best = d; bestScore = score; }
  }
  return best;
}
function parseCsvLine(line, d) { return parseCsv(line, d)[0] || []; }

export function parseCsv(text, d = ',') {
  const rows = [];
  let row = [], cur = '', q = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (q) {
      if (ch === '"') {
        if (text[i + 1] === '"') { cur += '"'; i++; } else q = false;
      } else cur += ch;
    } else if (ch === '"' && cur === '') q = true;
    else if (ch === d) { row.push(cur); cur = ''; }
    else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      row.push(cur); rows.push(row); row = []; cur = '';
    } else cur += ch;
  }
  if (cur !== '' || row.length) { row.push(cur); rows.push(row); }
  return rows;
}

function decodeText(buf) {
  const bytes = new Uint8Array(buf);
  try {
    let t = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    if (t.charCodeAt(0) === 0xfeff) t = t.slice(1);
    return t;
  } catch {
    return new TextDecoder('windows-1252').decode(bytes);
  }
}

/** Cell value as the desktop app would see it: string | number | XDate | boolean | ''. */
function cellValue(cell) {
  if (!cell || cell.v === undefined || cell.v === null) return '';
  if (cell.t === 'n' && cell.z && XLSX.SSF.is_date(cell.z)) {
    return new XDate(addDays('1899-12-30', Math.floor(cell.v)));
  }
  if (cell.t === 'd') return new XDate(new Date(cell.v).toISOString().slice(0, 10));
  if (cell.t === 'e') return '';
  return cell.v;
}

/** [[sheet name | null, rows]] from an .xlsx/.xls/.csv file's bytes. */
/** What kind of file is this, from its first bytes (names and extensions can't be trusted). */
export function sniffKind(name, buf) {
  const b = new Uint8Array(buf.slice ? buf.slice(0, 8) : buf);
  if (b[0] === 0x50 && b[1] === 0x4b) return 'workbook'; // zip: xlsx, xlsm, xlsb, ods
  if (b[0] === 0xd0 && b[1] === 0xcf && b[2] === 0x11 && b[3] === 0xe0) return 'workbook'; // old .xls
  if (b[0] === 0x09 && (b[1] === 0x08 || b[1] === 0x04)) return 'workbook'; // very old BIFF
  const head = new TextDecoder('latin1').decode(new Uint8Array(buf.slice ? buf.slice(0, 600) : buf)).replace(/^\uFEFF|^\xEF\xBB\xBF/, '').trimStart().toLowerCase();
  if (head.startsWith('<')) return 'workbook'; // HTML table or Excel 2003 XML saved as ".xls"
  return 'text';
}

export function sheetRows(ws) {
  // walk the cells that exist (a sheet's stated size can be a million rows of formatting)
  let maxR = -1, maxC = -1;
  const cells = [];
  for (const k of Object.keys(ws)) {
    if (k[0] === '!') continue;
    const a = XLSX.utils.decode_cell(k);
    const v = cellValue(ws[k]);
    if (v === '' || v === null) continue;
    cells.push([a.r, a.c, v]);
    if (a.r > maxR) maxR = a.r;
    if (a.c > maxC) maxC = a.c;
  }
  const rows = Array.from({ length: maxR + 1 }, () => new Array(maxC + 1).fill(''));
  for (const [r, c, v] of cells) rows[r][c] = v;
  return rows;
}

/** [[sheet name | null, rows]] from an .xlsx/.xls/.xlsb/.ods/.csv file's bytes. */
export function readTables(name, buf) {
  if (sniffKind(name, buf) === 'workbook') {
    const wb = XLSX.read(buf, { type: 'array', cellDates: false, cellNF: true, cellText: false, cellStyles: false });
    return wb.SheetNames.map((sn) => {
      const ws = wb.Sheets[sn];
      return [sn, ws ? sheetRows(ws) : []];
    });
  }
  const text = decodeText(buf);
  return [[null, parseCsv(text, sniffDelimiter(text.slice(0, 4096)))]];
}

export function readMeta(tables) {
  const meta = {};
  for (const [, rows] of tables) {
    for (const r of rows.slice(0, 40)) {
      const cells = filled(r);
      if (cells.length === 2 && isStr(cells[0])) {
        const k = norm(cells[0]);
        if (['workspace name', 'workspace', 'business name', 'company name'].includes(k)) meta.workspaceName = pyStr(cells[1]).trim();
      }
    }
  }
  return meta;
}

export function detectTables(raw) {
  const tables = [];
  for (const [sheet, rows] of raw) {
    const sheetSec = sectionFromName(sheet);
    let cur = null, pendingTitle = null;
    rows.forEach((r, i) => {
      if (isBlank(r)) return;
      const cells = filled(r);
      if (cells.length === 1 && isStr(cells[0])) {
        const t = cells[0].trim().replace(/^[[\]#=\-* ]+|[[\]#=\-* ]+$/g, '');
        const sec = sectionFromName(t);
        if (sec && !MONTH_BANNER_RE.test(t) && !SUMMARY_RE.test(t) && t.length < 50) {
          pendingTitle = t; cur = null; return;
        }
        if (cur) cur.body.push(r);
        return;
      }
      const strength = headerStrength(r);
      if (strength >= 2 && (!cur || strength >= 3 || pendingTitle)) {
        cur = new Table(sheet, pendingTitle, [...r], [], i);
        tables.push(cur);
        pendingTitle = null;
        return;
      }
      if (cur) cur.body.push(r);
    });
    if (!tables.some((t) => t.sheet === sheet) && sheetSec !== 'skip') {
      const hl = headerless(sheet, rows);
      if (hl) { tables.push(hl); continue; }
    }
    for (const t of tables) {
      if (t.sheet === sheet && t.section === 'skip' && !Object.keys(t.mapping).length && !t._classified) {
        classify(t, sheetSec);
        t._classified = true;
      }
    }
  }
  return [tables, readMeta(raw)];
}

function headerless(sheet, rows) {
  let data = rows.filter((r) => !isBlank(r));
  if (data.length < 2) return null;
  const ncols = Math.max(...data.map((r) => r.length));
  let header = Array.from({ length: ncols }, (_, i) => `Column ${colLetter(i)}`);
  const first = data[0];
  let hrow = -1;
  if (first.filter((c) => pyStr(c).trim()).every((c) => isStr(c) && parseDate(c) === null && parseAmount(c) === null)) {
    header = [...first.map((c, i) => pyStr(c).trim() || `Column ${colLetter(i)}`), ...header.slice(first.length)];
    data = data.slice(1);
    hrow = rows.indexOf(first);
  }
  const m = sniffTransactions(header, data, mapHeader(header, 'transactions'));
  if (!('date' in m) || !('amount' in m)) return null;
  const used = new Set(Object.values(m));
  let best = null, bestLen = 0;
  for (let ci = 0; ci < ncols; ci++) {
    if (used.has(ci)) continue;
    const vals = data.filter((r) => ci < r.length && isStr(r[ci]) && parseAmount(r[ci]) === null).map((r) => r[ci]);
    const avg = vals.reduce((s, v) => s + v.length, 0) / Math.max(1, data.length);
    if (avg > bestLen) { best = ci; bestLen = avg; }
  }
  if (best !== null) m.description = best;
  return new Table(sheet, null, header, data, hrow, 'transactions', m,
    hrow >= 0 ? 'columns found by their contents' : 'no header row: columns found by their contents');
}

function classify(t, sheetSec) {
  const named = t.title ? sectionFromName(t.title) : null;
  const [guessed, gmap] = guessSection(t.header, t.body);
  const choice = named || sheetSec;
  if (choice && choice !== 'skip') {
    let m = mapHeader(t.header, choice);
    if (choice === 'transactions') m = sniffTransactions(t.header, t.body, m);
    if (fits(choice, m)) {
      t.section = choice; t.mapping = m; t.reason = named ? 'from title' : 'from sheet name';
      return;
    }
  }
  if (choice === 'skip' && !(guessed === 'transactions' && t.body.length > 5)) {
    t.section = 'skip'; t.mapping = {}; t.reason = 'summary sheet';
    return;
  }
  t.section = guessed; t.mapping = gmap;
  t.reason = guessed !== 'skip' ? 'from column headers' : 'not recognised';
}

/** Change what a table is imported as and re-detect its columns. */
export function remap(t, section) {
  t.section = section;
  if (section === 'skip') { t.mapping = {}; return; }
  let m = mapHeader(t.header, section);
  if (section === 'transactions') m = sniffTransactions(t.header, t.body, m);
  t.mapping = m;
  t.reason = 'chosen by you';
}

// ---------------------------------------------------------------- rows
export function buildRows(fin, ws, tables) {
  const rows = [];
  tables.forEach((t, ti) => {
    if (t.section === 'skip') return;
    for (const r of t.body) {
      if (isBlank(r)) continue;
      const d = {};
      for (const [f, i] of Object.entries(t.mapping)) d[f] = i < r.length ? r[i] : '';
      const row = build(t.section, d, r, t.flip);
      if (!row) continue;
      row.table = ti;
      rows.push(row);
    }
  });
  flag(fin, ws, rows);
  return rows;
}

const s_ = (v) => {
  const s = v === null || v === undefined ? '' : pyStr(v).trim();
  return ['nan', 'none', '-', '—', 'n/a', 'default'].includes(s.toLowerCase()) ? '' : s;
};
const looksSummary = (raw) => raw.filter((c) => isStr(c) && c.trim())
  .some((t) => SUMMARY_RE.test(t) || MONTH_BANNER_RE.test(t.trim()));

function splitIcon(name) {
  const m = (name || '').match(/^([^\p{L}\p{N}_\s(]+)\s*(.*)$/u);
  if (m && m[2]) return [m[1].trim(), m[2].trim()];
  return ['', (name || '').trim()];
}

function build(sec, d, raw, flip = false) {
  const row = { section: sec, data: {}, raw, status: 'new', reasons: [], include: true, table: -1 };
  const rs = row.reasons;
  const has = (k) => k in d;
  if (sec === 'transactions') {
    const date = parseDate(d.date);
    let amt = has('amount') ? parseAmount(d.amount) : null;
    if (amt === null && (has('moneyIn') || has('moneyOut'))) {
      const i = parseAmount(d.moneyIn) || 0, o = parseAmount(d.moneyOut) || 0;
      amt = (i || o) ? Math.abs(i) - Math.abs(o) : null;
    }
    if (flip && amt !== null) amt = -amt;
    if (!date && looksSummary(raw)) return null;
    if (!date && amt === null) return null;
    let [typ, guessed] = normType(d.type, amt);
    const nt = norm(d.type);
    const exact = TX_TYPES.some((t) => nt === t.toLowerCase() || nt === t.toLowerCase() + 's');
    if (amt !== null && amt !== 0 && !exact && !guessed) {
      if (amt > 0 && typ !== 'Income') typ = 'Income';
      else if (amt < 0 && typ === 'Income') typ = 'Expense';
    }
    if (guessed && s_(d.type)) rs.push(`type “${s_(d.type)}” read as ${typ}`);
    else if (guessed) rs.push(`type guessed from sign (${typ})`);
    let cat = s_(d.category);
    const desc = [s_(d.description), s_(d.notes)].filter(Boolean).join(' · ');
    if (!cat) { cat = 'Uncategorised'; rs.push('no category'); }
    row.data = {
      date, type: typ, category: cat, bankAccount: s_(d.bankAccount), amount: amt !== null ? Math.abs(amt) : null,
      description: desc, pool: splitIcon(s_(d.pool))[1],
      isBusinessPayment: s_(d.isBusinessPayment) ? parseBool(d.isBusinessPayment) : false,
      businessWorkspace: s_(d.businessWorkspace), businessCategory: s_(d.businessCategory),
    };
    if (!date) { rs.push('no readable date'); row.status = 'error'; }
    if (amt === null) { rs.push('no readable amount'); row.status = 'error'; } else if (amt === 0) rs.push('£0.00 amount');
  } else if (sec === 'dla') {
    const date = parseDate(d.date);
    const amt = parseAmount(d.amount);
    if (!date && looksSummary(raw)) return null;
    if (!date && amt === null) return null;
    row.data = {
      date, amount: amt, bankAccount: s_(d.bankAccount), businessWorkspace: s_(d.businessWorkspace),
      businessCategory: s_(d.businessCategory), description: s_(d.description) || s_(d.notes), notes: s_(d.notes),
    };
    if (!date) { rs.push('no readable date'); row.status = 'error'; }
    if (amt === null) { rs.push('no readable amount'); row.status = 'error'; }
    if (!row.data.businessWorkspace) rs.push('no business named');
  } else if (sec === 'transfers') {
    const amt = parseAmount(d.amount);
    const date = parseDate(d.date);
    if (!date && looksSummary(raw)) return null;
    row.data = { date, fromAccount: s_(d.fromAccount), toAccount: s_(d.toAccount), amount: amt !== null ? Math.abs(amt) : null, notes: s_(d.notes) };
    if (!date) { rs.push('no readable date'); row.status = 'error'; }
    if (!amt) { rs.push('no amount'); row.status = 'error'; }
    if (!row.data.fromAccount || !row.data.toAccount || row.data.fromAccount.toLowerCase() === row.data.toAccount.toLowerCase()) {
      rs.push('from/to account missing or the same'); row.status = 'error';
    }
  } else if (sec === 'balances') {
    const bal = parseAmount(d.balance);
    const name = s_(d.name);
    if (!name || looksSummary(raw)) return null;
    row.data = { name, balance: bal };
    if (bal === null) { rs.push('no balance'); row.status = 'error'; } else rs.push("used as the account's starting balance");
  } else if (sec === 'goals') {
    const amt = parseAmount(d.amount);
    const cat = s_(d.category);
    if (!cat || looksSummary(raw)) return null;
    const [typ] = normType(d.type, -1);
    row.data = { category: cat, amount: amt !== null ? Math.abs(amt) : null, type: typ };
    if (amt === null) { rs.push('no amount'); row.status = 'error'; }
  } else if (sec === 'bills') {
    const name = s_(d.billName);
    if (!name || looksSummary(raw)) return null;
    const amt = parseAmount(d.amount);
    const dd = d.dueDay;
    let day = null;
    const pdate = typeof dd !== 'number' ? parseDate(dd) : null;
    if (pdate) day = parseInt(pdate.slice(8), 10);
    else {
      const m = pyStr(dd === undefined || dd === null || dd === '' ? '' : dd).match(/(\d{1,2})/);
      day = m ? parseInt(m[1], 10) : null;
    }
    const rt = pyStr(d.reminderTime || '').trim();
    const tm = rt.match(/^(\d{1,2})[:.](\d{2})/);
    row.data = {
      billName: name, category: s_(d.category) || name, dueDay: day, amount: amt !== null ? Math.abs(amt) : 0,
      bankAccount: s_(d.bankAccount), reminderTime: tm ? `${tm[1].padStart(2, '0')}:${tm[2]}` : '09:00', notes: s_(d.notes),
    };
    if (!day || day < 1 || day > 31) { rs.push('no due day'); row.status = 'error'; }
  } else if (sec === 'pools') {
    const rawName = s_(d.name);
    if (!rawName || looksSummary(raw)) return null;
    const [icon, name] = splitIcon(rawName);
    const modeS = norm(d.mode), target = pyStr(d.target || '');
    let mode, val;
    if (target.includes('%') || modeS.includes('percent') || pyStr(d.mode || '').includes('%')) {
      mode = 'percent'; val = parseAmount(target.replace(/%/g, '')) || 0;
    } else if (['standalone', 'unconnected', 'independent'].some((w) => modeS.includes(w))) {
      mode = 'unconnected'; val = parseAmount(target) || parseAmount(d.allocated) || 0;
    } else {
      mode = 'fixed'; val = parseAmount(target) !== null ? parseAmount(target) : (parseAmount(d.allocated) || 0);
    }
    row.data = { name, icon, mode, value: Math.abs(val || 0), isDefault: parseBool(d.isDefault), description: s_(d.description) };
  } else if (sec === 'pool_lines') {
    const cat = s_(d.category);
    if (!cat || looksSummary(raw)) return null;
    const [typ] = normType(d.type, -1);
    row.data = { pool: splitIcon(s_(d.pool))[1], category: cat, type: typ, allocated: Math.abs(parseAmount(d.allocated) || 0) };
  } else if (sec === 'pool_transfers') {
    const amt = parseAmount(d.amount);
    if (looksSummary(raw)) return null;
    row.data = {
      date: parseDate(d.date) || null, fromPool: splitIcon(s_(d.fromPool))[1], toPool: splitIcon(s_(d.toPool))[1],
      amount: Math.abs(amt || 0), note: s_(d.note),
    };
    if (!amt) { rs.push('£0.00 transfer, nothing to move'); row.status = 'error'; }
  }
  if (row.status !== 'error' && rs.length && sec !== 'balances') row.status = 'review';
  if (row.status === 'error') row.include = false;
  return row;
}

const txKey = (date, amount, desc, acct) =>
  ['tx', date, Math.abs(Number(amount) || 0).toFixed(2), (desc || '').toLowerCase().replace(/\s+/g, ' ').trim(), (acct || '').toLowerCase()].join('|');

/** Mark rows that already exist. Identical rows inside the file are kept (two £20 coffees on one day
 *  are real); only as many copies as already exist in the app are treated as duplicates. */
function flag(fin, ws, rows) {
  const existing = new Map();
  const add = (k) => existing.set(k, (existing.get(k) || 0) + 1);
  if (ws) {
    for (const t of fin.transactions(ws)) add(txKey(t.date, t.amount, t.description, t.bankAccount));
    for (const t of fin.transfers(ws)) add(['tr', t.date, t.amount.toFixed(2), t.fromAccount.toLowerCase(), t.toAccount.toLowerCase()].join('|'));
    for (const b of fin.bills(ws)) add(['bill', b.billName.toLowerCase()].join('|'));
    for (const g of fin.goals(ws)) add(['goal', (g.category || '').toLowerCase()].join('|'));
  }
  for (const t of fin.dlaRows()) {
    add(['dla', t.date, Math.abs(t.amount).toFixed(2), (t.businessWorkspaceName || '').toLowerCase(), (t.description || '').toLowerCase()].join('|'));
  }
  for (const r of rows) {
    if (r.status === 'error') continue;
    const d = r.data;
    let key = null;
    if (r.section === 'transactions') key = txKey(d.date, d.amount, d.description, d.bankAccount);
    else if (r.section === 'transfers') key = ['tr', d.date, d.amount.toFixed(2), d.fromAccount.toLowerCase(), d.toAccount.toLowerCase()].join('|');
    else if (r.section === 'bills') key = ['bill', d.billName.toLowerCase()].join('|');
    else if (r.section === 'goals') key = ['goal', d.category.toLowerCase()].join('|');
    else if (r.section === 'dla') key = ['dla', d.date, Math.abs(d.amount).toFixed(2), d.businessWorkspace.toLowerCase(), d.description.toLowerCase()].join('|');
    if (key && (existing.get(key) || 0) > 0) {
      existing.set(key, existing.get(key) - 1);
      r.status = 'duplicate'; r.include = false;
      r.reasons.unshift('already in the app');
    }
  }
}

// ---------------------------------------------------------------- import
export function importRows(fin, ws, rows, progress = null) {
  const todo = rows.filter((r) => r.include && r.status !== 'error')
    .sort((a, b) => IMPORT_ORDER.indexOf(a.section) - IMPORT_ORDER.indexOf(b.section));
  const counts = Object.fromEntries(IMPORT_ORDER.map((s) => [s, 0]));
  const poolCache = new Map();
  const db = fin.db;

  const account = (name, targetWs = ws) => {
    const names = fin.accountNames(targetWs);
    if (!name) return names.length ? names[0] : fin.saveAccount(targetWs, 'Current Account', 0, null, false).name;
    const hit = names.find((n) => n.toLowerCase() === name.toLowerCase());
    return hit || fin.saveAccount(targetWs, name, 0, null, false).name;
  };
  const pool = (name, create = true) => {
    if (!name) return null;
    const key = name.toLowerCase();
    if (poolCache.has(key)) return poolCache.get(key);
    const pools = fin.pools(ws);
    let hit = pools.find((p) => p.name.toLowerCase() === key)
      || pools.find((p) => key.includes(p.name.toLowerCase()) || p.name.toLowerCase().includes(key));
    if (!hit && create) {
      hit = fin.savePool(ws, { name, icon: '💷', color: '#6366f1', isWorkspaceConnected: true, fundingMode: 'fixed', fundingValue: 0 }, false);
    }
    if (hit) { poolCache.set(key, hit.id); return hit.id; }
    return null;
  };
  const category = (name, typ, poolId) => {
    const existed = fin.categoryByName(ws, name);
    const c = fin.ensureCategory(ws, name, typ);
    if (poolId && (!existed || !c.poolId)) fin.setCategoryPool(c.id, poolId, false);
    return c;
  };
  const personal = fin.workspaces().find((w) => w.kind === 'personal');
  const business = (name) => {
    if (!name) return null;
    return fin.workspaces().find((w) => w.name.toLowerCase() === name.toLowerCase()) || fin.createWorkspace(name, 'business', false, null, false);
  };

  const seededDefault = fin.defaultPool(ws);
  todo.forEach((r, i) => {
    const d = r.data, s = r.section;
    if (s === 'balances') {
      const acc = fin.accounts(ws).find((a) => a.name.toLowerCase() === d.name.toLowerCase());
      fin.saveAccount(ws, acc ? acc.name : d.name, d.balance, acc ? acc.id : null, false);
    } else if (s === 'pools') {
      let existing = fin.pools(ws).find((p) => p.name.toLowerCase() === d.name.toLowerCase());
      const data = {
        name: d.name, icon: d.icon || '💷', isWorkspaceConnected: d.mode !== 'unconnected', fundingMode: d.mode,
        fundingValue: d.value, isDefault: d.isDefault, description: d.description,
      };
      if (!existing && d.isDefault && seededDefault && seededDefault.name === 'Everyday Spending' && seededDefault.fundingValue === 0) {
        existing = seededDefault;
      }
      if (existing) fin.savePool(ws, { ...existing, ...data, id: existing.id, color: existing.color }, false);
      else fin.savePool(ws, { ...data, color: '#6366f1' }, false);
      poolCache.clear();
    } else if (s === 'pool_lines') {
      const pid = pool(d.pool);
      const c = fin.ensureCategory(ws, d.category, d.type);
      fin.setCategoryPool(c.id, pid, false);
      db.update('categories', c.id, { allocated: d.allocated, defaultType: d.type });
    } else if (s === 'goals') {
      fin.saveGoal(ws, d, false);
    } else if (s === 'transactions') {
      const pid = pool(d.pool);
      category(d.category, d.type, pid);
      const bw = d.isBusinessPayment ? business(d.businessWorkspace) : null;
      fin.saveTransaction({
        workspaceId: ws, date: d.date, type: d.type, category: d.category, bankAccount: account(d.bankAccount),
        amount: d.amount, description: d.description, poolId: pid, isBusinessPayment: !!bw,
        businessWorkspaceId: bw ? bw.id : null, businessCategory: d.businessCategory || null,
      }, false);
    } else if (s === 'dla') {
      const target = personal ? personal.id : ws;
      const bw = business(d.businessWorkspace);
      const amt = d.amount;
      fin.saveTransaction({
        workspaceId: target, date: d.date, type: amt >= 0 ? 'Expense' : 'Income',
        category: amt >= 0 ? 'Business Costs (DLA)' : 'DLA Repayment', bankAccount: account(d.bankAccount, target),
        amount: Math.abs(amt), description: d.description, isBusinessPayment: !!bw, businessWorkspaceId: bw ? bw.id : null,
        businessCategory: d.businessCategory || null, dlaNotes: d.notes || null,
      }, false);
    } else if (s === 'transfers') {
      fin.saveTransfer({
        workspaceId: ws, date: d.date, fromAccount: account(d.fromAccount), toAccount: account(d.toAccount),
        amount: d.amount, notes: d.notes,
      }, false);
    } else if (s === 'bills') {
      fin.saveBill(ws, { ...d, bankAccount: account(d.bankAccount), reminderEnabled: true }, false);
    } else if (s === 'pool_transfers') {
      const a = pool(d.fromPool, false), b = pool(d.toPool, false);
      db.insert('pool_transfers', {
        workspaceId: ws, fromPoolId: a, toPoolId: b, fromPoolName: d.fromPool, toPoolName: d.toPool,
        amount: d.amount, note: d.note || 'Imported', date: d.date || null,
      });
    }
    counts[s]++;
    if (progress) progress(i + 1, todo.length);
  });
  // drop the empty starter account if the file brought its own accounts
  const accs = fin.accounts(ws);
  const starter = accs.find((a) => a.name === 'Current Account' && !a.initialBalance);
  if (starter && accs.length > 1 && !fin.accountUsage(ws, 'Current Account') && !fin.bills(ws).some((b) => b.bankAccount === 'Current Account')) {
    db.delete('bank_accounts', starter.id);
  }
  db.commit();
  return counts;
}

/** Convenience: file bytes -> [tables, meta]. */
export function detectFile(name, buf) { return detectTables(readTables(name, buf)); }
