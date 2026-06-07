import { mkdir, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import * as path from "node:path";
import { Db, MongoClient } from "mongodb";
import { config } from "./config.js";
import { FileExporter } from "./files.js";
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

interface ChannelInfo {
  name: string; // normalized Mattermost name
  display: string;
  type: "O" | "P";
  topic?: string;
  description?: string;
}

interface DirectInfo {
  members: string[]; // Mattermost usernames (resolved)
  uids?: string[]; // RocketChat ids, fallback when usernames are missing
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

export async function runExport() {
  console.log("🚀 Migration RocketChat → Mattermost\n");
  const client = new MongoClient(config.mongoUri);
  await client.connect();
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
    const { channels, directs } = await loadRooms(db);
    console.log(
      `📁 ${channels.size} canaux, ${directs.size} conversations directes.`,
    );

    // ----- 2. Users -----
    const { users, usernameMap, usernameById, ghost } = await loadUsers(db);
    console.log(`👤 ${users.length} utilisateurs exportables.`);

    // Resolve direct-conversation members
    if (config.exportDirect) {
      resolveDirects(directs, usernameMap, usernameById, ghost);
      console.log(`💬 ${directs.size} conversations directes retenues.`);
    } else {
      directs.clear();
    }

    // ----- 3. Memberships (subscriptions + authors) -----
    const reads = new ReadTracker();
    const userChannels = await buildMemberships(db, channels, usernameMap, reads);

    // ----- 4. Threads + author-derived membership -----
    const threadReplies = new Map<string, RcMessage[]>();
    if (config.exportThreads || config.exportPosts) {
      await scanMessages(
        db,
        channels,
        directs,
        usernameMap,
        usernameById,
        ghost,
        userChannels,
        threadReplies,
        reads,
      );
    }
    reads.finalize();

    // ----- 5. Write entities (order: version → team → channels → users → direct_channels) -----
    writer.write({ type: "version", version: 1 });
    writer.write({
      type: "team",
      team: {
        name: config.teamName,
        display_name: config.teamDisplayName,
        type: "O",
      },
    });

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
          ...(config.archiveChannels ? { deleted_at: reads.archiveAt } : {}),
        },
      });
    }

    writeUsers(writer, users, userChannels, ghost, reads);

    if (config.exportDirect) {
      for (const di of directs.values()) {
        writer.write({
          type: "direct_channel",
          direct_channel: { members: di.members },
        });
      }
    }

    // ----- 6. Messages (posts + direct_posts) -----
    const counts = { posts: 0, directPosts: 0, orphanReplies: 0 };
    if (config.exportPosts) {
      await writePosts(
        db,
        writer,
        channels,
        directs,
        usernameMap,
        usernameById,
        ghost,
        threadReplies,
        fileExporter,
        counts,
      );
    }

    await writer.close();

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
    if (config.archiveChannels) {
      console.log(`   • canaux marqués comme archivés (deleted_at)`);
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
    await client.close();
  }
}

/** Loads rooms: channels (c/p) and direct conversations (d). */
async function loadRooms(db: Db) {
  const channels = new Map<string, ChannelInfo>(); // roomId → ChannelInfo
  const directs = new Map<string, DirectInfo>(); // roomId → DirectInfo
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
    });
  }
  return { channels, directs };
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
 * Loads exportable users (username + email, excluding bots) and builds the
 * RocketChat username → normalized Mattermost username mapping (lowercase,
 * valid charset, guaranteed uniqueness).
 */
async function loadUsers(db: Db) {
  const users: RcUser[] = []; // each user gets a _mm field (target username)
  const usernameMap = new Map<string, string>(); // RC → MM
  const usernameById = new Map<string, string>(); // RC id → MM
  const usedMm = new Set<string>();

  const ghost = sanitizeUsername(config.ghostUsername);
  usedMm.add(ghost);

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
    const mm = uniqueMm(user.username);
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
  usernameMap: Map<string, string>,
  usernameById: Map<string, string>,
  ghost: string,
  userChannels: MembershipMap,
  threadReplies: Map<string, RcMessage[]>,
  reads: ReadTracker,
) {
  const cursor = db
    .collection<RcMessage>("rocketchat_message")
    .find({ t: { $exists: false } });

  for await (const msg of cursor) {
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
    writer.write({
      type: "user",
      user: {
        username: mm,
        email: user.emails![0].address,
        roles: admin ? "system_admin system_user" : "system_user",
        first_name: first,
        last_name: last,
        teams: [
          {
            name: config.teamName,
            roles: teamRoles(admin),
            channels: channelsOf(mm),
          },
        ],
      },
    });
  }

  // Ghost user
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

/** Second pass: writes posts and direct_posts (roots + threads). */
async function writePosts(
  db: Db,
  writer: JsonlWriter,
  channels: Map<string, ChannelInfo>,
  directs: Map<string, DirectInfo>,
  usernameMap: Map<string, string>,
  usernameById: Map<string, string>,
  ghost: string,
  threadReplies: Map<string, RcMessage[]>,
  fileExporter: FileExporter | null,
  counts: { posts: number; directPosts: number; orphanReplies: number },
) {
  const seenRoots = new Set<string>();

  const buildReplies = async (rootId: string): Promise<MmReply[]> => {
    const arr = threadReplies.get(rootId);
    if (!arr?.length) return [];
    const out: MmReply[] = [];
    for (const r of arr) {
      const author = resolveAuthor(r, usernameMap, usernameById, ghost);
      const message = buildMessage(r, usernameMap);
      const extras = await reactionsAndFiles(r, author, usernameMap, ghost, fileExporter);
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

  // roots + threadless messages, in chronological order
  const cursor = db
    .collection<RcMessage>("rocketchat_message")
    .find({ t: { $exists: false }, tmid: { $exists: false } })
    .sort({ ts: 1 });

  for await (const msg of cursor) {
    if (!hasContent(msg)) continue;
    seenRoots.add(msg._id);

    const author = resolveAuthor(msg, usernameMap, usernameById, ghost);
    const message = buildMessage(msg, usernameMap);
    const createAt = toEpochMs(msg.ts);
    const extras = await reactionsAndFiles(msg, author, usernameMap, ghost, fileExporter);
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

  // Orphan replies (root deleted / system) → standalone messages
  if (config.exportThreads) {
    for (const [rootId, arr] of threadReplies) {
      if (seenRoots.has(rootId)) continue;
      for (const r of arr) {
        if (!hasContent(r)) continue;
        const author = resolveAuthor(r, usernameMap, usernameById, ghost);
        const message = buildMessage(r, usernameMap);
        const createAt = toEpochMs(r.ts);
        const extras = await reactionsAndFiles(r, author, usernameMap, ghost, fileExporter);
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

/** A message's reactions + attachments, in Mattermost format. */
async function reactionsAndFiles(
  msg: RcMessage,
  _author: string,
  usernameMap: Map<string, string>,
  ghost: string,
  fileExporter: FileExporter | null,
): Promise<{ reactions?: MmReaction[]; attachments?: MmAttachment[] }> {
  const out: { reactions?: MmReaction[]; attachments?: MmAttachment[] } = {};

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
