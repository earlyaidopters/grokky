# Windows support and release

Grokky supports Windows x64 as a first-class desktop target. The same source commit is verified and packaged on a native Windows GitHub runner. OpenRouter's Cloudflare computer is fully available from Windows because its files, commands, Chromium screen, clicks, typing, live stream, and action history run behind the HTTPS gateway rather than through native Windows automation.

Research lock: 2026-08-29

## Support matrix

| Capability | Windows x64 | Notes |
| --- | :---: | --- |
| Installable desktop app | Yes | NSIS installer built on `windows-2022` |
| Codex SDK provider | Yes | Matching `codex.exe` is bundled outside `app.asar` |
| OpenRouter provider | Yes | API key stays in Electron main-process storage |
| Conversations and crews | Yes | Same contracts and persistence as macOS |
| Local structured workspace files | Yes | Path-safe Node filesystem tools |
| Codex commands | Yes | Owned by the native Codex runtime and its configured sandbox |
| Private remote file runner | Yes | HTTPS pairing and structured file tools |
| Cloudflare `/workspace` files | Yes | Separate disposable Linux seat |
| Cloudflare shell commands | Yes | OpenRouter plus Full access and selected cloud device |
| Cloudflare browser screen | Yes | Browser Run at 1280 by 800 |
| Cloudflare browser clicks and typing | Yes | Browser-scoped, approved, and audited |
| Cloudflare Live and History | Yes | Resize, Fit, 100 to 300 percent zoom, pan, and full screen |
| Local Grokky-owned Windows screen capture | No | Not implemented |
| Local Grokky-owned Windows app clicks and typing | No | Not implemented |
| macOS DMG packaging | No | Must be built on the native macOS runner |

The last two No entries apply only to the user's physical Windows desktop. They do not apply to Grokky Cloud Sandbox.

## Install from GitHub Actions

1. Open the repository's Verify workflow.
2. Open the newest green run on `main`.
3. Confirm the run references the commit you intend to install.
4. Download `Grokky-Windows-x64` from Artifacts.
5. Unzip the artifact.
6. Run `Grokky-<version>-win-x64.exe`.
7. Select an installation folder if desired.
8. Launch Grokky from the Start menu.

Artifacts are retained for 14 days. Current builds are unsigned development packages, so Windows SmartScreen can warn. Do not bypass a warning unless the repository, workflow run, and commit are trusted. Public distribution should sign the installer and executable with a trusted code-signing identity.

## First run

Choose either provider or configure both:

### Codex

1. Install or run the Codex CLI once on Windows.
2. Complete its normal sign-in flow.
3. Launch Grokky.
4. Select Codex and a model.
5. Select a real workspace before project work.

The package includes the matching native Codex executable required by the SDK. The release verification fails if `codex.exe` is absent, not a regular file, or implausibly small.

### OpenRouter

1. Save your OpenRouter key in a plain-text env file outside the repository, as `OPENROUTER_API_KEY=replace_with_your_key` with your real key in place of the placeholder.
2. Select **OpenRouter** in the conversation toolbar.
3. Open **Settings → Session → OpenRouter credential** and choose that file.
4. Choose a valid OpenRouter model ID with the capabilities your task needs. Computer use needs tool calling and, for screen reasoning, image input.
5. Send the simple provider check from the [README](../README.md#openrouter-setup), then choose the desired project and access mode.

The packaged app stores the credential file path, not a plaintext API key in chat state. If you use a terminal environment variable instead, remember that a Start-menu launch may not inherit it.

### Cloudflare computer

1. Deploy the gateway once from any supported operator machine.
2. Open Settings, then Computer access.
3. Select **Pair**, enter the gateway HTTPS URL in **Runner endpoint** and a fresh one-time `gsk_…` enrollment key in **Pairing secret**, then select **Pair securely**.
4. Select Grokky Cloud Sandbox.
5. Confirm the device is online and use the relevant **Test** buttons under **Capability policy**.
6. Select Full access when the OpenRouter task needs cloud shell commands.

Windows users do not need Docker, WSL, Wrangler, or a browser extension to use an already deployed cloud computer. See the complete [Cloudflare computer runbook](CLOUDFLARE-COMPUTER.md).

## Windows data locations

The main state file is stored under:

```text
%APPDATA%\Grokky\conversations.json
```

Agent browser and cloud frame evidence is stored in an application-owned folder beside the rest of Grokky's user data. Remote device tokens are encrypted before persistence through Electron `safeStorage`. The renderer receives neither the plaintext OpenRouter key nor the plaintext device token.

Do not copy the application data folder into the repository. Backups can contain private conversation text, workspace paths, action history, and browser evidence even though credentials are protected separately.

## Develop on Windows

Prerequisites:

- Windows x64
- Node.js 20.19 or newer
- npm 10 or newer
- Git
- Optional Codex sign-in
- Optional OpenRouter key
- Docker Desktop only if developing or deploying the Cloudflare gateway

In PowerShell:

```powershell
git clone https://github.com/earlyaidopters/grokky.git
Set-Location grokky
npm ci
npm run verify
npm run smoke:electron:full
npm run dev
```

The Electron smoke launcher resolves the executable from the installed Electron package. It does not call `node_modules/.bin/electron`, a Unix path that can fail on Windows. The full suite launches 47 responsive cases covering compact and wide cloud-computer layouts, approval focus and policy choices, Live and History Watch, automatic and manual Watch opening, resize and zoom state, menus, settings, images, crew views, deletion flows, and narrow/wide composer alignment.

After installing an artifact and pairing it with a disposable production test device, the credential-aware cloud proof is also cross-platform:

```powershell
# Close the normal Grokky window first.
npm run smoke:cloud-device
```

This launches the installed `%LOCALAPPDATA%\Programs\Grokky\Grokky.exe`, decrypts the token through that installed identity's Windows `safeStorage` context, exercises cloud files, non-root commands, Browser Run, screen capture, PNG integrity, the signed Live View boundary, and seat teardown, then exits. Use `GROKKY_INSTALLED_EXECUTABLE` only when testing another trusted install location. Release automation can instead provide both `GROKKY_CLOUD_DEVICE_SMOKE_ENDPOINT` and a short-lived `GROKKY_CLOUD_DEVICE_SMOKE_ENROLLMENT`; that token stays in memory, is revoked by the test, and must also be rotated at the Worker immediately afterward.

## Build the Windows installer

Run packaging on Windows x64:

```powershell
npm ci
npm run package:win
```

The command:

1. Refuses to run on a non-Windows host.
2. Builds the Electron main, preload, and renderer bundles.
3. Runs `electron-builder` for Windows x64 NSIS.
4. Verifies the bundled `codex.exe` at the expected `app.asar.unpacked` path.
5. Writes the installer under ignored `release\`.

Use this for an unpacked directory build:

```powershell
npm run package:win:dir
```

Do not cross-package Windows from macOS. npm installs the native Codex dependency for the host platform, so Electron can otherwise emit a Windows app shell without the required Windows Codex runtime.

## Native CI contract

`.github/workflows/verify.yml` provides three gates:

1. macOS and Windows each run `npm ci`, `npm run verify`, and `npm run smoke:electron:full`.
2. Ubuntu runs the Cloudflare gateway type generation, typecheck, tests, and Wrangler dry-run deployment bundle.
3. After all verification passes, native macOS and Windows jobs build packages and verify the matching Codex runtime before uploading artifacts.

This means the Windows artifact is not inferred from a successful macOS build. Windows launches and exercises the interface itself before packaging.

## Cloudflare gateway deployment from Windows

Docker Desktop must be running for the custom Sandbox image build.

```powershell
Set-Location services/sandbox-gateway
npm ci
npm run verify
npx wrangler whoami
docker info
npm run secrets:new
npx wrangler secret put GROKKY_ENROLLMENT_TOKEN
npx wrangler secret put GROKKY_TOKEN_SECRET
npm run deploy
```

Enter both values only at Wrangler's interactive prompt. Do not paste secrets into a `.ps1` file, terminal transcript, GitHub Actions YAML, or project `.env`. Local development can use ignored `.dev.vars`, based on `.dev.vars.example`.

## Windows troubleshooting

### SmartScreen warns about the installer

The current artifact is unsigned. Confirm its workflow run, branch, and commit. Production releases should be signed. SmartScreen does not indicate a failed Cloudflare deployment.

### Grokky opens but Codex fails immediately

- Confirm the package came from the native Windows workflow job.
- Do not use a Windows shell cross-built on macOS.
- Run `npm run verify:package:win` from an unpacked developer build.
- Confirm security software did not quarantine `codex.exe` from `app.asar.unpacked`.
- Complete the Codex CLI sign-in once for the Windows user running Grokky.

### The cloud computer is offline

- Open the gateway `/health` URL in a browser.
- Confirm the endpoint begins with HTTPS.
- Confirm the device was not revoked.
- Pair again if the token-signing secret was rotated.
- Confirm the Windows clock is synchronized, because action leases expire.

### Live is blank

- Run a browser action first. There is no Live URL before Browser Run opens a page.
- Select Live and Fit.
- Drag the Watch divider left to make the panel wider or select full screen.
- Confirm `live.browser.run` is not blocked by a firewall, DNS filter, or endpoint security product.
- Use History to confirm the saved action frame arrived even if the signed stream expired.

### Grokky cannot capture the Windows desktop

That native feature is not implemented. Select Grokky Cloud Sandbox for an isolated controllable browser and command computer. Codex may expose its own capabilities through the SDK, but Grokky does not claim native Windows screen control.

### The layout is clipped after resizing

- Update to an artifact from a green workflow run that includes the Electron fixture matrix.
- Drag the left session rail and Watch panel independently.
- Use Fit after resizing Watch.
- Toggle the activity group with Show or Hide when the raw action list consumes chat space.
- Use full screen for the browser viewport.

### Token storage fails

Electron `safeStorage` depends on the current Windows user profile and operating-system cryptography. Run Grokky as the same user who paired it. If the Windows profile or encryption context changed, remove the stale paired device and enroll again with a new one-time key.

## Windows release checklist

- [ ] `npm ci` uses the committed lockfile.
- [ ] `npm run verify` passes on the Windows runner.
- [ ] `npm run smoke:electron:full` passes all 47 responsive cases on the Windows runner.
- [ ] Cloud computer pair, approval, live Watch, History, resize, zoom, Fit, and full screen fixtures are present.
- [ ] `npm run package:win` runs on Windows, not through cross-packaging.
- [ ] `npm run verify:package:win` finds a valid `codex.exe` outside `app.asar`.
- [ ] The NSIS installer launches for a clean Windows user.
- [ ] OpenRouter can use the paired Cloudflare browser and command seat.
- [ ] `npm run smoke:cloud-device` passes from a paired installed Windows build before a production release.
- [ ] Local native Windows screen control is described as unavailable.
- [ ] No Windows username, `%APPDATA%` contents, tokens, screenshots, or personal paths are committed.
- [ ] Production artifacts are code-signed before public distribution.
