# Hosting

`wysiwyg.pfa87.cc` uses a dedicated static Node origin on the Mac mini. The application stores documents in the browser; this server has no document API. The production build includes its editor dependencies and the downloadable GPL source archive.

## Local check

```sh
npm ci
npm run build
node scripts/serve.mjs
```

Open `http://127.0.0.1:4321`. `HOST`, `PORT`, and `STATIC_ROOT` override the bind address, port, and published directory. `HOSTS` can specify a comma-separated list of exact bind addresses and takes precedence over `HOST`. Only GET and HEAD are accepted. No files outside the published directory are served, including symlinks pointing outside it.

## Windows local deployment and Workbench

The Windows checkout is `D:\OpenWysiwyg`. Publish and start a persistent local copy:

```powershell
pwsh -NoProfile -File D:\OpenWysiwyg\deploy\install-local.ps1
```

Use `-SkipBuild` only after a successful build. The installer copies `dist` into a new
`%LOCALAPPDATA%\OpenWysiwyg\releases\<timestamp>` directory, retains old releases,
and starts the server at **http://127.0.0.1:4321/**. The current release is recorded
in `deployment.json` alongside that directory. Edits and test builds in the checkout
do not change the running release.

`HKCU\Software\Microsoft\Windows\CurrentVersion\Run\OpenWysiwyg` launches
`deploy\watch-local.ps1` hidden at Windows login. The supervisor restarts its Node
server after a failure. A named mutex prevents duplicate supervisors. Logs and the
current process IDs are under `%LOCALAPPDATA%\OpenWysiwyg`. The supervisor binds
separate listeners to localhost and, when connected, the PC's Tailscale IPv4 read
from `tailscale ip -4`. It never binds to all interfaces or the LAN address.
Unavailable Tailscale leaves localhost running. The supervisor rechecks the assigned
Tailscale address every 30 seconds and restarts its own server when that address changes.
Installation does not add a firewall rule or public network listener.

Workbench's **Tools → OpenWysiwyg** opens this local editor when Workbench itself
is opened at localhost. Remote Workbench sessions open the same Windows deployment
at `http://100.96.64.112:4321/` over the private tailnet. A matching Windows tray
command is prepared in Workbench's source; installing the updated tray executable
is still pending. Localhost, tailnet and public origins have separate saved drafts.
The Workbench catalogue is `C:\Users\paul.faisant\workbench\tools.json`.

Republish with the same install command. To stop the local server and remove its
login startup entry, retaining the checkout, releases and browser drafts:

```powershell
pwsh -NoProfile -File D:\OpenWysiwyg\deploy\install-local.ps1 -Uninstall
```

## Mac mini

- SSH from the Windows workspace: `ssh macmini-cf` (Cloudflare Access). The LAN alias `macmini` may be unreachable off the home network.
- Checkout: `/Users/clawdbot/Dev/OpenWysiwyg`.
- Releases: `/Users/clawdbot/Sites/openwysiwyg/releases/<release>`.
- Published symlink: `/Users/clawdbot/Sites/openwysiwyg/current`.
- Origin: `http://127.0.0.1:4321`.
- LaunchAgent: `~/Library/LaunchAgents/cc.pfa87.openwysiwyg.plist` (template beside this file).
- Logs: `~/Library/Logs/openwysiwyg.log` and `openwysiwyg.err.log`.

Port 4321 was free when checked on 15 September 2026; check it again before the first start: `lsof -nP -iTCP:4321 -sTCP:LISTEN`.

Keep changes separate from `/Users/clawdbot/Dev/AiConglomerate`, which has unrelated work in progress. This deployment does not need to change or restart its dashboard service.

### Publish a release

Build and test before publishing. Copy `dist/` into a **new** release directory, then replace `current` atomically with a symlink to that release. Retain the preceding release for rollback. For example, from the checkout on the Mini:

```sh
release="$(date -u +%Y%m%dT%H%M%SZ)-$(git rev-parse --short HEAD)"
release_path="/Users/clawdbot/Sites/openwysiwyg/releases/$release"
mkdir -p "$release_path"
cp -R dist/. "$release_path/"
export OPENWYSIWYG_RELEASE="$release_path"
python3 - <<'PY'
import os
from pathlib import Path
root = Path('/Users/clawdbot/Sites/openwysiwyg')
release = Path(os.environ['OPENWYSIWYG_RELEASE']).resolve(strict=True)
release.relative_to((root / 'releases').resolve(strict=True))
assert (release / 'index.html').is_file()
pending = root / ('current-next-' + str(os.getpid()))
pending.symlink_to(release, target_is_directory=True)
os.replace(pending, root / 'current')
PY
```

Install and start the LaunchAgent once:

```sh
cp deploy/cc.pfa87.openwysiwyg.plist ~/Library/LaunchAgents/
plutil -lint ~/Library/LaunchAgents/cc.pfa87.openwysiwyg.plist
launchctl bootstrap "gui/$(id -u)" ~/Library/LaunchAgents/cc.pfa87.openwysiwyg.plist
```

On subsequent releases, restart this service after changing the symlink. The server resolves its published root at startup, so it serves one complete release for its lifetime:

```sh
launchctl kickstart -k "gui/$(id -u)/cc.pfa87.openwysiwyg"
curl -I http://127.0.0.1:4321/
```

To roll back, point `current` at the retained release using the same atomic replacement, then restart this LaunchAgent.

### Domain and tunnel

The existing locally managed tunnel is `mma-app` (`9c76db8a-18e5-4026-aaef-e2a783428fdf`). Ingress is `/Users/clawdbot/.cloudflared/config.yml`. Back up that file outside its directory before editing. Add this stanza before the final `http_status:404` rule:

```yaml
  - hostname: wysiwyg.pfa87.cc
    service: http://127.0.0.1:4321
```

Validate with:

```sh
/opt/homebrew/bin/cloudflared tunnel --config ~/.cloudflared/config.yml ingress validate
/opt/homebrew/bin/cloudflared tunnel --config ~/.cloudflared/config.yml ingress rule https://wysiwyg.pfa87.cc
```

In the existing `pfa87.cc` Cloudflare zone, create a proxied CNAME named `wysiwyg.pfa87.cc` pointing to `9c76db8a-18e5-4026-aaef-e2a783428fdf.cfargotunnel.com`. Read the existing DNS record first; never overwrite an unrelated record. The DNS API credential is stored privately in `~/.config/cloudflare/agent.env` on the Mini. Load it only in the deployment process; never copy it into this repo or a build.

The tunnel configuration requires its connectors to restart. **Two existing connectors were running the same ingress file when checked:** system service `system/com.cloudflared.mma-app` and user service `gui/501/com.cloudflare.tunnel`. Re-read the service state and PIDs before restarting. A restart interrupts the SSH transport briefly; run the restart from a detached process, keep the known-good backup, and reconnect afterwards. `clawdbot` owns both connector processes; system `launchctl kickstart` needs administrator authentication, while the user service can be restarted with `launchctl kickstart -k`. Do not disable either existing service as part of this app deployment.

Verify the public page and actual HTML/rendered switching at `https://wysiwyg.pfa87.cc`, including the source archive download. A healthy localhost response alone does not prove the DNS/tunnel route is live.

### Public access

This hostname has its own exact-host Cloudflare Access application named
**OpenWysiwyg**, with a public `bypass` policy for `everyone`. It follows the same
setup as the existing public sites. The `*.pfa87.cc` sign-in application remains
unchanged; the exact hostname takes precedence over it.

If this editor redirects to Google or Cloudflare sign-in, check its exact-host
application and policy. Access administration uses the private credential in
`~/.config/cloudflare/access.env`; the DNS credential in `agent.env` is separate.
Never change the wildcard application's protection to publish this site.

The source repository is `https://github.com/pfaisant/OpenWysiwyg`. You can transfer
a tested build and a Git bundle over SSH if the origin cannot access GitHub. No
GitHub or Cloudflare credentials belong in the checkout or published build.
