# Rocket2Matter

A **RocketChat → Mattermost** migration tool. It reads RocketChat's **MongoDB**
database and produces a Mattermost **bulk import JSONL** file (plus attachments),
packaged into a zip ready for `mmctl import`.

It migrates teams, channels, users, memberships, messages, threads, direct
messages, reactions, file attachments, user avatars, custom emojis, pinned and
flagged messages, and **each user's read/unread state** — and never modifies the
RocketChat database (read-only). RocketChat **Discussions** become threads in
their channel, **archived** channels stay archived, inactive accounts are
deactivated, and accounts can be linked to your SSO.

## Preamble
At Liège Hackerspace, we have been using Rocket.Chat for many years.

Over time, we have repeatedly faced frustrations with Rocket.Chat. 
This does not mean we have anything against Rocket.Chat in particular; 
we simply believe deeply in data portability, and at some point we wanted to see whether the grass might be greener elsewhere.

After several exchanges with the Mattermost team, we had a very positive feeling. 
This encouraged us to seriously consider migrating our community chat infrastructure from Rocket.Chat to Mattermost.

As part of that migration effort, we built this tool to help convert a Rocket.Chat MongoDB database into a Mattermost bulk import JSONL archive, including attachments, ready to be imported with `mmctl`.

We are releasing this migration tool as open source in its current state.

It is provided **as-is**, with **no warranty**, **no guarantee that it will work for your instance**, 
and no promise that it will cover every Rocket.Chat configuration or edge case. 
It was primarily developed for our own migration needs, but we hope it may be useful to others facing similar challenges.

We would like to thank all Liège Hackerspace members who helped test, review, and improve the migration process, 
as well as the people at Mattermost who supported us, answered our questions, and helped make this migration possible.

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
| Mattermost (target) | 11.3, 11.11 — native (deb) and Docker (official image) |
| mmctl | same as the server |

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

Run it from a third machine that can reach both servers over SSH (recommended:
the export reads the whole RocketChat file storage and writes as much locally).

```bash
./rocket2matter init        # writes rocket2matter.env — fill it in
./rocket2matter preflight   # checks everything, offers fixes (with confirmation)
./rocket2matter migrate     # the whole migration, resumable
```

`migrate` chains the steps below; each one is also a command of its own, and an
interrupted run resumes where it stopped (`--from <step>` to redo one):

| Step | What it does |
| --- | --- |
| `preflight` | SSH access, MongoDB, disk space, `mmctl` local mode, team size limit, SSO settings, SQL access — and offers to fix what it can |
| `export` | reads RocketChat through an SSH tunnel it opens itself, rate-limited, paused automatically if the RocketChat server gets under pressure |
| `package` | builds the import zip |
| `upload` | streams the zip into Mattermost's data directory (native or Docker, resumable, size-checked) |
| `import` | runs `mmctl import process` and waits for it |
| `post-import` | deactivates accounts that were inactive in RocketChat, replays each user's read/unread state |
| `verify` | compares what is in Mattermost with what was exported |
| `cleanup` | removes the zip from the server |

Main settings (`rocket2matter.env`, or environment variables):

| Setting | Meaning |
| --- | --- |
| `SOURCE_SSH` | `user@host` of the RocketChat server (tunnel + load watchdog). Empty: direct MongoDB access |
| `MONGO_URI` | MongoDB URI **as seen from the RocketChat server**; the host may be the mongo container name |
| `FILE_RATE_LIMIT` | max file read rate (default `4M`/s — protects a RocketChat in production) |
| `TARGET_SSH` | `user@host` of the Mattermost server. Empty: the tool runs on it |
| `TARGET_DOCKER` | Mattermost container name (empty for a native install); official shell-less images are supported |
| `TARGET_SUDO` | `true` when the SSH user is not root |
| `TEAM_NAME` / `TEAM_DISPLAY_NAME` | destination team (created if missing) |
| `AUTH_SERVICE` | link accounts to an SSO already set up in Mattermost (`openid`, `gitlab`, `saml`, …), matched by email |
| `READ_STATE` | `last-seen` (default: what each user saw as read in RocketChat), `read`, `unread` |

Accounts that already exist in Mattermost are merged by email; accounts are
always matched by email after the import, since an SSO login may rename them.
Without SSO, give someone access with `./rocket2matter reset-password`.

See the [Wiki](../../wiki) for details and troubleshooting.

## Development

```bash
pnpm install
pnpm typecheck
pnpm test           # integration test on an in-memory MongoDB
test/e2e/run.sh     # end-to-end: real migrate into a stock Mattermost (Docker)
pnpm build:binary   # standalone binary → dist/rocket2matter
```

Releases for macOS and Linux are built and attached automatically by
[`.github/workflows/release.yml`](.github/workflows/release.yml) when a `v*` tag
is pushed.

## License

[GNU AGPL v3.0 or later](LICENSE).
