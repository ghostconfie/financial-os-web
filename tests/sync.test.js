// Cloud sync logic, tested against a small in-memory stand-in for Firestore.
import { describe, expect, it, vi, beforeAll } from 'vitest';

// ---------------------------------------------------------------- fake Firestore
const server = new Map(); // id -> {data, ts}
let clock = 1000;
const listeners = new Set();
const cacheFor = { docs: [] };
const SENTINEL = { __serverTs: true };
const ts = (n) => ({ toMillis: () => n, n });
const snapDoc = (id, rec, pending = false) => ({
  id, metadata: { hasPendingWrites: pending },
  data: () => ({ ...rec.data, _ts: ts(rec.ts) }),
  get: (k) => (k === '_ts' ? ts(rec.ts) : rec.data[k]),
});

vi.mock('firebase/app', () => ({ initializeApp: () => ({}) }));
vi.mock('firebase/auth', () => ({
  getAuth: () => ({}), setPersistence: () => Promise.resolve(), browserLocalPersistence: {}, onAuthStateChanged: () => {},
  signInWithEmailAndPassword: () => {}, sendPasswordResetEmail: () => {}, signOut: () => {},
}));
vi.mock('firebase/firestore', () => ({
  CACHE_SIZE_UNLIMITED: -1,
  initializeFirestore: () => ({}), persistentLocalCache: () => ({}), persistentMultipleTabManager: () => ({}),
  collection: (_fs, ...path) => ({ path: path.join('/') }),
  doc: (coll, id) => ({ coll, id }),
  query: (coll, w) => ({ coll, since: w.since }),
  where: (_f, _op, v) => ({ since: v.n }),
  serverTimestamp: () => SENTINEL,
  getDocsFromCache: async () => ({ forEach: (fn) => cacheFor.docs.forEach(fn) }),
  getDocsFromServer: async () => ({ forEach: (fn) => [...server.entries()].forEach(([id, r]) => fn(snapDoc(id, r))) }),
  writeBatch: () => {
    const sets = [];
    return {
      set: (ref, data) => sets.push([ref.id, data]),
      commit: async () => {
        const changed = [];
        for (const [id, data] of sets) {
          const rec = { data: Object.fromEntries(Object.entries(data).filter(([k]) => k !== '_ts')), ts: ++clock };
          server.set(id, rec);
          changed.push(id);
        }
        for (const l of listeners) l(changed);
      },
    };
  },
  onSnapshot: (q, _opts, next) => {
    const since = q.since || 0;
    const emit = (ids) => next({
      metadata: { fromCache: false },
      docChanges: () => ids.map((id) => ({ type: 'added', doc: snapDoc(id, server.get(id)) })),
    });
    emit([...server.keys()].filter((id) => server.get(id).ts > since));
    const l = (ids) => emit(ids);
    listeners.add(l);
    return () => listeners.delete(l);
  },
}));

const { Store } = await import('../src/lib/store.js');
const { Finance } = await import('../src/lib/finance.js');
const cloud = await import('../src/lib/persist-cloud.js');

beforeAll(() => {
  globalThis.window = { addEventListener() {} };
  try { Object.defineProperty(globalThis.navigator, 'onLine', { value: true, configurable: true }); } catch { globalThis.navigator = { onLine: true }; }
  cloud.initCloud({ apiKey: 'x' });
});

const user = { uid: 'u1', email: 'me@example.com' };
const flush = () => new Promise((r) => setTimeout(r, 0));

describe('cloud sync', () => {
  it('first device seeds, second device downloads, edits flow both ways, deletes propagate', async () => {
    const a = new Store(); const fa = new Finance(a);
    const sa = await cloud.startCloud(a, user, () => {});
    expect(sa.firstServer()).toBe(true);
    expect(a.all('workspaces')).toHaveLength(0);
    fa.ensureSeeded();
    await flush();
    expect(server.size).toBe(a.all('workspaces').length + a.all('budget_pools').length + a.all('categories').length + a.all('bank_accounts').length);

    // device B with an empty cache gets everything
    const b = new Store(); const fb = new Finance(b);
    await cloud.startCloud(b, user, () => {});
    expect(fb.workspaces().map((w) => w.name)).toEqual(['Personal', 'Scrumbb', 'Clean and Serve']);

    // A adds a transaction, B sees it live
    const ws = fa.workspaces()[0].id;
    const t = fa.saveTransaction({ workspaceId: ws, date: '2026-11-20', type: 'Expense', category: 'Groceries', bankAccount: 'Current Account', amount: 12.5, description: 'Tesco' });
    await flush();
    expect(fb.transactions(ws).map((x) => [x.description, x.amount])).toEqual([['Tesco', -12.5]]);
    expect(fb.moneyAtHand(ws)).toBe(-12.5);

    // B edits, A sees it
    fb.saveTransaction({ ...fb.transactions(ws)[0], amount: 20, type: 'Expense' });
    await flush();
    expect(fa.transactions(ws)[0].amount).toBe(-20);

    // B deletes, A loses it
    fb.deleteTransactions([t.id]);
    await flush();
    expect(fa.transactions(ws)).toHaveLength(0);
    expect(server.get(`transactions~${t.id}`).data._deleted).toBe(true);

    // reopening a device: cached copy + only changes since then
    cacheFor.docs = [...server.entries()].map(([id, r]) => snapDoc(id, r));
    fa.saveAccount(ws, 'Savings', 50);
    await flush();
    const c = new Store();
    try { globalThis.localStorage = { getItem: () => String(Date.now()), setItem() {} }; } catch { /* ignore */ }
    await cloud.startCloud(c, user, () => {});
    expect(new Finance(c).accountNames(ws)).toContain('Savings');
    expect(new Finance(c).transactions(ws)).toHaveLength(0);
  });

  it('large imports are split into batches under the Firestore limit', async () => {
    const s = new Store(); const f = new Finance(s);
    await cloud.startCloud(s, { uid: 'u2', email: 'x' }, () => {});
    f.ensureSeeded();
    const ws = f.workspaces()[0].id;
    const before = server.size;
    for (let i = 0; i < 1234; i++) f.saveTransaction({ workspaceId: ws, date: '2026-10-01', type: 'Expense', category: 'Groceries', bankAccount: 'Current Account', amount: 1 }, false);
    s.commit();
    await flush();
    expect(server.size - before).toBe(1234);
  });
});
