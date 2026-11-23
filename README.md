# Financial OS (web)

Financial OS as a web app you can open on any phone or computer. It has the same money rules as the desktop app:
Budget Pools home, bank accounts, all transactions, Calendar & P&L, categories and goals, bills, the Director's
Loan Account, analysis, the smart spreadsheet importer, and a full Excel backup you can restore anywhere.

* Free to run: hosted on GitHub Pages, data in Firebase (free Spark plan).
* Updates itself: every change pushed to `main` is built and published automatically, and open copies of the app
  switch to the new version on their own (as soon as no form is open).
* Works offline and installs like an app (Add to Home Screen / Install app).
* GBP everywhere, dates in Europe/London, light theme by default (dark in Settings).

## Your data

* **Cloud (normal):** each record is stored in your own Firebase project under `users/{your id}/records`. Only you
  can read it (see `firestore.rules`). Every device you sign in on stays in sync live. Phones keep an offline copy.
* **Excel backup:** Menu → *Back up everything to Excel* downloads one `.xlsx` with every workspace, account,
  transaction, transfer, category, pool, bill and goal. You can open and edit it in Excel. Menu → *Restore from
  Excel backup* puts it back exactly, into any copy of the app.
* **No cloud:** if `src/config.js` has no `apiKey`, the app keeps data in the browser only.

## Set up from scratch (about 15 minutes)

You can repeat this any time to make a brand-new copy, then restore your Excel backup into it.

### 1. Firebase (stores your data)
1. Go to <https://console.firebase.google.com>, click **Create a project**, give it a name, turn **off** Google
   Analytics, click **Create**.
2. **Build → Authentication → Get started → Email/Password →** switch on → **Save**.
3. **Users** tab → **Add user** → your email and a password.
4. **Build → Firestore Database → Create database →** location **europe-west2 (London)** → **production mode** → **Create**.
5. Firestore **Rules** tab → replace everything with the contents of `firestore.rules` → **Publish**.
6. ⚙️ **Project settings → Your apps → `</>` (Web)** → nickname `web` → **Register app**. Copy the values from
   the `firebaseConfig` box into `src/config.js`.

### 2. GitHub (hosts the app)
1. Create a **public** repository (e.g. `financial-os-web`) and push this folder to its `main` branch.
2. Repository **Settings → Pages → Source: GitHub Actions**.
3. The **Actions** tab shows "Publish app" running. When it's green, the app is at
   `https://<your-github-name>.github.io/<repo-name>/`.
4. Back in Firebase: **Authentication → Settings → Authorized domains → Add domain →** `<your-github-name>.github.io`.

### 3. Use it
Open the link, sign in, and on your phone choose **Add to Home Screen** (iPhone: Share → Add to Home Screen;
Android: ⋮ → Install app). To bring data over from the desktop app, export to Excel there and use
Menu → *Import spreadsheet* here, or restore a web backup with Menu → *Restore from Excel backup*.

## For developers

```bash
npm install
npm run dev      # local dev server
npm test         # logic, importer, backup round-trip and sync tests
npm run build    # production build in dist/
```

| Area | File |
|---|---|
| Money rules (port of the desktop `services.py`) | `src/lib/finance.js` |
| Smart importer (port of `importer.py`, same results on the same files) | `src/lib/importer.js` |
| Excel backup / restore | `src/lib/backup.js` |
| In-memory store + schema | `src/lib/store.js` |
| Firebase sync (offline cache, delta sync, tombstones) | `src/lib/persist-cloud.js` |
| Browser-only storage | `src/lib/persist-local.js` |
| Screens | `src/ui/*.jsx` |
| Auto-publish | `.github/workflows/deploy.yml` |

Free-plan notes: after the first download each device only fetches records changed since it last looked, and a
full refresh happens at most once a week, so normal use stays far inside Firestore's free 50,000 reads a day.
Bill reminders show while the app is open (in-app, plus a notification if you allow it); a closed web app can't
wake itself up without a paid server.
