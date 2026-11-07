// SPDX-License-Identifier: AGPL-3.0-or-later
import { mkdir, rm, writeFile } from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import * as path from "node:path";
import { Db, MongoClient } from "mongodb";
import { config } from "./config.js";
import { FileExporter } from "./files.js";
import { AvatarExporter, EmojiExporter } from "./assets.js";
import { writeReadStateSql } from "./readstate.js";
import { MongoTunnel } from "./tunnel.js";
import { Watchdog, gate } from "./watchdog.js";
import { formatBytes } from "./shell.js";

export const READSTATE_FILE = "readstate.sql";
import {
  JsonlWriter,
  combineMessage,
  convertReactions,
  defuseMentions,
  extractCaption,
  sanitizeChannelName,
  sanitizeUsername,
  splitName,
  toEpochMs,
} from "./util.js";
import type {
  MmAttachment,
  MmChannelMembership,
  MmReaction,
  MmReply,
  RcMessage,
  RcRoom,
  RcSubscription,
  RcUser,
} from "./types.js";

/**
 * A user message that is still current. `t` set ⇒ system message. `_hidden` ⇒
 * a previous version kept by RocketChat's edit history (Message_KeepHistory):
 * same text lineage, new _id, `parent` = the live message. Exporting those
 * turns every edit into an extra post.
 */
const LIVE_USER_MESSAGE = { t: { $exists: false }, _hidden: { $ne: true } } as const;

interface ChannelInfo {
  name: string; // normalized Mattermost name
  display: string;
  type: "O" | "P";
  topic?: string;
  description?: string;
  archived?: boolean; // archived in RocketChat
}

interface DirectInfo {
  members: string[]; // Mattermost usernames (resolved)
  uids?: string[]; // RocketChat ids, fallback when usernames are missing
  shownBy?: string[]; // members who have it in their sidebar (see loadDirectVisibility)
  favoritedBy?: string[];
}

/**
 * A RocketChat "Discussion" (a room with a parent). Mattermost has no such
 * concept, so its messages are re-parented into the parent channel as a thread
 * rooted at the message the discussion was started from.
 */
interface DiscussionInfo {
  parentRoomId: string;
  root: { msgId: string; user?: string; msg: string; ts: number };
}

/** Number of elements ≤ x in an ascending sorted array (binary search). */
function countLessOrEqual(sorted: number[] | undefined, x: number): number {
  if (!sorted?.length) return 0;
  let lo = 0;
  let hi = sorted.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (sorted[mid] <= x) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/**
 * Computes per-member channel read state, according to `config.readState`:
 *  - "unread"    : nothing (Mattermost default behaviour)
 *  - "read"      : everything marked as read
 *  - "last-seen" : reuse RocketChat's last-seen (subscription.ls)
 */
class ReadTracker {
  readonly enabled = config.readState !== "unread";
  private now = Date.now();
  private times = new Map<string, number[]>(); // channel → ts of all posts
  private rootTimes = new Map<string, number[]>(); // channel → ts of root posts
  private userLs = new Map<string, Map<string, number>>(); // user → channel → ls(ms)

  recordPost(channelName: string, ts: number, isRoot: boolean): void {
    if (!this.enabled) return;
    (this.times.get(channelName) ?? this.times.set(channelName, []).get(channelName)!).push(ts);
    if (isRoot) {
      (this.rootTimes.get(channelName) ?? this.rootTimes.set(channelName, []).get(channelName)!).push(ts);
    }
  }

  recordLastSeen(username: string, channelName: string, lsMs: number): void {
    if (!this.enabled) return;
    let m = this.userLs.get(username);
    if (!m) this.userLs.set(username, (m = new Map()));
    m.set(channelName, lsMs);
  }

  finalize(): void {
    for (const a of this.times.values()) a.sort((x, y) => x - y);
    for (const a of this.rootTimes.values()) a.sort((x, y) => x - y);
  }

  /** Read-state fields to embed in a channel membership. */
  membershipFields(username: string, channelName: string): Partial<MmChannelMembership> {
    if (!this.enabled) return {};
    const total = this.times.get(channelName)?.length ?? 0;
    const totalRoot = this.rootTimes.get(channelName)?.length ?? 0;
    if (config.readState === "read") {
      return {
        last_viewed_at: this.now,
        msg_count: total,
        msg_count_root: totalRoot,
        mention_count: 0,
      };
    }
    // last-seen
    const ls = this.userLs.get(username)?.get(channelName) ?? 0;
    return {
      last_viewed_at: ls,
      msg_count: countLessOrEqual(this.times.get(channelName), ls),
      msg_count_root: countLessOrEqual(this.rootTimes.get(channelName), ls),
      mention_count: 0,
    };
  }

  get archiveAt(): number {
    return this.now;
  }
}

export interface ExportOptions {
  /** "username email" lines of accounts already in the target (overrides EXISTING_USERS). */
  existingUsers?: string;
}

export interface ExportSummary {
  finishedAt: number;
  users: number;
  inactiveUsers: number;
  channels: number;
  archivedChannels: number;
  directChannels: number;
  posts: number;
  directPosts: number;
  files: number;
  avatars: number;
  emojis: number;
  emojiNames: string[];
  pinned: number;
}

export const SUMMARY_FILE = "summary.json";

export async function runExport(opts: ExportOptions = {}) {
  console.log("🚀 Migration RocketChat → Mattermost\n");
  const log = (m: string) => console.log(`  ${m}`);

  // Optional: SSH tunnel to MongoDB + load watchdog on the RocketChat host.
  let tunnel: MongoTunnel | undefined;
  let watchdog: Watchdog | undefined;
  let mongoUri = config.mongoUri;
  if (config.sourceSsh) {
    tunnel = new MongoTunnel();
    mongoUri = await tunnel.open(config.mongoUri, log);
    if (config.watchdog) {
      watchdog = new Watchdog(log);
      await watchdog.start();
    }
  }
  if (config.fileRateLimit) {
    log(`lecture des fichiers bridée à ${formatBytes(config.fileRateLimit)}/s (FILE_RATE_LIMIT)`);
  }

  const client = new MongoClient(mongoUri);
  try {
    await client.connect();
  } catch (err) {
    watchdog?.stop();
    tunnel?.close();
    throw err;
  }
  const db = client.db(config.dbName);
  console.log(`Connecté à la base "${config.dbName}".`);

  // Prepare the output directory
  const outDir = path.resolve(config.outDir);
  if (existsSync(outDir)) {
    await rm(outDir, { recursive: true, force: true });
  }
  await mkdir(outDir, { recursive: true });
  const jsonlPath = path.join(outDir, config.jsonlFile);
  const writer = new JsonlWriter(jsonlPath);

  const fileExporter = config.exportFiles
    ? new FileExporter(db, config.gridfsBucket, outDir, config.dataDir)
    : null;

  try {
    // ----- 1. Rooms -----
    const { channels, directs, discussions } = await loadRooms(db);
    if (config.mergeDiscussions && discussions.size) {
      await loadDiscussionRoots(db, discussions, channels);
    }
    console.log(
      `📁 ${channels.size} canaux, ${directs.size} conversations directes` +
        (discussions.size ? `, ${discussions.size} discussions → threads` : "") +
        ".",
    );

    // ----- 2. Users -----
    const { users, usernameMap, usernameById, ghost } = await loadUsers(db, opts.existingUsers);
    console.log(`👤 ${users.length} utilisateurs exportables.`);

    // Resolve direct-conversation members
    if (config.exportDirect) {
      resolveDirects(directs, usernameMap, usernameById, ghost);
      await loadDirectVisibility(db, directs, usernameMap, usernameById);
      console.log(`💬 ${directs.size} conversations directes retenues.`);
    } else {
      directs.clear();
    }

    // ----- 3. Memberships (subscriptions + authors) -----
    const reads = new ReadTracker();
    const userChannels = await buildMemberships(db, channels, usernameMap, reads);

    // Discussion roots: their author must be a member of the parent channel.
    for (const d of discussions.values()) {
      const parent = channels.get(d.parentRoomId);
      const mm = d.root.user ? usernameMap.get(d.root.user) : undefined;
      if (parent && mm) userChannels.addMember(mm, parent.name, "channel_user");
    }

    // ----- 4. Threads + author-derived membership -----
    const threadReplies = new Map<string, RcMessage[]>();
    if (config.exportThreads || config.exportPosts) {
      await scanMessages(
        db,
        channels,
        directs,
        discussions,
        usernameMap,
        usernameById,
        ghost,
        userChannels,
        threadReplies,
        reads,
      );
    }
    reads.finalize();

    // ----- 4b. Avatars + custom emojis (GridFS assets) -----
    let avatarMap = new Map<string, string>();
    if (config.exportAvatars) {
      const avatarExporter = new AvatarExporter(db, outDir, config.dataDir);
      avatarMap = await avatarExporter.exportAll(usernameById);
      if (avatarMap.size) console.log(`🖼️  ${avatarMap.size} avatars extraits.`);
    }
    let emojiLines: { name: string; image: string }[] = [];
    if (config.exportEmojis) {
      const emojiExporter = new EmojiExporter(
        db,
        outDir,
        config.dataDir,
        config.emojiMaxBytes,
      );
      emojiLines = await emojiExporter.exportAll();
      if (emojiLines.length) console.log(`😀 ${emojiLines.length} émojis personnalisés extraits.`);
    }

    // ----- 5. Write entities (order: version → team → channels → emojis → users → direct_channels) -----
    writer.write({ type: "version", version: 1 });
    writer.write({
      type: "team",
      team: {
        name: config.teamName,
        display_name: config.teamDisplayName,
        type: "O",
      },
    });

    if (config.exportMemberships)
    for (const ci of channels.values()) {
      writer.write({
        type: "channel",
        channel: {
          team: config.teamName,
          name: ci.name,
          display_name: ci.display,
          type: ci.type,
          ...(ci.topic ? { header: ci.topic.slice(0, 1024) } : {}),
          ...(ci.description ? { purpose: ci.description.slice(0, 250) } : {}),
          ...(config.archiveChannels || ci.archived
            ? { deleted_at: reads.archiveAt }
            : {}),
        },
      });
    }

    for (const emoji of emojiLines) {
      writer.write({ type: "emoji", emoji });
    }

    writeUsers(writer, users, userChannels, ghost, reads, avatarMap);

    // Mattermost bulk import cannot deactivate users; emit the list of accounts
    // inactive in RocketChat so it can be replayed post-import via
    // `mmctl user deactivate` (see scripts/deactivate-users.sh).
    // By email: an SSO login may rename the account before this list is replayed.
    const inactive = users
      .filter((u) => u.active === false)
      .map((u) => u.emails![0].address.toLowerCase());
    if (inactive.length) {
      await writeFile(
        path.join(outDir, "deactivated-users.txt"),
        inactive.join("\n") + "\n",
      );
      console.log(
        `😴 ${inactive.length} comptes inactifs listés dans deactivated-users.txt (à rejouer post-import).`,
      );
    }

    if (config.exportDirect) {
      for (const di of directs.values()) {
        writer.write({
          type: "direct_channel",
          direct_channel: {
            members: di.members,
            ...(di.shownBy?.length ? { shown_by: di.shownBy } : {}),
            ...(di.favoritedBy?.length ? { favorited_by: di.favoritedBy } : {}),
          },
        });
      }
    }

    // Per-user read state (channels, DMs, groups) is replayed post-import by
    // SQL: see readstate.ts for why the import file cannot carry it faithfully.
    if (config.readState === "last-seen") {
      const r = await writeReadStateSql(
        db,
        {
          teamName: config.teamName,
          channelNameByRoom: new Map([...channels].map(([id, ci]) => [id, ci.name])),
          directMembersByRoom: new Map([...directs].map(([id, di]) => [id, di.members])),
          skipRooms: new Set(discussions.keys()),
          usernameMap,
          emailByUser: new Map([
            ...users.map((u) => [
              (u as RcUser & { _mm: string })._mm,
              u.emails![0].address.toLowerCase(),
            ] as [string, string]),
            [ghost, config.ghostEmail.toLowerCase()],
          ]),
          memberships: userChannels,
        },
        path.join(outDir, READSTATE_FILE),
      );
      console.log(
        `👀 ${r.rows} états de lecture par utilisateur (${r.read} lus, ${r.partial} partiels) → ${READSTATE_FILE} (à rejouer post-import).`,
      );
    }

    // ----- 6. Messages (posts + direct_posts) -----
    const counts = {
      posts: 0,
      directPosts: 0,
      orphanReplies: 0,
      pinned: 0,
      flagged: 0,
      discussions: 0,
    };
    if (config.exportPosts) {
      await writePosts(
        db,
        writer,
        channels,
        directs,
        discussions,
        usernameMap,
        usernameById,
        ghost,
        threadReplies,
        fileExporter,
        counts,
      );
    }

    await writer.close();

    // Machine-readable summary, used by `verify` to check the import.
    const summary: ExportSummary = {
      finishedAt: Date.now(),
      users: users.length,
      inactiveUsers: inactive.length,
      channels: channels.size,
      archivedChannels: config.archiveChannels
        ? channels.size
        : [...channels.values()].filter((c) => c.archived).length,
      directChannels: config.exportDirect ? directs.size : 0,
      posts: counts.posts,
      directPosts: counts.directPosts,
      files: fileExporter?.stats.exported ?? 0,
      avatars: avatarMap.size,
      emojis: emojiLines.length,
      emojiNames: emojiLines.map((e) => e.name),
      pinned: counts.pinned,
    };
    await writeFile(path.join(outDir, SUMMARY_FILE), JSON.stringify(summary, null, 2) + "\n");

    // ----- Summary -----
    console.log("\n----------------------------------------------------");
    console.log(`🎉 Export terminé : ${jsonlPath}`);
    console.log(`   • ${writer.count} lignes JSONL écrites`);
    console.log(`   • ${counts.posts} messages de canaux`);
    if (config.exportDirect) {
      console.log(`   • ${counts.directPosts} messages directs`);
    }
    if (counts.orphanReplies) {
      console.log(
        `   • ${counts.orphanReplies} réponses orphelines reclassées en messages`,
      );
    }
    if (fileExporter) {
      const s = fileExporter.stats;
      console.log(`   • ${s.exported} fichiers extraits (${s.skipped} ignorés)`);
    }
    if (config.exportAvatars && avatarMap.size) {
      console.log(`   • ${avatarMap.size} avatars`);
    }
    if (config.exportEmojis && emojiLines.length) {
      console.log(`   • ${emojiLines.length} émojis personnalisés`);
    }
    if (counts.discussions) {
      console.log(`   • ${counts.discussions} discussions fusionnées en threads`);
    }
    if (counts.pinned) console.log(`   • ${counts.pinned} messages épinglés`);
    if (counts.flagged) console.log(`   • ${counts.flagged} favoris (flags)`);
    const archivedCount = config.archiveChannels
      ? channels.size
      : [...channels.values()].filter((c) => c.archived).length;
    if (archivedCount) {
      console.log(`   • ${archivedCount} canaux archivés (deleted_at)`);
    }
    if (config.readState !== "unread") {
      console.log(
        `   • état de lecture des canaux : ${config.readState === "read" ? "tout marqué lu" : "dernier-vu RocketChat"}`,
      );
    }
    console.log(
      `\n➡️  Empaqueter pour Mattermost : pnpm package  (génère le zip d'import)`,
    );
  } finally {
    watchdog?.stop();
    await client.close();
    tunnel?.close();
  }
}

/** Loads rooms: channels (c/p), direct conversations (d), and discussions. */
async function loadRooms(db: Db) {
  const channels = new Map<string, ChannelInfo>(); // roomId → ChannelInfo
  const directs = new Map<string, DirectInfo>(); // roomId → DirectInfo
  const discussions = new Map<string, DiscussionInfo>(); // roomId → parent+root
  const usedNames = new Set<string>();

  const cursor = db
    .collection<RcRoom>("rocketchat_room")
    .find({ t: { $in: ["c", "p", "d"] } });

  for await (const room of cursor) {
    if (room.t === "d") {
      directs.set(room._id, {
        members: room.usernames ?? [],
        uids: room.uids,
      });
      continue;
    }
    // A Discussion is re-parented into its parent channel as a thread (see
    // loadDiscussionRoots); it must not become a channel of its own.
    if (config.mergeDiscussions && room.prid) {
      discussions.set(room._id, {
        parentRoomId: room.prid,
        root: {
          msgId: `disc-${room._id}`, // fallback; replaced by the real message
          user: room.u?.username,
          msg: room.fname || room.name || "Discussion",
          ts: toEpochMs(room.ts),
        },
      });
      continue;
    }
    if (!room.name) {
      console.warn(`  ⚠️  Canal ${room._id} sans nom — ignoré.`);
      continue;
    }
    let name = sanitizeChannelName(room.name);
    // ensure channel-name uniqueness after normalization
    let suffix = 1;
    while (usedNames.has(name)) {
      name = `${name.slice(0, 60)}-${suffix++}`;
    }
    usedNames.add(name);

    channels.set(room._id, {
      name,
      display: (room.fname || room.name).slice(0, 64),
      type: room.t === "c" ? "O" : "P",
      topic: room.topic,
      description: room.description,
      archived: room.archived === true,
    });
  }
  return { channels, directs, discussions };
}

/**
 * Fills each discussion's real thread root from its `discussion-created` system
 * message (the message it was started from, living in the parent channel).
 * Discussions whose parent is not an exported channel are dropped.
 */
async function loadDiscussionRoots(
  db: Db,
  discussions: Map<string, DiscussionInfo>,
  channels: Map<string, ChannelInfo>,
) {
  const cursor = db
    .collection<RcMessage>("rocketchat_message")
    .find({ t: "discussion-created", drid: { $exists: true } });
  const quoted = new Map<string, string>(); // discussion room → original message id
  for await (const m of cursor) {
    const d = m.drid ? discussions.get(m.drid) : undefined;
    if (!d) continue;
    d.root = {
      msgId: m._id,
      user: m.u?.username,
      msg: (m.msg && m.msg.trim()) || d.root.msg,
      ts: toEpochMs(m.ts),
    };
    // A discussion started FROM a message quotes it (message_link "…?msg=<id>"):
    // thread onto that original message instead of duplicating its text.
    for (const a of m.attachments ?? []) {
      const id = /[?&]msg=([^&#]+)/.exec(a.message_link ?? "")?.[1];
      if (id) quoted.set(m.drid!, id);
    }
  }
  if (quoted.size) {
    const originals = await db
      .collection<RcMessage>("rocketchat_message")
      .find({ _id: { $in: [...quoted.values()] }, ...LIVE_USER_MESSAGE })
      .toArray();
    const byId = new Map(originals.map((o) => [o._id, o]));
    for (const [drid, id] of quoted) {
      const d = discussions.get(drid);
      const o = byId.get(id);
      if (!d || !o || o.rid !== d.parentRoomId) continue;
      // Mattermost threads have one level: if the original is itself a reply,
      // the discussion joins the thread it belongs to.
      d.root = { msgId: o.tmid ?? o._id, user: o.u?.username, msg: o.msg ?? d.root.msg, ts: toEpochMs(o.ts) };
    }
  }
  // Drop discussions whose parent channel is not exported (e.g. parent is a DM
  // or itself dropped): their messages fall back to being skipped.
  for (const [id, d] of discussions) {
    if (!channels.has(d.parentRoomId)) discussions.delete(id);
  }
}

/**
 * If a message belongs to a discussion, re-parents it into the discussion's
 * parent channel and threads it under the discussion root. Mutates and returns
 * the message.
 */
function remapDiscussion(
  msg: RcMessage,
  discussions: Map<string, DiscussionInfo>,
): RcMessage {
  const d = discussions.get(msg.rid);
  if (d) {
    msg.rid = d.parentRoomId;
    // Flatten any in-discussion sub-thread into the single discussion thread.
    msg.tmid = d.root.msgId;
  }
  return msg;
}

/**
 * Resolves the members of each direct conversation to valid Mattermost
 * usernames (falling back to the ghost user when gone), deduplicates, and drops
 * conversations with fewer than two distinct participants.
 */
function resolveDirects(
  directs: Map<string, DirectInfo>,
  usernameMap: Map<string, string>,
  usernameById: Map<string, string>,
  ghost: string,
) {
  for (const [roomId, di] of directs) {
    const resolved = new Set<string>();
    if (di.members?.length) {
      for (const n of di.members) resolved.add(usernameMap.get(n) ?? ghost);
    } else {
      // fallback: resolve by RocketChat id (already a Mattermost username)
      for (const id of di.uids ?? []) {
        resolved.add(usernameById.get(id) ?? ghost);
      }
    }

    if (resolved.size < 2) {
      // self-DM, or all participants gone → not importable
      directs.delete(roomId);
      continue;
    }
    di.members = [...resolved];
  }
}

/**
 * Mattermost lists a DM/group in a user's sidebar only through a
 * `direct_channel_show` / `group_channel_show` preference, which the bulk
 * import creates solely from `shown_by`. Without it, imported conversations
 * exist but stay invisible until reopened one by one. Mirror RocketChat: a
 * member sees the conversation if their subscription is open (`open` absent ⇒
 * open). Members without a subscription (rare, old data) see it too.
 */
async function loadDirectVisibility(
  db: Db,
  directs: Map<string, DirectInfo>,
  usernameMap: Map<string, string>,
  usernameById: Map<string, string>,
) {
  const hidden = new Map<string, Set<string>>(); // roomId → members who closed it
  const favorite = new Map<string, Set<string>>();
  const cursor = db
    .collection<RcSubscription>("rocketchat_subscription")
    .find({ t: "d" }, { projection: { rid: 1, u: 1, open: 1, f: 1 } });
  for await (const sub of cursor) {
    if (!directs.has(sub.rid)) continue;
    const mm = usernameById.get(sub.u._id) ?? usernameMap.get(sub.u.username);
    if (!mm) continue;
    const bucket = (m: Map<string, Set<string>>) => {
      let set = m.get(sub.rid);
      if (!set) m.set(sub.rid, (set = new Set()));
      set.add(mm);
    };
    if (sub.open === false) bucket(hidden);
    if (sub.f === true) bucket(favorite);
  }
  for (const [roomId, di] of directs) {
    const closed = hidden.get(roomId);
    di.shownBy = di.members.filter((m) => !closed?.has(m));
    const fav = favorite.get(roomId);
    di.favoritedBy = di.members.filter((m) => fav?.has(m));
  }
}

/**
 * Loads exportable users (username + email, excluding bots) and builds the
 * RocketChat username → normalized Mattermost username mapping (lowercase,
 * valid charset, guaranteed uniqueness).
 */
async function loadUsers(db: Db, existingUsersText?: string) {
  const users: RcUser[] = []; // each user gets a _mm field (target username)
  const usernameMap = new Map<string, string>(); // RC → MM
  const usernameById = new Map<string, string>(); // RC id → MM
  const usedMm = new Set<string>();

  const ghost = sanitizeUsername(config.ghostUsername);
  usedMm.add(ghost);

  // Accounts already in the target Mattermost: merge by email, reserve the rest.
  const existingByEmail = new Map<string, string>(); // email → MM username
  const existingText =
    existingUsersText ??
    (config.existingUsersFile && config.existingUsersFile !== "auto"
      ? readFileSync(config.existingUsersFile, "utf8")
      : "");
  if (existingText) {
    for (const line of existingText.split("\n")) {
      const [username, email] = line.trim().split(/\s+/);
      if (!username) continue;
      usedMm.add(username.toLowerCase());
      if (email) existingByEmail.set(email.toLowerCase(), username.toLowerCase());
    }
  }

  const uniqueMm = (raw: string): string => {
    const base = sanitizeUsername(raw);
    let mm = base;
    let n = 1;
    while (usedMm.has(mm)) mm = `${base.slice(0, 60)}-${n++}`;
    usedMm.add(mm);
    return mm;
  };

  const cursor = db.collection<RcUser>("users").find({});
  for await (const user of cursor) {
    if (user.type === "bot") continue;
    const email = user.emails?.[0]?.address;
    if (!user.username) {
      console.warn(`  ⚠️  Utilisateur ${user._id} sans username — ignoré.`);
      continue;
    }
    if (!email) {
      console.warn(`  ⚠️  Utilisateur "${user.username}" sans email — ignoré.`);
      continue;
    }
    const existing = existingByEmail.get(email.toLowerCase());
    if (existing) {
      existingByEmail.delete(email.toLowerCase()); // one RC user per account
      console.log(`  🔗 "${user.username}" fusionné dans le compte existant "${existing}" (${email}).`);
    }
    const mm = existing ?? uniqueMm(user.username);
    (user as RcUser & { _mm: string })._mm = mm;
    users.push(user);
    usernameMap.set(user.username, mm);
    usernameById.set(user._id, mm);
  }
  return { users, usernameMap, usernameById, ghost };
}

/** Builds channel membership from subscriptions. */
async function buildMemberships(
  db: Db,
  channels: Map<string, ChannelInfo>,
  usernameMap: Map<string, string>,
  reads: ReadTracker,
) {
  // Mattermost username → (channelName → roles)
  const userChannels = new Map<string, Map<string, string>>();

  // `username` is already a valid Mattermost username (resolved upstream).
  const add = (username: string, channelName: string, roles: string) => {
    let m = userChannels.get(username);
    if (!m) userChannels.set(username, (m = new Map()));
    // only overwrite an existing role to "upgrade" to admin
    const prev = m.get(channelName);
    if (!prev || roles.includes("channel_admin")) m.set(channelName, roles);
  };

  const cursor = db
    .collection<RcSubscription>("rocketchat_subscription")
    .find({ t: { $in: ["c", "p"] } });

  for await (const sub of cursor) {
    const ci = channels.get(sub.rid);
    if (!ci) continue;
    const mm = usernameMap.get(sub.u.username);
    if (!mm) continue; // member not exported
    const isAdmin =
      sub.roles?.includes("owner") || sub.roles?.includes("moderator");
    add(mm, ci.name, isAdmin ? "channel_admin channel_user" : "channel_user");
    if (sub.ls != null) reads.recordLastSeen(mm, ci.name, toEpochMs(sub.ls));
  }

  // exposed to be completed by message authors (scanMessages)
  (userChannels as MembershipMap).addMember = add;
  return userChannels as MembershipMap;
}

type MembershipMap = Map<string, Map<string, string>> & {
  addMember: (username: string, channelName: string, roles: string) => void;
};

/**
 * Walks all messages once to:
 *  - group thread replies by tmid,
 *  - ensure every message author is a member of its channel.
 */
async function scanMessages(
  db: Db,
  channels: Map<string, ChannelInfo>,
  directs: Map<string, DirectInfo>,
  discussions: Map<string, DiscussionInfo>,
  usernameMap: Map<string, string>,
  usernameById: Map<string, string>,
  ghost: string,
  userChannels: MembershipMap,
  threadReplies: Map<string, RcMessage[]>,
  reads: ReadTracker,
) {
  const cursor = db
    .collection<RcMessage>("rocketchat_message")
    .find(LIVE_USER_MESSAGE)
    .addCursorFlag("noCursorTimeout", true);

  for await (const msg of cursor) {
    await gate(); // watchdog pause (RocketChat host under pressure)
    remapDiscussion(msg, discussions);
    if (!hasContent(msg)) continue;

    const inChannel = channels.get(msg.rid);
    if (inChannel) {
      const author = resolveAuthor(msg, usernameMap, usernameById, ghost);
      userChannels.addMember(author, inChannel.name, "channel_user");
      reads.recordPost(inChannel.name, toEpochMs(msg.ts), !msg.tmid);
    } else if (!directs.has(msg.rid)) {
      continue; // unknown room (livechat, deleted…)
    }

    if (config.exportThreads && msg.tmid) {
      let arr = threadReplies.get(msg.tmid);
      if (!arr) threadReplies.set(msg.tmid, (arr = []));
      arr.push(msg);
    }
  }

  // chronological sort of the replies within each thread
  for (const arr of threadReplies.values()) {
    arr.sort((a, b) => toEpochMs(a.ts) - toEpochMs(b.ts));
  }
}


/** Writes the `user` blocks with their channel memberships embedded. */
function writeUsers(
  writer: JsonlWriter,
  users: RcUser[],
  userChannels: MembershipMap,
  ghost: string,
  reads: ReadTracker,
  avatarMap: Map<string, string>,
) {
  const teamRoles = (admin: boolean) =>
    admin ? "team_admin team_user" : "team_user";

  const channelsOf = (username: string): MmChannelMembership[] =>
    [...(userChannels.get(username)?.entries() ?? [])].map(([name, roles]) => ({
      name,
      roles,
      ...reads.membershipFields(username, name),
    }));

  for (const user of users) {
    const mm = (user as RcUser & { _mm: string })._mm;
    const admin = !!user.roles?.includes("admin");
    const { first, last } = splitName(user.name);
    const nickname = user.nickname?.trim();
    const locale = normalizeLocale(user.language);
    const profileImage = avatarMap.get(mm);
    writer.write({
      type: "user",
      user: {
        username: mm,
        email: user.emails![0].address,
        roles: admin ? "system_admin system_user" : "system_user",
        first_name: first,
        last_name: last,
        ...(nickname ? { nickname: nickname.slice(0, 64) } : {}),
        ...(locale ? { locale } : {}),
        ...(profileImage ? { profile_image: profileImage } : {}),
        ...(config.authService
          ? {
              auth_service: config.authService,
              auth_data: user.emails![0].address.toLowerCase(),
            }
          : {}),
        teams: config.exportMemberships
          ? [
              {
                name: config.teamName,
                roles: teamRoles(admin),
                channels: channelsOf(mm),
              },
            ]
          : [],
      },
    });
  }

  // Ghost user — only meaningful as a post author, so skip it in a
  // metadata-only export (no memberships, no posts).
  if (config.exportMemberships) {
    writer.write({
      type: "user",
      user: {
        username: ghost,
        email: config.ghostEmail,
        roles: "system_user",
        first_name: "Utilisateur",
        last_name: "Archivé",
        teams: [
          {
            name: config.teamName,
            roles: "team_user",
            channels: channelsOf(ghost),
          },
        ],
      },
    });
  }
}

/** Second pass: writes posts and direct_posts (roots + threads). */
async function writePosts(
  db: Db,
  writer: JsonlWriter,
  channels: Map<string, ChannelInfo>,
  directs: Map<string, DirectInfo>,
  discussions: Map<string, DiscussionInfo>,
  usernameMap: Map<string, string>,
  usernameById: Map<string, string>,
  ghost: string,
  threadReplies: Map<string, RcMessage[]>,
  fileExporter: FileExporter | null,
  counts: {
    posts: number;
    directPosts: number;
    orphanReplies: number;
    pinned: number;
    flagged: number;
    discussions?: number;
  },
) {
  const seenRoots = new Set<string>();

  const buildReplies = async (rootId: string): Promise<MmReply[]> => {
    const arr = threadReplies.get(rootId);
    if (!arr?.length) return [];
    const out: MmReply[] = [];
    for (const r of arr) {
      const author = resolveAuthor(r, usernameMap, usernameById, ghost);
      const message = buildMessage(r, usernameMap);
      const extras = await reactionsAndFiles(r, author, usernameMap, usernameById, ghost, fileExporter);
      if (!message && !extras.attachments?.length) continue; // empty reply
      out.push({
        user: author,
        message,
        create_at: toEpochMs(r.ts),
        ...extras,
      });
    }
    return out;
  };

  // roots + threadless messages, in chronological order.
  // noCursorTimeout: this cursor stays open while each post's attachments are
  // downloaded from GridFS (can exceed the server's 10-min idle cursor reaping).
  // Streaming (not toArray) keeps memory low — important when running on the
  // source host. Per-file downloads below are individually retried/skipped.
  const cursor = db
    .collection<RcMessage>("rocketchat_message")
    .find({ ...LIVE_USER_MESSAGE, tmid: { $exists: false } })
    .addCursorFlag("noCursorTimeout", true)
    .sort({ ts: 1 });

  for await (const msg of cursor) {
    await gate(); // watchdog pause (RocketChat host under pressure)
    // A discussion message has no tmid in RocketChat, so it lands in this root
    // cursor; re-parenting turns it into a reply handled via buildReplies.
    remapDiscussion(msg, discussions);
    if (msg.tmid) continue;
    if (!hasContent(msg)) continue;
    seenRoots.add(msg._id);

    const author = resolveAuthor(msg, usernameMap, usernameById, ghost);
    const message = buildMessage(msg, usernameMap);
    const createAt = toEpochMs(msg.ts);
    const extras = await reactionsAndFiles(msg, author, usernameMap, usernameById, ghost, fileExporter);
    if (extras.is_pinned) counts.pinned++;
    if (extras.flagged_by) counts.flagged += extras.flagged_by.length;
    const replies = config.exportThreads ? await buildReplies(msg._id) : [];

    // Do not create an empty post (e.g. missing file and no caption)
    if (!message && !extras.attachments?.length && !replies.length) continue;

    const ci = channels.get(msg.rid);
    if (ci) {
      writer.write({
        type: "post",
        post: {
          team: config.teamName,
          channel: ci.name,
          user: author,
          message,
          create_at: createAt,
          ...extras,
          ...(replies.length ? { replies } : {}),
        },
      });
      counts.posts++;
      continue;
    }

    if (config.exportDirect) {
      const di = directs.get(msg.rid);
      if (di) {
        writer.write({
          type: "direct_post",
          direct_post: {
            channel_members: di.members,
            user: author,
            message,
            create_at: createAt,
            ...extras,
            ...(replies.length ? { replies } : {}),
          },
        });
        counts.directPosts++;
      }
    }
  }

  // Discussion roots: the "discussion-created" message becomes a normal post in
  // the parent channel, carrying the discussion's messages as its thread.
  for (const d of discussions.values()) {
    const ci = channels.get(d.parentRoomId);
    if (!ci) continue;
    const rootId = d.root.msgId;
    if (seenRoots.has(rootId)) continue;
    const replies = config.exportThreads ? await buildReplies(rootId) : [];
    const message = defuseMentions(d.root.msg ?? "", usernameMap);
    if (!message && !replies.length) continue;
    const author = (d.root.user && usernameMap.get(d.root.user)) || ghost;
    seenRoots.add(rootId);
    writer.write({
      type: "post",
      post: {
        team: config.teamName,
        channel: ci.name,
        user: author,
        message,
        create_at: d.root.ts,
        ...(replies.length ? { replies } : {}),
      },
    });
    counts.posts++;
    if (counts.discussions !== undefined) counts.discussions++;
  }

  // Orphan replies (root deleted / system) → standalone messages
  if (config.exportThreads) {
    for (const [rootId, arr] of threadReplies) {
      if (seenRoots.has(rootId)) continue;
      for (const r of arr) {
        if (!hasContent(r)) continue;
        const author = resolveAuthor(r, usernameMap, usernameById, ghost);
        const message = buildMessage(r, usernameMap);
        const createAt = toEpochMs(r.ts);
        const extras = await reactionsAndFiles(r, author, usernameMap, usernameById, ghost, fileExporter);
        if (!message && !extras.attachments?.length) continue; // empty post
        const ci = channels.get(r.rid);
        if (ci) {
          writer.write({
            type: "post",
            post: {
              team: config.teamName,
              channel: ci.name,
              user: author,
              message,
              create_at: createAt,
              ...extras,
            },
          });
          counts.posts++;
          counts.orphanReplies++;
        } else if (config.exportDirect && directs.has(r.rid)) {
          writer.write({
            type: "direct_post",
            direct_post: {
              channel_members: directs.get(r.rid)!.members,
              user: author,
              message,
              create_at: createAt,
              ...extras,
            },
          });
          counts.directPosts++;
          counts.orphanReplies++;
        }
      }
    }
  }
}

/** Normalizes a RocketChat language ("fr", "pt-BR") to a Mattermost locale. */
function normalizeLocale(lang: string | undefined): string | undefined {
  const m = /^([a-zA-Z]{2})/.exec((lang ?? "").trim());
  return m ? m[1].toLowerCase() : undefined;
}

/** A message's reactions, attachments, pin and flag state, in Mattermost format. */
async function reactionsAndFiles(
  msg: RcMessage,
  _author: string,
  usernameMap: Map<string, string>,
  usernameById: Map<string, string>,
  ghost: string,
  fileExporter: FileExporter | null,
): Promise<{
  reactions?: MmReaction[];
  attachments?: MmAttachment[];
  is_pinned?: boolean;
  flagged_by?: string[];
}> {
  const out: {
    reactions?: MmReaction[];
    attachments?: MmAttachment[];
    is_pinned?: boolean;
    flagged_by?: string[];
  } = {};

  if (config.exportPins && msg.pinned) out.is_pinned = true;

  if (config.exportStars && msg.starred?.length) {
    const flagged = [
      ...new Set(
        msg.starred
          .map((s) => usernameById.get(s._id))
          .filter((u): u is string => !!u),
      ),
    ];
    if (flagged.length) out.flagged_by = flagged;
  }

  if (config.exportReactions) {
    const reactions = convertReactions(
      msg.reactions,
      usernameMap,
      ghost,
      toEpochMs(msg.ts),
    );
    if (reactions.length) out.reactions = reactions;
  }

  if (fileExporter && (msg.file || msg.files?.length)) {
    const attachments = await fileExporter.exportAll(msg.file, msg.files);
    if (attachments.length) out.attachments = attachments;
  }
  return out;
}

/** Builds a post's text: message + file caption, with mentions processed. */
function buildMessage(msg: RcMessage, usernameMap: Map<string, string>): string {
  return defuseMentions(
    combineMessage(msg.msg, extractCaption(msg.attachments)),
    usernameMap,
  );
}

/** Does a message carry exportable content (text, caption or file)? */
function hasContent(msg: RcMessage): boolean {
  return (
    !!(msg.msg && msg.msg.trim()) ||
    !!msg.file ||
    !!msg.files?.length ||
    !!extractCaption(msg.attachments)
  );
}

/** Determines the Mattermost author, falling back to the ghost user. */
function resolveAuthor(
  msg: RcMessage,
  usernameMap: Map<string, string>,
  usernameById: Map<string, string>,
  ghost: string,
): string {
  const direct = msg.u?.username;
  const mm = direct ? usernameMap.get(direct) : undefined;
  if (mm) return mm;
  const byId = usernameById.get(msg.u?._id); // already a Mattermost username
  if (byId) return byId;
  return ghost;
}