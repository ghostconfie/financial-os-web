import { render } from 'preact';
import { useEffect, useState } from 'preact/hooks';
import './styles.css';
import { firebaseConfig } from './config.js';
import { Store } from './lib/store.js';
import { Finance } from './lib/finance.js';
import { App } from './ui/App.jsx';
import { startUpdater } from './updater.js';

const cloud = !!(firebaseConfig && firebaseConfig.apiKey && !/PASTE/i.test(firebaseConfig.apiKey));
const store = new Store();
const fin = new Finance(store);
if (typeof window !== 'undefined') window.__fos = { store, fin };

// tiny status emitter shared by the storage layer and the UI
const listeners = new Set();
let lastStatus = { state: 'busy', label: 'Starting…' };
const emit = (s) => { lastStatus = { ...lastStatus, ...s }; for (const l of listeners) l(lastStatus); };
const onStatus = (fn) => { listeners.add(fn); fn(lastStatus); return () => listeners.delete(fn); };

(function initTheme() {
  let t = 'light';
  try { t = localStorage.getItem('fos.theme') || 'light'; } catch { /* ignore */ }
  const dark = t === 'dark' || (t === 'auto' && matchMedia('(prefers-color-scheme: dark)').matches);
  document.documentElement.dataset.theme = dark ? 'dark' : 'light';
})();

function Splash({ text, children }) {
  return (
    <div class="login">
      <div class="card" style={{ textAlign: 'center' }}>
        <img src="icons/icon-192.png" alt="" width="56" height="56" style={{ borderRadius: 14 }} />
        <h2 class="brandname" style={{ margin: '12px 0 6px' }}>Emperio Finances</h2>
        <div class="muted">{text}</div>
        {children}
      </div>
    </div>
  );
}

function Login({ cloudApi }) {
  const [email, setEmail] = useState(() => { try { return localStorage.getItem('fos.email') || ''; } catch { return ''; } });
  const [pw, setPw] = useState('');
  const [err, setErr] = useState('');
  const [msg, setMsg] = useState('');
  const [busy, setBusy] = useState(false);
  const submit = async (e) => {
    e.preventDefault();
    setErr(''); setMsg(''); setBusy(true);
    try {
      try { localStorage.setItem('fos.email', email.trim()); } catch { /* ignore */ }
      await cloudApi.signIn(email, pw);
    } catch (ex) { setErr(cloudApi.friendlyAuthError(ex)); } finally { setBusy(false); }
  };
  return (
    <div class="login">
      <form class="card form" onSubmit={submit}>
        <div class="login-brand"><img src="icons/icon-192.png" alt="" width="72" height="72" /><h2 class="brandname">Emperio Finances</h2><div class="muted small">Sign in to see your money</div></div>
        <label class="field"><span>Email</span><input type="email" autoComplete="username" value={email} onInput={(e) => setEmail(e.currentTarget.value)} required /></label>
        <label class="field"><span>Password</span><input type="password" autoComplete="current-password" value={pw} onInput={(e) => setPw(e.currentTarget.value)} required /></label>
        {err && <div class="notice rose">{err}</div>}
        {msg && <div class="notice emerald">{msg}</div>}
        <button class="btn primary block" disabled={busy}>{busy ? 'Signing in…' : 'Sign in'}</button>
        <button type="button" class="btn ghost block" onClick={async () => {
          setErr(''); setMsg('');
          if (!email.trim()) { setErr('Type your email first, then press “Forgot password”.'); return; }
          try { await cloudApi.resetPassword(email); setMsg('Password reset email sent. Check your inbox (and spam).'); } catch (ex) { setErr(cloudApi.friendlyAuthError(ex)); }
        }}>Forgot password</button>
      </form>
    </div>
  );
}

function Root() {
  const [phase, setPhase] = useState('boot'); // boot | login | loading | ready | offline-empty | error
  const [sync, setSync] = useState(null);
  const [cloudApi, setCloudApi] = useState(null);
  const [error, setError] = useState('');

  useEffect(() => {
    (async () => {
      try {
        if (!cloud) {
          const { startLocal } = await import('./lib/persist-local.js');
          const s = await startLocal(store, emit);
          fin.ensureSeeded();
          setSync(s); setPhase('ready');
          return;
        }
        const api = await import('./lib/persist-cloud.js');
        api.initCloud(firebaseConfig);
        setCloudApi(api);
        let started = false;
        api.watchUser(async (user) => {
          if (!user) { setPhase('login'); return; }
          if (started) return;
          started = true;
          setPhase('loading');
          const s = await api.startCloud(store, user, emit);
          if (!store.all('workspaces').length) {
            if (s.firstServer()) fin.ensureSeeded();
            else { setSync(s); setPhase('offline-empty'); return; }
          }
          setSync(s); setPhase('ready');
        });
      } catch (ex) {
        console.error(ex);
        setError(ex.message || String(ex)); setPhase('error');
      }
    })();
  }, []);

  useEffect(() => {
    if (phase !== 'offline-empty') return;
    // keep waiting for the first download
    const i = setInterval(() => {
      if (store.all('workspaces').length) { setPhase('ready'); clearInterval(i); } else if (sync?.firstServer()) { fin.ensureSeeded(); setPhase('ready'); clearInterval(i); }
    }, 1000);
    return () => clearInterval(i);
  }, [phase]);

  if (phase === 'login') return <Login cloudApi={cloudApi} />;
  if (phase === 'ready') return <App fin={fin} sync={{ ...lastStatus, ...sync }} onStatus={onStatus} />;
  if (phase === 'offline-empty') return <Splash text="Waiting for your data to download. Check you're connected to the internet." />;
  if (phase === 'error') return <Splash text={`Something went wrong starting the app: ${error}`}><button class="btn primary" style={{ marginTop: 12 }} onClick={() => location.reload()}>Try again</button></Splash>;
  return <Splash text={phase === 'loading' ? 'Loading your data…' : 'Starting…'} />;
}

render(<Root />, document.getElementById('app'));
startUpdater();
