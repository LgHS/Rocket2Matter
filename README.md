# Rocket2Matter

A **RocketChat → Mattermost** migration tool. It reads RocketChat's **MongoDB**
database and produces a Mattermost **bulk import JSONL** file (plus attachments),
packaged into a zip ready for `mmctl import`.

It migrates teams, channels, users, memberships, messages, threads, direct
messages, reactions and file attachments — and never modifies the RocketChat
database (read-only).

## 📖 Documentation

Full documentation lives in the **[Wiki](../../wiki)**:

- [Installation](../../wiki/Installation)
- [Quick start](../../wiki/Quick-Start) — the full migration, end to end
- [Where to run each command](../../wiki/Where-to-run)
- [Configuration](../../wiki/Configuration)
- [Import options (archiving & read state)](../../wiki/Import-Options)
- [Importing into Mattermost](../../wiki/Importing-into-Mattermost)
- [Resetting passwords](../../wiki/Resetting-Passwords)
- [Building binaries](../../wiki/Building-Binaries)
- [How it works](../../wiki/How-It-Works)
- [Troubleshooting](../../wiki/Troubleshooting) · [FAQ](../../wiki/FAQ)

## Tested versions

| Component | Version |
| --- | --- |
| RocketChat (source) | 7.10.0 |
| Mattermost (target) | 11.3.0 |
| mmctl | 11.3.0 |

Other versions are likely to work but have not been validated.

## Install

Download the binary for your platform from [Releases](../../releases) — no
dependency required (Node is embedded):

```bash
chmod +x rocket2matter-*
./rocket2matter-* --help
```

Or run from source ([Node.js](https://nodejs.org) ≥ 20 + [pnpm](https://pnpm.io)):

```bash
pnpm install
pnpm cli --help
```

## Quick usage

```bash
MONGO_URI="mongodb://user:pass@host:27017/rocketchat?authSource=admin" \
  ./rocket2matter export        # → out/import.jsonl + out/data/
./rocket2matter package         # → mattermost-import.zip
# import the zip into Mattermost, then enable an account:
./rocket2matter reset-password
```

See the [Quick start](../../wiki/Quick-Start) for the full walkthrough and all
options.

## Development

```bash
pnpm install
pnpm typecheck
pnpm test           # integration test on an in-memory MongoDB
pnpm build:binary   # standalone binary → dist/rocket2matter
```

Releases for macOS and Linux are built and attached automatically by
[`.github/workflows/release.yml`](.github/workflows/release.yml) when a `v*` tag
is pushed.

## License

[GNU AGPL v3.0 or later](LICENSE).
