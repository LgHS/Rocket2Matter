# Rocket2Matter

A **RocketChat → Mattermost** migration tool. It reads the **MongoDB** database
of a RocketChat instance and produces a Mattermost **bulk import JSONL** file
(+ attachments), packageable into a zip archive ready for `mmctl import`.

The tool never modifies the RocketChat database: it only reads from it.

## Tested versions

| Component | Tested version |
| --- | --- |
| RocketChat (source) | **7.10.0** |
| Mattermost (target) | **11.3.0** |
| mmctl | **11.3.0** |
| Node.js (build/runtime) | 22 LTS (embedded in the binary) |

> Other versions are likely to work (the Mattermost import format and the
> RocketChat schema are stable), but have not been validated. If you hit a
> schema mismatch, please open an issue.

## What is migrated

| Item | Detail |
| --- | --- |
| Team | a single target Mattermost team (configurable) |
| Channels | public (`c` → `O`) and private (`p` → `P`), normalized names, topic/description |
| Users | excluding bots and accounts without email; admin role preserved; usernames normalized (lowercase) |
| Memberships | derived from subscriptions **and** message authors (no post rejected) |
| Messages | text, timestamp, author |
| Threads | replies (`tmid`) attached to the root message; orphans reclassified |
| Direct messages | 1-to-1 and group conversations (`direct_channel` + `direct_post`) |
| Reactions | emojis converted (`:+1:` → `+1`) |
| Attachments | extracted from **GridFS** into `data/`; names transliterated to ASCII; thumbnails and duplicates dropped |
| File captions | an image caption (RocketChat stores it in `attachments[].description`) becomes the post text |
| Mentions | rewritten to the normalized username; mentions of a non-migrated user are "defused" |
| Gone authors | replaced by a configurable **ghost user** |
| Read state | optional: RocketChat last-seen preserved, or everything marked read (see options) |
| Archiving | optional: all imported channels set to archived |

## Installation

Two options.

### A. Standalone binary (recommended)

Download the executable for your platform from the [Releases](../../releases)
page. No dependency required (Node is embedded):

```bash
chmod +x rocket2matter-*       # Linux/macOS
./rocket2matter-* --help
```

### B. From source

Requirements: [Node.js](https://nodejs.org) ≥ 20 and [pnpm](https://pnpm.io).

```bash
pnpm install
pnpm cli --help
```

## Runtime requirements

- **Read** access to RocketChat's MongoDB database.
- `zip` (for packaging) and [`mmctl`](https://docs.mattermost.com/manage/mmctl-command-line-tool.html)
  (for the Mattermost import).
- On the Mattermost side: **local mode** enabled
  (`MM_SERVICESETTINGS_ENABLELOCALMODE=true`) lets `mmctl` act without
  authentication via the Unix socket.

## Where to run each command

The tool has two "sides": reading from **RocketChat** (source) and writing to
**Mattermost** (target).

| Command | Role | Where to run it |
| --- | --- | --- |
| `export` | reads **RocketChat's MongoDB** → `out/import.jsonl` + `out/data/` | a machine with access to RocketChat's MongoDB (the RocketChat server, or your workstation via an SSH tunnel) |
| `package` | zips `out/` → `mattermost-import.zip` | the **same machine** as `export` |
| import (`mmctl import process`) | loads the zip into Mattermost | **on / against the Mattermost server** (the zip must be in its filestore) |
| `reset-password` | `mmctl user change-password` | **against the Mattermost server** (`ssh` / `docker` / `mmctl` mode) |

In practice:

- **Source side** (`export` + `package`): either directly on the RocketChat
  server (`MONGO_URI=mongodb://localhost:27017/…`), or from your workstation
  through an SSH tunnel:

  ```bash
  ssh -fN -L 27018:localhost:27017 user@rocketchat-server
  MONGO_URI="mongodb://localhost:27018/rocketchat" ./rocket2matter export
  ```

- **Target side**: transfer `mattermost-import.zip` to the Mattermost server,
  place it in its filestore, then run the import (see step 3).

You can drive everything **from a single admin workstation** if it has access to
RocketChat's MongoDB (tunnel) and SSH access to the Mattermost server. If
RocketChat and Mattermost run on the **same server**, do everything there
(`export` against local Mongo → `package` → import → `reset-password` in local
`docker`/`mmctl` mode).

## Usage

Examples use the binary; from source, replace `./rocket2matter` with
`pnpm cli`.

### 1. Export

```bash
MONGO_URI="mongodb://user:pass@host:27017/rocketchat?authSource=admin" \
TEAM_NAME="myteam" TEAM_DISPLAY_NAME="My Team" \
./rocket2matter export
```

Produces `out/import.jsonl` and `out/data/` (attachments).

### 2. Package

```bash
./rocket2matter package      # → mattermost-import.zip
```

### 3. Import into Mattermost

Copy the zip into the `import` folder of Mattermost's filestore, then run the
processing with `--bypass-upload` (direct read, no upload size limit). The file
must be owned by the container user (uid `2000` for the official image):

```bash
mkdir -p volumes/app/mattermost/data/import
cp mattermost-import.zip volumes/app/mattermost/data/import/import.zip
chown -R 2000:2000 volumes/app/mattermost/data/import

docker exec <container> mmctl --local import process \
  --bypass-upload --extract-content=false /mattermost/data/import/import.zip

docker exec <container> mmctl --local import job show <ID>
```

Without local mode (authenticated remote server), use the standard flow — you
must then raise `FileSettings.MaxFileSize` above the zip size:

```bash
mmctl import upload ./mattermost-import.zip      # returns a file name
mmctl import process <returned-name>
```

### 4. Enable access (reset a password)

Imported users have no usable password. **No admin account is created**:
RocketChat administrators are migrated as `system_admin`, so it is enough to
reset the password of one of them.

```bash
./rocket2matter reset-password
```

The script lists the migrated users, offers a search, asks for the password
(**masked input**), then runs `mmctl --local user change-password`. Three
execution modes (interactive, or via `MM_EXEC`):

| Mode | Command run | When |
| --- | --- | --- |
| `ssh` | `ssh -o BatchMode=yes <host> docker exec … mmctl …` | remote Mattermost |
| `docker` | `docker exec … mmctl …` | local Docker container |
| `mmctl` | `mmctl …` | `mmctl` binary installed locally |

The `ssh` mode requires **key-based authentication** (`BatchMode=yes`): no SSH
password is requested; without a key, the connection fails immediately. The
`--dry-run` option prints the command without running it.

## Configuration (environment variables)

| Variable | Default | Role |
| --- | --- | --- |
| `MONGO_URI` | `mongodb://localhost:27017/rocketchat` | source connection |
| `DB_NAME` | `rocketchat` | source database |
| `TEAM_NAME` | `rocketchat` | internal name of the target team |
| `TEAM_DISPLAY_NAME` | `RocketChat` | display name of the team |
| `OUT_DIR` | `out` | output directory |
| `GHOST_USERNAME` | `utilisateur-archive` | user for gone authors |
| `GHOST_EMAIL` | `utilisateur-archive@example.com` | ghost user email |
| `EXPORT_DIRECT` | `true` | export direct messages |
| `EXPORT_FILES` | `true` | extract attachments (GridFS) |
| `EXPORT_REACTIONS` | `true` | export reactions |
| `EXPORT_THREADS` | `true` | export threads |
| `ARCHIVE_CHANNELS` | `false` | `true` ⇒ all imported channels are **archived** (`deleted_at`) |
| `READ_STATE` | `unread` | channel read state: `unread` / `read` / `last-seen` (see below) |
| `GRIDFS_BUCKET` | `rocketchat_uploads` | GridFS uploads bucket |
| `MM_EXEC` | (auto) | `reset-password` mode: `ssh`/`docker`/`mmctl` |
| `SSH_HOST` | — | SSH host (`ssh` mode) |
| `MM_CONTAINER` | `mattermost-app-1` | Mattermost Docker container name |
| `MM_DOCKER_SUDO` | `true` | prefix `docker` commands with `sudo` |

### Import options: archiving and read state

- **Archive channels** (`ARCHIVE_CHANNELS=true`): each channel is imported in
  the archived (deactivated) state. Handy for migrating a read-only history.

- **Read state** (`READ_STATE`): RocketChat does not store a per-message "read"
  state — only, per user and per channel, a "last seen" (the `ls` field of
  subscriptions). Mattermost works the same way (`last_viewed_at` per member).
  Three modes:

  | `READ_STATE` | Effect |
  | --- | --- |
  | `unread` (default) | Mattermost behaviour: everything appears unread |
  | `read` | everything marked **read** (no unread badge) |
  | `last-seen` | reuses RocketChat's **actual last-seen** (faithful badges) |

  The read state applies to **channels** (not to direct messages, which the
  Mattermost import does not let you mark).

```bash
ARCHIVE_CHANNELS=true READ_STATE=read ./rocket2matter export
```

## Building a binary

```bash
pnpm build:binary        # → dist/rocket2matter (current platform)
```

The binary embeds Node via *Single Executable Applications*: the script
downloads a **monolithic** official Node from nodejs.org, injects the bundled
code (esbuild) into it, and signs the result (macOS).

### For another platform

The SEA blob must be generated by a Node **runnable on the build machine**, so
you must build **on** the target platform (or an equivalent CI runner). The
platform/version are configurable:

```bash
NODE_VERSION=22.12.0 TARGET_OS=linux TARGET_ARCH=x64 pnpm build:binary
```

| `TARGET_OS` | `TARGET_ARCH` | Build on |
| --- | --- | --- |
| `darwin` | `arm64` | macOS Apple Silicon |
| `darwin` | `x64` | macOS Intel |
| `linux` | `x64` | Linux x86-64 |
| `linux` | `arm64` | Linux ARM64 |

> Note: at launch, the binary prints a benign Node warning on **stderr**
> ("require() … only supports loading built-in modules"). The **stdout output
> stays clean**; to hide it: `NODE_NO_WARNINGS=1`.

## Releases (GitHub Actions)

A workflow ([.github/workflows/release.yml](.github/workflows/release.yml))
automatically builds the binaries for macOS (arm64/x64) and Linux (x64/arm64)
and attaches them to a **GitHub Release** when a `v*` tag is pushed:

```bash
git tag v1.0.0
git push origin v1.0.0
```

## Tests

```bash
pnpm typecheck   # TypeScript checking
pnpm test        # integration test on an in-memory MongoDB (mongodb-memory-server)
```

The test starts an ephemeral MongoDB, seeds a fake RocketChat database (users,
channels, DMs, threads, reactions, mentions, GridFS files, captions, gone
author), then checks the contents of the produced JSONL.

## Architecture

```
src/
  cli.ts        entry point (export / package / reset-password subcommands)
  config.ts     configuration (environment variables)
  types.ts      RocketChat (source) and Mattermost (target) types
  util.ts       name/emoji/mention/caption normalization, JSONL writer
  files.ts      GridFS attachment extraction
  index.ts      export pipeline
  package.ts    zip archive creation
  reset-password.ts  interactive password reset (post-import)
scripts/
  bundle.ts     esbuild bundle of the CLI
  build-sea.sh  standalone binary build (Node SEA)
test/
  run.ts        end-to-end integration test
```

### Implementation notes

- **Username case**: Mattermost forces lowercase. Usernames are normalized
  (lowercase + valid charset + uniqueness) in the definitions **and** all
  references (members, authors, reactions, mentions).
- **Attachment paths**: Mattermost itself prefixes `data/`. The JSONL therefore
  contains `<id>/<name>` (without `data/`), the files being under
  `data/<id>/<name>` in the zip.
- **File names**: transliterated to ASCII (zip tools do not always flag UTF-8;
  NFC/NFD differ across OSes).
- **Image + caption**: RocketChat leaves `msg` empty and puts the caption in
  `attachments[].description`; it is reused as the post text. Thumbnails
  (`thumb-…`) and redundant copies of the same image are dropped.
- **Unicode separators** `U+2028`/`U+2029` (left raw by `JSON.stringify`) are
  escaped for a JSONL robust to line-by-line readers.

## Known limitations

- **File storage**: only the **GridFS** backend is handled. Files on FileSystem,
  S3 or Google Storage are reported and skipped (`EXPORT_FILES=false` to skip
  them silently). A file absent from the source database cannot be migrated.
- **Memory**: thread replies are kept in memory during the export; allow enough
  RAM for very large databases.
- **Group conversations**: Mattermost limits group channels to 8 members; larger
  RocketChat DMs may be truncated on import.
- Always test the import on a **pre-production** Mattermost instance before the
  final migration.

## License

[GNU AGPL v3.0 or later](LICENSE).
