# Gil's Arena League app — setup

A phone app (add-to-home-screen) that refreshes the standings every hour on its own.
Hosting and updates are free on GitHub. One-time setup: about 20–30 minutes.

## 1. Create the repository
1. Sign in at github.com (or create a free account).
2. Click **+** (top right) → **New repository**.
3. Name: `gils-arena-league` · choose **Public** (free GitHub Pages needs a public repo; your API key stays secret) · click **Create repository**.

## 2. Upload the app files
1. On the new repo page, click **uploading an existing file**.
2. Open the unzipped `ga-league-app` folder, select everything inside it, and drag it onto the page.
3. Click **Commit changes**.

## 3. Turn on the website
**Settings** → **Pages** (left menu) → under *Build and deployment*, set **Source** to **GitHub Actions**.

## 4. Add your BALLDONTLIE key (stays private)
**Settings** → **Secrets and variables** → **Actions** → **New repository secret**
- Name: `BDL_API_KEY`
- Secret: your key from app.balldontlie.io → **Add secret**

## 5. Add the auto-update job (do this last)
1. Click **Add file** → **Create new file**.
2. File name: type `.github/workflows/update.yml` exactly (the slashes create the folders).
3. Open `setup/update-workflow.yml` from the zip, copy everything, paste it in.
4. Click **Commit changes**. This starts the first run.

## 6. Get the link
**Actions** tab → wait for the green check (about a minute) → open the run → the link is under *deploy*.
It looks like `https://YOUR-USERNAME.github.io/gils-arena-league/`. That's the link for the hosts.

## Draft night
1. On the draft control page → **Scoreboard** panel → **Export for league app**. A `league.json` downloads.
2. In the repo: **Add file** → **Upload files** → drop `league.json` → **Commit changes**.
3. Live in about 2 minutes. After that it refreshes every hour by itself.

Fix a pick later the same way (export again, upload again).
Want an instant refresh? **Actions** → **Update standings** → **Run workflow**.

## Good to know
- Weeks run Monday–Sunday; "this week" movement resets Monday 6 AM Eastern.
- If a player can't be matched, the Actions run shows a yellow warning with the name. Fix the spelling in `league.json`, or add `"bdlId": 123` to that pick.
- If the key stops working (or the BALLDONTLIE plan lapses), the run fails and GitHub emails you. The app keeps showing the last numbers.
