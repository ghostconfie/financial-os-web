import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { fmtMoney, monthKey } from '../lib/util.js';
import { Ctx, Icon } from './components.jsx';
import { Home } from './Home.jsx';
import { TOUR_KEY, Tour } from './Tour.jsx';
import { PlanItemDialog, PlanNoteDialog, Plans } from './Plans.jsx';
import { Accounts, Analysis, Bills, Calendar, Categories, DLA, Transactions } from './Tools.jsx';
import {
  AccountDialog, BillDialog, CategoryDialog, Confirm, CoverOverspend, DeleteAccount, DeletePool, GoalDialog,
  PoolDialog, PushFunds, QuickAdd, RemapDialog, WorkspaceDialog,
} from './Dialogs.jsx';

// Excel tools are big, so they load only when first opened (keeps start-up fast).
function lazy(load, name) {
  let Comp = null;
  return function Lazy(props) {
    const [, force] = useState(0);
    useEffect(() => { if (!Comp) load().then((m) => { Comp = m[name]; force(1); }); }, []);
    return Comp ? <Comp {...props} /> : <div class="overlay"><div class="modal"><div class="mb muted" style={{ padding: 24 }}>Loading…</div></div></div>;
  };
}
const ImportDialog = lazy(() => import('./ImportDialog.jsx'), 'ImportDialog');
const BackupDialog = lazy(() => import('./BackupDialogs.jsx'), 'BackupDialog');
const RestoreDialog = lazy(() => import('./BackupDialogs.jsx'), 'RestoreDialog');
const SettingsDialog = lazy(() => import('./BackupDialogs.jsx'), 'SettingsDialog');

const DIALOGS = {
  quick: QuickAdd, pool: PoolDialog, push: PushFunds, deletePool: DeletePool, cover: CoverOverspend, category: CategoryDialog,
  remap: RemapDialog, bill: BillDialog, goal: GoalDialog, account: AccountDialog, deleteAccount: DeleteAccount,
  workspaces: WorkspaceDialog, confirm: Confirm, tour: Tour, planItem: PlanItemDialog, planNote: PlanNoteDialog, import: ImportDialog, backup: BackupDialog, restore: RestoreDialog, settings: SettingsDialog,
};
const TABS = [
  ['home', 'Budget Pools', '◎'], ['accounts', 'Accounts', '🏦'], ['tx', 'Transactions', '≡'], ['calendar', 'Calendar & P&L', '▦'],
  ['categories', 'Categories', '◆'], ['bills', 'Bills', '🧾'], ['dla', "Director's Loan", '💼'], ['analysis', 'Analysis', '📊'], ['plans', 'Plans & Forecast', '🔮'],
];
const VIEWS = { home: Home, accounts: Accounts, tx: Transactions, calendar: Calendar, categories: Categories, bills: Bills, dla: DLA, analysis: Analysis, plans: Plans };
const BOTTOM = ['home', 'tx', 'bills'];
const NAV_ICON = { home: 'home', tx: 'list', bills: 'bill' };

const ls = {
  get(k, d) { try { return localStorage.getItem(k) ?? d; } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch { /* private mode */ } },
};

function applyTheme(t) {
  const dark = t === 'dark' || (t === 'auto' && window.matchMedia('(prefers-color-scheme: dark)').matches);
  document.documentElement.dataset.theme = dark ? 'dark' : 'light';
  document.querySelector('meta[name=theme-color]')?.setAttribute('content', dark ? '#0c1511' : '#d4ece2');
}

export function App({ fin, sync: initialSync, onStatus }) {
  const [version, setVersion] = useState(0);
  const [sync, setSync] = useState(initialSync);
  const [ws, setWsState] = useState(() => {
    const saved = ls.get('fos.ws', null);
    return fin.workspace(saved) ? saved : fin.workspaces()[0]?.id;
  });
  const [month, setMonth] = useState(monthKey());
  const [tab, setTabState] = useState(() => (location.hash.slice(1) in VIEWS ? location.hash.slice(1) : 'home'));
  const [theme, setThemeState] = useState(ls.get('fos.theme', 'light'));
  const [dialogs, setDialogs] = useState([]);
  const [toastMsg, setToastMsg] = useState(null);
  const [menu, setMenu] = useState(false);
  const [ledgerFilter, setLedgerFilter] = useState(null);
  const toastTimer = useRef();

  useEffect(() => fin.db.subscribe(setVersion), []);
  // pools saved by older versions get their starting money recorded (zero-based budgeting)
  useEffect(() => { try { fin.migrateBudgets(); } catch (ex) { console.error(ex); } }, [version]);
  // first visit: show the short tutorial
  useEffect(() => { if (!ls.get(TOUR_KEY, null)) open('tour'); }, []);
  useEffect(() => onStatus((s) => setSync((o) => ({ ...o, ...s }))), []);
  useEffect(() => { applyTheme(theme); ls.set('fos.theme', theme); }, [theme]);
  useEffect(() => {
    const h = () => { const t = location.hash.slice(1); if (t in VIEWS) setTabState(t); };
    window.addEventListener('hashchange', h);
    return () => window.removeEventListener('hashchange', h);
  }, []);
  // a workspace can disappear (deleted on another device)
  useEffect(() => { if (!fin.workspace(ws) && fin.workspaces().length) setWsState(fin.workspaces()[0].id); }, [version]);

  const setWs = (id) => { setWsState(id); ls.set('fos.ws', id); };
  const setTab = (t) => { setTabState(t); if (location.hash !== `#${t}`) history.replaceState(null, '', `#${t}`); window.scrollTo({ top: 0 }); setMenu(false); };
  const toast = (m) => { setToastMsg(m); clearTimeout(toastTimer.current); toastTimer.current = setTimeout(() => setToastMsg(null), 3200); };
  const open = (name, props = {}) => { setMenu(false); setDialogs((d) => [...d, { name, props, key: Math.random() }]); };
  const closeTop = (key) => setDialogs((d) => d.filter((x) => x.key !== key));
  const go = (t, filter) => { if (filter) setLedgerFilter(filter); setTab(t); };

  // bill reminders while the app is open
  useEffect(() => {
    const check = () => {
      for (const b of fin.billsToNotify()) {
        const msg = `${b.billName} is due today: ${fmtMoney(b.amount)}`;
        toast(`🔔 ${msg}`);
        try {
          if (typeof Notification !== 'undefined' && Notification.permission === 'granted') {
            navigator.serviceWorker?.getRegistration().then((reg) => (reg ? reg.showNotification('Bill due today', { body: msg, tag: b.id, icon: 'icons/icon-192.png' }) : new Notification('Bill due today', { body: msg })));
          }
        } catch { /* ignore */ }
        fin.markNotified(b.id, b.notifyKey);
      }
    };
    const t = setTimeout(check, 4000);
    const i = setInterval(check, 60000);
    return () => { clearTimeout(t); clearInterval(i); };
  }, []);

  // keyboard: N = quick add
  useEffect(() => {
    const k = (e) => {
      if (e.target.closest('input, select, textarea') || e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.key === 'n' || e.key === 'N') { e.preventDefault(); open('quick', { mode: 'tx' }); }
    };
    window.addEventListener('keydown', k);
    return () => window.removeEventListener('keydown', k);
  }, []);

  // let the updater know whether it's safe to reload
  useEffect(() => { window.__fosBusy = dialogs.length > 0; }, [dialogs.length]);

  const workspace = fin.workspace(ws);
  const pendingBills = useMemo(() => (ws ? fin.pendingBillsCount(ws) : 0), [version, ws]);
  const ctx = {
    fin, db: fin.db, ws, setWs, workspace, month, setMonth, open, toast, go, version, sync, theme,
    setTheme: setThemeState, ledgerFilter, setLedgerFilter,
  };
  if (!workspace) return <div class="login"><div class="card">Loading…</div></div>;
  const View = VIEWS[tab] || Home;
  const dot = { ok: 'ok', synced: 'ok', busy: 'busy', offline: 'off', error: 'off' }[sync.state] || '';

  const menuItems = (
    <>
      <button onClick={() => open('import')}>⬆︎ Import spreadsheet or bank statement</button>
      <button onClick={() => open('backup')}>⬇︎ Back up everything to Excel</button>
      <button onClick={() => open('restore')}>↺ Restore from Excel backup</button>
      <hr />
      <button onClick={() => open('tour')}>? How to use Emperio</button>
      <button onClick={() => open('workspaces')}>▤ Workspaces</button>
      <button onClick={() => { setThemeState(document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark'); setMenu(false); }}>◐ {document.documentElement.dataset.theme === 'dark' ? 'Light' : 'Dark'} theme</button>
      <button onClick={() => open('settings')}>⚙︎ Settings</button>
      {sync.mode === 'cloud' && <button onClick={() => sync.signOut()}>⎋ Sign out</button>}
    </>
  );

  const navBtn = (k) => {
    const t = TABS.find((x) => x[0] === k);
    return (
      <button key={k} class={tab === k ? 'on' : ''} onClick={() => setTab(k)}>
        <Icon name={NAV_ICON[k]} />{k === 'home' ? 'Pools' : t[1]}
        {k === 'bills' && pendingBills > 0 && <span class="count">{pendingBills}</span>}
      </button>
    );
  };

  return (
    <Ctx.Provider value={ctx}>
      <div class="app">
        <header class="topbar">
          <div class="topbar-in">
            <div class="brand"><img src="icons/icon-192.png" alt="" /><span class="hide-sm">Emperio <span class="brand-sub">Finances</span></span></div>
            <select aria-label="Workspace" class="wspill" value={ws} onChange={(e) => {
              const v = e.currentTarget.value;
              if (v === '__manage') { e.currentTarget.value = ws; open('workspaces'); } else setWs(v);
            }}>
              {fin.workspaces().map((w) => <option key={w.id} value={w.id}>{w.name}</option>)}
              <option value="__manage">Manage workspaces…</option>
            </select>
            <span class="spacer" />
            <span class="sync" title={sync.label}><span class={`dot ${dot}`} /><span class="hide-sm">{sync.state === 'ok' || sync.state === 'synced' ? (sync.mode === 'cloud' ? 'Synced' : 'This device') : sync.state === 'busy' ? 'Saving…' : sync.state === 'offline' ? 'Offline' : 'Problem'}</span></span>
            <button class="btn primary hide-sm" onClick={() => open('quick', { mode: 'tx' })}><Icon name="plus" size={16} /> Quick add</button>
            <div style={{ position: 'relative' }}>
              <button class="iconbtn" aria-label="Menu" onClick={() => setMenu(!menu)}><Icon name="menu" /></button>
              {menu === true && <div class="menu" onMouseLeave={() => setMenu(false)}>{menuItems}</div>}
            </div>
          </div>
          <nav class="tabs"><div class="tabs-in">
            {TABS.map(([k, l]) => (
              <button key={k} class={`tab ${tab === k ? 'on' : ''}`} onClick={() => setTab(k)}>{l}{k === 'bills' && pendingBills > 0 && <span class="count">{pendingBills}</span>}</button>
            ))}
          </div></nav>
        </header>
        {sync.state === 'error' && <div class="notice rose" style={{ margin: '10px auto 0', maxWidth: 1240 }}>{sync.label}</div>}
        <main><View key={ws} /></main>
        <nav class="bottomnav">
          {BOTTOM.slice(0, 2).map((k) => navBtn(k))}
          <button class="add" aria-label="Quick add" onClick={() => open('quick', { mode: 'tx' })}><Icon name="plus" /></button>
          {BOTTOM.slice(2).map((k) => navBtn(k))}
          <button class={!BOTTOM.includes(tab) ? 'on' : ''} onClick={() => setMenu('more')}><Icon name="more" />More</button>
        </nav>
        {menu === 'more' && (
          <div class="overlay" onMouseDown={(e) => { if (e.target === e.currentTarget) setMenu(false); }}>
            <div class="modal"><div class="mb" style={{ padding: 10 }}>
              <div class="menu" style={{ position: 'static', boxShadow: 'none', border: 0 }}>
                {TABS.filter(([k]) => !BOTTOM.includes(k)).map(([k, l, i]) => <button key={k} onClick={() => setTab(k)}>{i} {l}</button>)}
                <hr />
                {menuItems}
              </div>
            </div></div>
          </div>
        )}
        {dialogs.map(({ name, props, key }) => { const D = DIALOGS[name]; return <D key={key} {...props} onClose={() => closeTop(key)} />; })}
        {toastMsg && <div class="toast" onClick={() => setToastMsg(null)}>{toastMsg}</div>}
      </div>
    </Ctx.Provider>
  );
}
