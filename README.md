# SocialKoneqti Agent (launcher)

Layer 3 of SocialKoneqti: the Windows desktop app users download from
`https://social.koneqti.com/download`. It sits in the system tray and runs jobs that
the SocialKoneqti brain sends it, using the user's AdsPower browser profiles.

```
register → poll every 10 s → wait until scheduled_for → fetch playbook (memory only)
        → open AdsPower profile → attach CloakBrowser over CDP (humanize)
        → run the playbook steps with the job's HBE timings → report result → close profile
heartbeat every 60 s
```

## The zero-intelligence rule

This repository is **public**. It holds no intelligence and must never gain any:

- no prompts, captions, platform selectors, platform URLs, schedules, limits or brand logic
- no delays chosen locally: every pause and typing speed comes from the job's `hbe` plan
- playbooks are fetched from the brain per job, held in memory only, never written to disk or logged
- local logs contain job id, type, status and error code only — never the API key, payload text or playbook content
- never commit `.env` or any secret

Anyone copying this code gets a generic step interpreter and nothing else.
The step vocabulary (goto, click, type, upload, extract, foreach, if_exists …) is defined by
the shared API contract in `src/shared/contract.ts`, a verbatim copy of
`socialkoneqti/docs/contract/contract.ts`. Change the canonical copy first, then copy it here.

## Layout

```
main.ts                      Electron main: single-instance lock, window, tray menu, IPC, updater
preload.ts                   contextBridge API (window.sk) — contextIsolation on, nodeIntegration off
src/shared/contract.ts       brain API contract (verbatim copy)
src/shared/ipc.ts            main ⇄ renderer types
src/agent/brainClient.ts     typed axios client for /agent/* and /auth/validate-key
src/agent/poller.ts          10 s polling, slots, scheduling, one job per AdsPower profile, expiry
src/agent/heartbeat.ts       60 s heartbeat (AdsPower status, RAM %, active jobs, paused, version)
src/agent/profileManager.ts  AdsPower Local API wrapper (status, list, start, stop, active)
src/agent/browser.ts         CDP attach + CloakBrowser humanize layer, Playwright page driver
src/agent/executor.ts        generic playbook step interpreter (templates, guards, error mapping)
src/agent/typing.ts          human typing from hbe.typing (per-char delay, typos, word pauses)
src/agent/jobRunner.ts       one job end to end → JobResultRequest
src/agent/runtime.ts         wires register → heartbeat → poller → executor, state for the UI
src/main/*                   electron-store settings, .env seeding, electron-log, tray icon
src/app.tsx, src/screens/*   React UI: Status, Profiles, Add Profile, Live Activity, Settings
tests/*                      vitest unit tests
```

## Development

Requires Node 20+.

```bash
npm install
npm run dev        # Vite dev server + Electron
npm run build      # typecheck (tsc --noEmit) + esbuild main/preload + vite renderer
npm test           # vitest
```

For local testing copy `.env.example` to `.env` in the repo root and fill in your own
API key from the dashboard (Settings → API key). The file is git-ignored.

## Configuration

Settings live in electron-store (`%APPDATA%\SocialKoneqti Agent\settings.json`); the API key is
encrypted with Windows DPAPI via Electron `safeStorage` when available.

On first run the app seeds its settings from a pre-filled `.env` (the per-user file the dashboard
provides with the download) found next to the installed `.exe` or in `%APPDATA%\SocialKoneqti Agent\`:

| Key | Default |
|---|---|
| `BRAIN_URL` | `https://social.koneqti.com/api/gateway` |
| `API_KEY` | — (`sk_live_…`, from the dashboard) |
| `USER_ID` | — |
| `POLL_INTERVAL_MS` | `10000` (the brain's register response overrides it) |
| `HEARTBEAT_INTERVAL_MS` | `60000` (the brain's register response overrides it) |
| `ADSPOWER_URL` | `http://localhost:50325` |
| `ADSPOWER_API_KEY` | — (only if AdsPower "Local API security" is enabled) |

## Building the Windows installer

Build on a Windows machine (electron-builder needs Windows to stamp the .exe):

```powershell
npm ci
npm run dist       # → release\SocialKoneqti-Setup.exe + release\latest.yml
```

Upload both files to the Linux VPS so the download link and the auto-updater feed work:

```bash
scp release/SocialKoneqti-Setup.exe release/latest.yml user@linux-vps:/var/www/social.koneqti.com/releases/
```

`electron-updater` checks `https://social.koneqti.com/download/latest.yml` (generic provider),
downloads new versions in the background and installs them when the app quits.
Bump `version` in `package.json` for every release.

## Runtime notes

- Only one instance can run (`requestSingleInstanceLock`); a second launch focuses the first window.
- Closing the window minimises to the tray. Quit from the tray menu.
- "Start automatically when Windows starts" registers a login item that starts hidden in the tray.
- Pause (tray, Status screen or Settings) stops leasing and starting jobs; running jobs finish.
  The brain can also pause the agent through the heartbeat response.
- The profile Test button opens the AdsPower profile, reads its exit IP from
  `https://api.ipify.org` (a neutral utility endpoint), closes it and reports health to the brain.
