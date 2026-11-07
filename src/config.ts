// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * RocketChat → Mattermost migration configuration.
 * Overridable through environment variables (see README).
 */

const env = process.env;

/** "4M", "512K", "1G", "4194304", "0" → bytes. */
export function parseSize(raw: string | undefined, fallback: number): number {
  if (raw === undefined || raw.trim() === "") return fallback;
  const m = /^\s*(\d+(?:\.\d+)?)\s*([KMG]?)i?B?\s*$/i.exec(raw);
  if (!m) throw new Error(`Taille invalide : "${raw}" (ex. 4M, 512K, 0)`);
  const mult = { "": 1, K: 1024, M: 1024 ** 2, G: 1024 ** 3 }[m[2].toUpperCase() as "" | "K" | "M" | "G"];
  return Math.round(Number(m[1]) * mult);
}

const argv = process.argv.slice(3);

export const config = {
  // --- RocketChat MongoDB connection ---
  // With auth, e.g.: mongodb://user:pass@host:27017/rocketchat?authSource=admin
  // With SOURCE_SSH, write the URI as seen FROM the RocketChat server (host may
  // be a Docker container name): the tool opens the SSH tunnel itself.
  mongoUri: env.MONGO_URI ?? "mongodb://localhost:27017/rocketchat",
  dbName: env.DB_NAME ?? "rocketchat",

  // --- RocketChat server access (optional) ---
  // "user@host": tunnel to MongoDB through SSH + load watchdog on that host.
  sourceSsh: env.SOURCE_SSH ?? "",
  // Pause the export while the RocketChat host is under pressure (needs SOURCE_SSH).
  watchdog: env.WATCHDOG !== "false",
  watchdogPsiHigh: Number(env.WATCHDOG_IO_HIGH ?? 25), // % time stalled on I/O
  watchdogPsiLow: Number(env.WATCHDOG_IO_LOW ?? 5),
  watchdogLoadHigh: Number(env.WATCHDOG_LOAD_HIGH ?? 0), // 0 ⇒ CPU count + 2
  watchdogLoadLow: Number(env.WATCHDOG_LOAD_LOW ?? 0), // 0 ⇒ CPU count / 2

  // --- Mattermost server access (upload / import / post-import / verify) ---
  // "user@host", or empty when the tool runs on the Mattermost server itself.
  targetSsh: env.TARGET_SSH ?? "",
  // Docker container running Mattermost; empty ⇒ native install (deb/tarball).
  targetDocker: env.TARGET_DOCKER ?? "",
  // Prefix privileged commands with sudo (when the SSH user is not root).
  targetSudo: env.TARGET_SUDO === "true",
  // Mattermost install dir (default: /opt/mattermost native, /mattermost Docker).
  mmDir: env.MM_DIR ?? "",
  // mmctl binary (default: <MM_DIR>/bin/mmctl, else mmctl from PATH).
  mmctl: env.MMCTL ?? "",
  // systemd service to restart (native installs).
  mmService: env.MM_SERVICE ?? "mattermost",
  // Command reading SQL on stdin for post-import patches, e.g.
  // "sudo -u postgres psql mattermost". Empty ⇒ derived from SqlSettings.DataSource.
  targetPsql: env.TARGET_PSQL ?? "",
  // Throwaway image used for file operations on Docker installs whose
  // Mattermost image has no shell (the official ones): needs `sh`, `stat`, `df`.
  helperImage: env.HELPER_IMAGE ?? "busybox:1.36",
  // Answer "yes" to every confirmation (non-interactive runs).
  assumeYes: env.ASSUME_YES === "true" || argv.includes("--yes") || argv.includes("-y"),
  // Import archive built by `package`.
  zipFile: env.ZIP_FILE ?? "mattermost-import.zip",

  // --- Target Mattermost team ---
  teamName: env.TEAM_NAME ?? "rocketchat",
  teamDisplayName: env.TEAM_DISPLAY_NAME ?? "RocketChat",

  // --- Output ---
  // Working directory: holds import.jsonl + data/ (files)
  outDir: env.OUT_DIR ?? "out",
  jsonlFile: "import.jsonl",
  dataDir: "data", // relative to outDir; attachment paths point here

  // --- Authentication ---
  // Link imported accounts to an SSO provider (e.g. "openid"): each user gets
  // auth_service + auth_data (= lowercased email) and no local password.
  authService: env.AUTH_SERVICE ?? "",
  // Accounts already present in the target Mattermost, one "username email" per
  // line. A RocketChat user whose email matches reuses that username (merge);
  // every other listed username is reserved so no import overwrites it.
  existingUsersFile: env.EXISTING_USERS ?? "",

  // --- Load on the source ---
  // Max GridFS read rate per second ("4M", "512K"; 0 = unlimited). Protects a
  // production RocketChat from I/O saturation during the attachment phase — a
  // full-speed read has taken a real instance down. Conservative default.
  fileRateLimit: parseSize(env.FILE_RATE_LIMIT, 4 * 1024 ** 2),

  // --- Ghost user (deleted / unknown authors) ---
  ghostUsername: env.GHOST_USERNAME ?? "utilisateur-archive",
  ghostEmail: env.GHOST_EMAIL ?? "utilisateur-archive@example.com",

  // --- Scope toggles ---
  exportPosts: env.EXPORT_POSTS !== "false",
  exportDirect: env.EXPORT_DIRECT !== "false", // direct messages (DM)
  exportFiles: env.EXPORT_FILES !== "false", // GridFS attachment extraction
  exportReactions: env.EXPORT_REACTIONS !== "false",
  exportThreads: env.EXPORT_THREADS !== "false",
  // RocketChat "Discussions" (rooms with a parent) → re-parented into the parent
  // channel as a thread instead of standalone channels with message-like names.
  mergeDiscussions: env.MERGE_DISCUSSIONS !== "false",
  exportAvatars: env.EXPORT_AVATARS !== "false", // user profile pictures
  exportEmojis: env.EXPORT_EMOJIS !== "false", // custom emojis
  // Skip custom-emoji images above this size — Mattermost rejects oversized
  // emojis and a single one aborts the whole import job.
  emojiMaxBytes: Number(env.EMOJI_MAX_BYTES ?? 512 * 1024),
  // Channel/team memberships (channels + user `teams`). Disable for a
  // metadata-only re-import (avatars/emojis/profile) that must NOT reset the
  // read-state already applied by a previous full import.
  exportMemberships: env.EXPORT_MEMBERSHIPS !== "false",
  exportPins: env.EXPORT_PINS !== "false", // pinned messages (is_pinned)
  exportStars: env.EXPORT_STARS !== "false", // starred messages (flagged_by)

  // --- Import options ---
  // Archive every channel on import (they appear deactivated/archived).
  archiveChannels: env.ARCHIVE_CHANNELS === "true",
  // Per-user read state of channels, DMs and groups:
  //   "last-seen" (default): what each user saw as read/unread in RocketChat
  //                          (replayed post-import from readstate.sql)
  //   "read"     : mark everything as read
  //   "unread"   : Mattermost behaviour (everything unread)
  readState: (env.READ_STATE ?? "last-seen") as "unread" | "read" | "last-seen",

  // RocketChat GridFS bucket name (uploads)
  gridfsBucket: env.GRIDFS_BUCKET ?? "rocketchat_uploads",

  // --- Post-import password reset (pnpm reset-password) ---
  // SSH host of the Mattermost server (e.g. "user@host"). Empty ⇒ prompted.
  sshHost: env.SSH_HOST ?? "",
  // Mattermost Docker container name.
  mmContainer: env.MM_CONTAINER ?? "mattermost-app-1",
  // Prefix docker commands with sudo on the server.
  mmDockerSudo: env.MM_DOCKER_SUDO !== "false",
} as const;

export type Config = typeof config;