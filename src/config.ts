// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * RocketChat → Mattermost migration configuration.
 * Overridable through environment variables (see README).
 */

const env = process.env;

export const config = {
  // --- RocketChat MongoDB connection ---
  // With auth, e.g.: mongodb://user:pass@host:27017/rocketchat?authSource=admin
  mongoUri: env.MONGO_URI ?? "mongodb://localhost:27017/rocketchat",
  dbName: env.DB_NAME ?? "rocketchat",

  // --- Target Mattermost team ---
  teamName: env.TEAM_NAME ?? "rocketchat",
  teamDisplayName: env.TEAM_DISPLAY_NAME ?? "RocketChat",

  // --- Output ---
  // Working directory: holds import.jsonl + data/ (files)
  outDir: env.OUT_DIR ?? "out",
  jsonlFile: "import.jsonl",
  dataDir: "data", // relative to outDir; attachment paths point here

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
  // Channel read state for each member:
  //   "unread"   (default): Mattermost behaviour (everything unread)
  //   "read"     : mark everything as read
  //   "last-seen": reuse RocketChat's actual last-seen (subscription.ls)
  readState: (env.READ_STATE ?? "unread") as "unread" | "read" | "last-seen",

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