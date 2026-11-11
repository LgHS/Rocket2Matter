// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Integration test: starts an in-memory MongoDB, seeds a fake RocketChat
 * database, runs the real export (src/cli.ts) and checks the produced JSONL.
 *
 *   pnpm tsx test/run.ts
 */
import { execFile } from "node:child_process";
import { readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { MongoClient, GridFSBucket } from "mongodb";
import { MongoMemoryServer } from "mongodb-memory-server";
import { Readable } from "node:stream";
import type { MmLine } from "../src/types.js";

const exec = promisify(execFile);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

let failures = 0;
function check(cond: boolean, label: string) {
  if (cond) {
    console.log(`  ✅ ${label}`);
  } else {
    console.error(`  ❌ ${label}`);
    failures++;
  }
}

async function seed(uri: string, dbName: string) {
  const client = new MongoClient(uri);
  await client.connect();
  const db = client.db(dbName);

  await db.collection("users").insertMany([
    { _id: "u1", username: "alice", name: "Alice Martin", nickname: "Ali", language: "fr-BE", active: true, emails: [{ address: "alice@x.fr" }], roles: ["admin", "user"] },
    { _id: "u2", username: "Bob", name: "Bob Durand", emails: [{ address: "bob@x.fr" }], roles: ["user"] },
    { _id: "u3", username: "noemail", name: "Sans Email", roles: ["user"] }, // skipped (no email)
    { _id: "u4", username: "robot", emails: [{ address: "r@x.fr" }], type: "bot" }, // skipped (bot)
  ] as never);

  await db.collection("rocketchat_room").insertMany([
    { _id: "r1", t: "c", name: "Général", fname: "Général", topic: "Salon principal, voir aussi #Général", description: "Annonces : #général, l&#39;essentiel &amp; plus" },
    { _id: "r2", t: "p", name: "Projet Secret", archived: true },
    { _id: "r3", t: "d", usernames: ["alice", "Bob"], uids: ["u1", "u2"] },
    // Discussion (child of r1): must NOT become a channel; its messages become
    // a thread in r1 rooted at the "discussion-created" message.
    { _id: "r5", t: "c", name: "kdi38fjssla", fname: "Sujet de discussion", prid: "r1", ts: new Date("2024-01-06T09:00:00Z"), u: { _id: "u1", username: "alice" } },
  ] as never);

  await db.collection("rocketchat_subscription").insertMany([
    { _id: "s1", rid: "r1", t: "c", u: { _id: "u1", username: "alice" }, roles: ["owner"], ls: new Date("2024-01-01T10:02:00Z") },
    { _id: "s2", rid: "r1", t: "c", u: { _id: "u2", username: "Bob" } },
    // RC shows r2 as unread for alice (alert + 2 unread, 1 mention)
    { _id: "s3", rid: "r2", t: "p", u: { _id: "u1", username: "alice" }, alert: true, unread: 2, userMentions: 1, ls: new Date("2024-01-02T08:05:00Z") },
    // DM alice↔bob shown as read in RC, although ls lags behind
    { _id: "s4", rid: "r3", t: "d", u: { _id: "u1", username: "alice" }, alert: false, unread: 0, ls: new Date("2024-01-01T00:00:00Z"), f: true },
    // bob closed the DM in RC (open: false) → not in his Mattermost sidebar
    { _id: "s5", rid: "r3", t: "d", u: { _id: "u2", username: "Bob" }, open: false, alert: false, unread: 0 },
  ] as never);

  await db.collection("rocketchat_message").insertMany([
    // thread root in r1
    { _id: "m1", rid: "r1", msg: "Bonjour @Bob et @inconnu", ts: new Date("2024-01-01T10:00:00Z"), u: { _id: "u1", username: "alice" }, reactions: { ":+1:": { usernames: ["Bob"] } }, pinned: true, starred: [{ _id: "u2" }] },
    // reply to thread m1
    { _id: "m2", rid: "r1", msg: "Salut Alice", ts: new Date("2024-01-01T10:05:00Z"), u: { _id: "u2", username: "Bob" }, tmid: "m1" },
    // system message (ignored)
    { _id: "m3", rid: "r1", msg: "a rejoint", t: "uj", ts: new Date("2024-01-01T09:00:00Z"), u: { _id: "u2", username: "Bob" } },
    // message from a gone author → ghost, in a channel they are not subscribed to (bob in r2)
    { _id: "m4", rid: "r2", msg: "Note interne", ts: new Date("2024-01-02T08:00:00Z"), u: { _id: "u99", username: "ghosty" } },
    { _id: "m5", rid: "r2", msg: "coucou", ts: new Date("2024-01-02T08:10:00Z"), u: { _id: "u2", username: "Bob" } },
    // edit history (Message_KeepHistory): previous versions of m1 (root),
    // m2 (reply) and m6 (DM), hidden, same ts as the original → never exported
    { _id: "h1", rid: "r1", msg: "Bonjour version 1", ts: new Date("2024-01-01T10:00:00Z"), u: { _id: "u1", username: "alice" }, _hidden: true, parent: "m1" },
    { _id: "h2", rid: "r1", msg: "Salut version 1", ts: new Date("2024-01-01T10:05:00Z"), u: { _id: "u2", username: "Bob" }, tmid: "m1", _hidden: true, parent: "m2" },
    { _id: "h6", rid: "r3", msg: "DM version 1", ts: new Date("2024-01-03T12:00:00Z"), u: { _id: "u1", username: "alice" }, _hidden: true, parent: "m6" },
    // channel links: #Général → ~general; hashtag, code and URL fragment untouched
    { _id: "m10", rid: "r1", msg: "Voir #Général. Pas #startup, ni `#define X`, ni https://x.be/a#général", ts: new Date("2024-01-01T11:00:00Z"), u: { _id: "u1", username: "alice" } },
    // direct message
    { _id: "m6", rid: "r3", msg: "DM privé", ts: new Date("2024-01-03T12:00:00Z"), u: { _id: "u1", username: "alice" } },
    // orphan reply (root does not exist)
    { _id: "m7", rid: "r1", msg: "réponse orpheline", ts: new Date("2024-01-04T12:00:00Z"), u: { _id: "u1", username: "alice" }, tmid: "disparu" },
    // image + caption: empty msg, caption in attachments[].description,
    // files lists the original (f1) + a same-name copy (f1b) + a thumbnail (fthumb)
    {
      _id: "m8",
      rid: "r1",
      msg: "",
      ts: new Date("2024-01-05T09:00:00Z"),
      u: { _id: "u1", username: "alice" },
      file: { _id: "f1", name: "Caché à voir.png", type: "image/png" },
      files: [
        { _id: "f1", name: "Caché à voir.png", type: "image/png" },
        { _id: "f1b", name: "Caché à voir.png", type: "image/png" },
        { _id: "fthumb", name: "thumb-Caché à voir.png", type: "image/png" },
      ],
      attachments: [
        { type: "file", title_link: "/file-upload/f1/x.png", description: "Ma légende" },
      ],
    },
    // empty, non-importable message: missing file + no caption
    { _id: "m9", rid: "r1", msg: "", ts: new Date("2024-01-05T10:00:00Z"), u: { _id: "u1", username: "alice" }, file: { _id: "fmissing", name: "perdu.png", type: "image/png" }, files: [{ _id: "fmissing", name: "perdu.png", type: "image/png" }] },
    // Discussion linkage: the "discussion-created" system message (in r1) + the
    // discussion's own messages (in r5).
    // The discussion was started FROM bob's message mo1 (quoted via message_link).
    { _id: "mo1", rid: "r1", msg: "Sujet de discussion", ts: new Date("2024-01-06T08:30:00Z"), u: { _id: "u2", username: "Bob" } },
    { _id: "md0", rid: "r1", t: "discussion-created", drid: "r5", msg: "Sujet de discussion", ts: new Date("2024-01-06T09:00:00Z"), u: { _id: "u1", username: "alice" },
      attachments: [{ text: "Sujet de discussion", author_name: "Bob", message_link: "/channel/general?msg=mo1" }] },
    { _id: "md1", rid: "r5", msg: "Premier message discussion", ts: new Date("2024-01-06T09:01:00Z"), u: { _id: "u2", username: "Bob" } },
    { _id: "md2", rid: "r5", msg: "Deuxième message discussion", ts: new Date("2024-01-06T09:02:00Z"), u: { _id: "u1", username: "alice" } },
  ] as never);

  // Files in GridFS (rocketchat_uploads bucket) + metadata
  const bucket = new GridFSBucket(db, { bucketName: "rocketchat_uploads" });
  const putFile = (id: string) =>
    new Promise<void>((resolve, reject) => {
      Readable.from([Buffer.from("PNGDATA")])
        .pipe(bucket.openUploadStreamWithId(id as never, id))
        .on("finish", () => resolve())
        .on("error", reject);
    });
  await putFile("f1");
  await putFile("f1b");
  await putFile("fthumb");
  // (fmissing: deliberately absent from GridFS)
  await db.collection("rocketchat_uploads").insertMany([
    { _id: "f1" as never, name: "Caché à voir.png", type: "image/png", store: "GridFS:Uploads" },
    { _id: "f1b" as never, name: "Caché à voir.png", type: "image/png", store: "GridFS:Uploads" },
    { _id: "fthumb" as never, name: "thumb-Caché à voir.png", type: "image/png", store: "GridFS:Uploads" },
  ] as never);

  // Minimal but valid images (the exporter validates format + dimensions).
  const PNG_1x1 = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
    "base64",
  );
  const GIF_1x1 = Buffer.from(
    "R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7",
    "base64",
  );

  // Avatar for alice (bucket "rocketchat_avatars" + mapping collection)
  const avatarBucket = new GridFSBucket(db, { bucketName: "rocketchat_avatars" });
  await new Promise<void>((resolve, reject) => {
    Readable.from([PNG_1x1])
      .pipe(avatarBucket.openUploadStreamWithId("av1" as never, "av1"))
      .on("finish", () => resolve())
      .on("error", reject);
  });
  await db.collection("rocketchat_avatars").insertOne({
    _id: "av1" as never, userId: "u1", name: "alice", type: "image/png", store: "GridFS:Avatars",
  } as never);

  // Custom emoji "partyparrot" (+ alias "parrot"), bucket "custom_emoji"
  const emojiBucket = new GridFSBucket(db, { bucketName: "custom_emoji" });
  await new Promise<void>((resolve, reject) => {
    Readable.from([GIF_1x1])
      .pipe(emojiBucket.openUploadStreamWithId("em1" as never, "partyparrot.gif"))
      .on("finish", () => resolve())
      .on("error", reject);
  });
  await db.collection("rocketchat_custom_emoji").insertOne({
    _id: "e1" as never, name: "partyparrot", aliases: ["parrot"], extension: "gif",
  } as never);

  await client.close();
}

async function main() {
  console.log("🧪 Test d'intégration de la migration\n");
  const mongo = await MongoMemoryServer.create();
  const uri = mongo.getUri();
  const dbName = "rocketchat";
  const outDir = path.join(root, "test-out");

  try {
    await seed(uri, dbName);

    await exec("pnpm", ["tsx", "src/cli.ts", "export"], {
      cwd: root,
      env: {
        ...process.env,
        MONGO_URI: uri,
        DB_NAME: dbName,
        OUT_DIR: outDir,
        EXPORT_FILES: "true",
      },
    });

    const raw = await readFile(path.join(outDir, "import.jsonl"), "utf8");
    const lines = raw
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l) as MmLine);

    console.log(`\nVérifications (${lines.length} lignes) :`);

    const byType = (t: string) => lines.filter((l) => l.type === t);
    const users = byType("user") as Extract<MmLine, { type: "user" }>[];
    const channels = byType("channel") as Extract<MmLine, { type: "channel" }>[];
    const posts = byType("post") as Extract<MmLine, { type: "post" }>[];
    const directPosts = byType("direct_post") as Extract<MmLine, { type: "direct_post" }>[];
    const directChannels = byType("direct_channel");

    check(lines[0].type === "version", "première ligne = version");
    check(byType("team").length === 1, "une équipe");
    check(channels.length === 2, "2 canaux (c + p)");
    // alice, bob, ghost — not noemail nor robot
    check(users.length === 3, "3 utilisateurs (alice, bob, fantôme)");
    check(
      users.some((u) => u.user.username === "utilisateur-archive"),
      "utilisateur fantôme présent",
    );
    check(
      !users.some((u) => u.user.username === "noemail" || u.user.username === "robot"),
      "utilisateurs sans email / bots exclus",
    );

    const alice = users.find((u) => u.user.username === "alice")!;
    check(
      alice.user.roles.includes("system_admin"),
      "alice est system_admin",
    );
    const aliceChans = alice.user.teams[0].channels ?? [];
    check(
      aliceChans.some((c) => c.roles.includes("channel_admin")),
      "alice admin de canal (subscription owner)",
    );

    // "Bob" (RC) must be normalized to "bob" (Mattermost)
    check(
      users.some((u) => u.user.username === "bob") &&
        !users.some((u) => u.user.username === "Bob"),
      "username normalisé en minuscules (Bob → bob)",
    );

    // bob posted in r2 (projet-secret) without being subscribed → added as member
    const bob = users.find((u) => u.user.username === "bob")!;
    const bobChans = (bob.user.teams[0].channels ?? []).map((c) => c.name);
    check(
      bobChans.length >= 2,
      "bob membre de ≥2 canaux (dont celui via authorship)",
    );

    // thread: m1 has a reply m2 (author Bob → bob)
    const root1 = posts.find((p) => p.post.message.startsWith("Bonjour"))!;
    check(
      !!root1.post.replies?.length && root1.post.replies![0].user === "bob",
      "thread : réponse attachée au post racine (auteur normalisé)",
    );
    check(
      root1.post.message.includes("@bob") && root1.post.message.includes("inconnu") && !root1.post.message.includes("@inconnu") && !root1.post.message.includes("@Bob"),
      "mentions : @Bob réécrit en @bob, @inconnu désamorcé",
    );
    check(
      root1.post.reactions?.[0]?.user === "bob",
      "réaction : username normalisé (Bob → bob)",
    );
    check(
      !!root1.post.reactions?.some((r) => r.emoji_name === "+1"),
      "réaction +1 convertie",
    );

    // gone author → ghost
    const ghostPost = posts.find((p) => p.post.message === "Note interne")!;
    check(
      ghostPost.post.user === "utilisateur-archive",
      "auteur disparu remplacé par le fantôme",
    );

    // DM
    check(directChannels.length === 1, "1 conversation directe");
    {
      const dc = (directChannels[0] as Extract<MmLine, { type: "direct_channel" }>).direct_channel;
      check(
        JSON.stringify(dc.shown_by) === '["alice"]',
        "DM : shown_by = membres l'ayant ouvert dans RC (bob l'avait fermé)",
      );
      check(JSON.stringify(dc.favorited_by) === '["alice"]', "DM : favori RC → favorited_by");
    }
    check(
      directPosts.length === 1 && directPosts[0].direct_post.message === "DM privé",
      "1 message direct exporté",
    );

    // orphan reply reclassified
    check(
      posts.some((p) => p.post.message === "réponse orpheline"),
      "réponse orpheline reclassée en message",
    );
    // edit history: no previous version exported (root, reply or DM)
    check(
      !posts.some((p) => p.post.message.includes("version 1") || p.post.replies?.some((r) => r.message.includes("version 1"))),
      "historique d'édition (_hidden) ignoré : pas de doublon de post ni de réponse",
    );
    check(root1.post.replies?.length === 1, "thread : une seule réponse (pas de version éditée)");
    check(
      posts.some((p) => p.post.message === "Voir ~general. Pas #startup, ni `#define X`, ni https://x.be/a#général"),
      "lien de canal #Général → ~general (hashtag, code et URL intacts)",
    );
    {
      const gen = (byType("channel") as Extract<MmLine, { type: "channel" }>[]).find((c) => c.channel.name === "general")!;
      check(
        gen.channel.header === "Salon principal, voir aussi ~general" && gen.channel.purpose === "Annonces : ~general, l'essentiel & plus",
        "en-tête/description : liens de canal convertis, entités HTML décodées",
      );
    }
    // m3 (system) absent
    check(
      !posts.some((p) => p.post.message.includes("a rejoint")),
      "message système ignoré",
    );

    // GridFS attachment
    const filePost = posts.find((p) => p.post.attachments?.length);
    const att = filePost?.post.attachments?.[0];
    check(!!att, "pièce jointe présente sur un post");
    check(
      !!att && !att.path.startsWith("data/"),
      "chemin d'attachement SANS préfixe data/ (préfixé par Mattermost)",
    );
    check(
      !!att && att.path === "f1/Cache a voir.png",
      "nom de fichier translittéré en ASCII (Caché à voir → Cache a voir)",
    );
    check(
      !!att && existsSync(path.join(outDir, "data", att.path)),
      "fichier extrait sous data/<id>/<nom>",
    );
    // caption taken from attachments[].description
    check(
      filePost?.post.message === "Ma légende",
      "légende (attachments.description) reprise comme texte du post",
    );
    // dedup (f1 == f1b) + thumbnail (fthumb) skipped
    check(
      filePost?.post.attachments?.length === 1,
      "doublon dédupliqué et miniature (thumb-) ignorée → 1 seule pièce jointe",
    );
    // empty post (missing file, no caption) not created
    check(
      !posts.some((p) => p.post.create_at === new Date("2024-01-05T10:00:00Z").getTime()),
      "post vide (fichier introuvable, sans texte) ignoré",
    );

    // ----- Avatars / emojis / nickname / locale / pins / stars -----
    check(alice.user.nickname === "Ali", "nickname exporté (Ali)");
    check(alice.user.locale === "fr", "locale normalisée (fr-BE → fr)");
    check(
      alice.user.profile_image === "avatars/alice.png" &&
        existsSync(path.join(outDir, "data", "avatars", "alice.png")),
      "avatar extrait + profile_image sans préfixe data/",
    );

    const emojis = byType("emoji") as Extract<MmLine, { type: "emoji" }>[];
    const parrot = emojis.find((e) => e.emoji.name === "partyparrot");
    check(!!parrot, "émoji personnalisé exporté (partyparrot)");
    check(
      !!parrot && parrot.emoji.image === "emoji/partyparrot.gif" &&
        existsSync(path.join(outDir, "data", "emoji", "partyparrot.gif")),
      "image émoji extraite sous data/emoji/<nom>",
    );
    check(
      emojis.some((e) => e.emoji.name === "parrot"),
      "alias d'émoji exporté (parrot → même image)",
    );

    // per-channel archive: r2 (archived in RC) → deleted_at, even without ARCHIVE_CHANNELS
    const secret = channels.find((c) => c.channel.name === "projet-secret");
    const general1 = channels.find((c) => c.channel.name === "general");
    check(
      (secret?.channel.deleted_at ?? 0) > 0 && !general1?.channel.deleted_at,
      "canal archivé RocketChat → deleted_at (sans ARCHIVE_CHANNELS)",
    );

    // discussion → thread: r5 is not a channel; its messages thread in general
    check(
      !channels.some((c) => c.channel.display_name === "Sujet de discussion"),
      "discussion : pas de canal créé pour la discussion",
    );
    const discRoots = posts.filter((p) => p.post.message === "Sujet de discussion");
    check(
      discRoots.length === 1 && discRoots[0].post.user === "bob",
      "discussion créée depuis un message : le fil s'accroche au message original (pas de doublon)",
    );
    const discRoot = discRoots[0];
    check(
      !!discRoot && discRoot.post.channel === "general",
      "discussion : message d'origine devient un post du canal parent",
    );
    check(
      !!discRoot?.post.replies?.some((r) => r.message === "Premier message discussion") &&
        !!discRoot?.post.replies?.some((r) => r.message === "Deuxième message discussion"),
      "discussion : messages rattachés en thread sous l'origine",
    );

    check(root1.post.is_pinned === true, "message épinglé : is_pinned");
    check(
      !!root1.post.flagged_by?.includes("bob"),
      "message favori : flagged_by (Bob → bob)",
    );

    // ----- Second export: archive + "last-seen" read-state options -----
    const outDir2 = path.join(root, "test-out2");
    // Accounts already in the target MM: bob's email → existing "robert"; "calls" reserved.
    const existingFile = path.join(root, "test-existing-users.txt");
    await writeFile(existingFile, "robert bob@x.fr\ncalls calls@localhost\n");
    await exec("pnpm", ["tsx", "src/cli.ts", "export"], {
      cwd: root,
      env: {
        ...process.env,
        MONGO_URI: uri,
        DB_NAME: dbName,
        OUT_DIR: outDir2,
        EXPORT_FILES: "false",
        ARCHIVE_CHANNELS: "true",
        READ_STATE: "last-seen",
        AUTH_SERVICE: "openid",
        EXISTING_USERS: existingFile,
      },
    });
    await rm(existingFile, { force: true });
    const lines2 = (await readFile(path.join(outDir2, "import.jsonl"), "utf8"))
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l) as MmLine);
    const readSql = existsSync(path.join(outDir2, "readstate.sql"))
      ? await readFile(path.join(outDir2, "readstate.sql"), "utf8")
      : "";
    await rm(outDir2, { recursive: true, force: true });
    await rm(`${outDir2}.state.json`, { force: true });

    const channels2 = lines2.filter((l) => l.type === "channel") as Extract<MmLine, { type: "channel" }>[];
    const users2 = lines2.filter((l) => l.type === "user") as Extract<MmLine, { type: "user" }>[];

    check(
      channels2.length > 0 && channels2.every((c) => (c.channel.deleted_at ?? 0) > 0),
      "ARCHIVE_CHANNELS : tous les canaux ont deleted_at",
    );

    const aliceGeneral = users2
      .find((u) => u.user.username === "alice")
      ?.user.teams[0].channels?.find((c) => c.name === "general");
    check(
      aliceGeneral?.last_viewed_at === new Date("2024-01-01T10:02:00Z").getTime(),
      "READ_STATE last-seen : last_viewed_at = ls RocketChat",
    );
    // posts in #general ≤ ls: only m1 (10:00); m2 (10:05) and m7 (later) unread
    check(
      aliceGeneral?.msg_count === 1,
      "READ_STATE last-seen : msg_count = nb de posts lus (1)",
    );

    // Per-user read state follows RC's displayed state (alert/unread), not ls
    check(
      /\('alice@x\.fr','C','general',\d+,true,0\)/.test(readSql),
      "readstate : canal lu dans RC (pas d'alert) → lu",
    );
    check(
      /\('alice@x\.fr','C','projet-secret',\d+,false,1\)/.test(readSql),
      "readstate : canal non lu dans RC → partiel, mentions reprises",
    );
    check(
      readSql.includes("('bob@x.fr','C','projet-secret',0,true,0)"),
      "readstate : membre par autorat seul (sans abonnement) → lu",
    );
    check(
      /\('alice@x\.fr','D','bob@x\.fr',\d+,true,0\)/.test(readSql),
      "readstate : DM lu dans RC malgré un ls en retard → lu",
    );

    const alice2 = users2.find((u) => u.user.username === "alice");
    check(
      alice2?.user.auth_service === "openid" && alice2?.user.auth_data === "alice@x.fr",
      "AUTH_SERVICE : auth_service=openid, auth_data=email",
    );
    check(
      users2.some((u) => u.user.username === "robert" && u.user.email === "bob@x.fr") &&
        !users2.some((u) => u.user.username === "bob"),
      "EXISTING_USERS : bob fusionné dans le compte existant robert (même email)",
    );

    console.log(
      failures === 0
        ? `\n🎉 Tous les tests passent.`
        : `\n💥 ${failures} test(s) en échec.`,
    );
  } finally {
    await rm(outDir, { recursive: true, force: true });
    await rm(`${outDir}.state.json`, { force: true });
    await mongo.stop();
  }
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error("❌ Test en erreur :", err);
  process.exit(1);
});