/**
 * Integration test: starts an in-memory MongoDB, seeds a fake RocketChat
 * database, runs the real export (src/cli.ts) and checks the produced JSONL.
 *
 *   pnpm tsx test/run.ts
 */
import { execFile } from "node:child_process";
import { readFile, rm } from "node:fs/promises";
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
    { _id: "u1", username: "alice", name: "Alice Martin", emails: [{ address: "alice@x.fr" }], roles: ["admin", "user"] },
    { _id: "u2", username: "Bob", name: "Bob Durand", emails: [{ address: "bob@x.fr" }], roles: ["user"] },
    { _id: "u3", username: "noemail", name: "Sans Email", roles: ["user"] }, // skipped (no email)
    { _id: "u4", username: "robot", emails: [{ address: "r@x.fr" }], type: "bot" }, // skipped (bot)
  ] as never);

  await db.collection("rocketchat_room").insertMany([
    { _id: "r1", t: "c", name: "Général", fname: "Général", topic: "Salon principal" },
    { _id: "r2", t: "p", name: "Projet Secret" },
    { _id: "r3", t: "d", usernames: ["alice", "Bob"], uids: ["u1", "u2"] },
  ] as never);

  await db.collection("rocketchat_subscription").insertMany([
    { _id: "s1", rid: "r1", t: "c", u: { _id: "u1", username: "alice" }, roles: ["owner"], ls: new Date("2024-01-01T10:02:00Z") },
    { _id: "s2", rid: "r1", t: "c", u: { _id: "u2", username: "Bob" } },
    { _id: "s3", rid: "r2", t: "p", u: { _id: "u1", username: "alice" } },
  ] as never);

  await db.collection("rocketchat_message").insertMany([
    // thread root in r1
    { _id: "m1", rid: "r1", msg: "Bonjour @Bob et @inconnu", ts: new Date("2024-01-01T10:00:00Z"), u: { _id: "u1", username: "alice" }, reactions: { ":+1:": { usernames: ["Bob"] } } },
    // reply to thread m1
    { _id: "m2", rid: "r1", msg: "Salut Alice", ts: new Date("2024-01-01T10:05:00Z"), u: { _id: "u2", username: "Bob" }, tmid: "m1" },
    // system message (ignored)
    { _id: "m3", rid: "r1", msg: "a rejoint", t: "uj", ts: new Date("2024-01-01T09:00:00Z"), u: { _id: "u2", username: "Bob" } },
    // message from a gone author → ghost, in a channel they are not subscribed to (bob in r2)
    { _id: "m4", rid: "r2", msg: "Note interne", ts: new Date("2024-01-02T08:00:00Z"), u: { _id: "u99", username: "ghosty" } },
    { _id: "m5", rid: "r2", msg: "coucou", ts: new Date("2024-01-02T08:10:00Z"), u: { _id: "u2", username: "Bob" } },
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
    check(
      directPosts.length === 1 && directPosts[0].direct_post.message === "DM privé",
      "1 message direct exporté",
    );

    // orphan reply reclassified
    check(
      posts.some((p) => p.post.message === "réponse orpheline"),
      "réponse orpheline reclassée en message",
    );
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

    // ----- Second export: archive + "last-seen" read-state options -----
    const outDir2 = path.join(root, "test-out2");
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
      },
    });
    const lines2 = (await readFile(path.join(outDir2, "import.jsonl"), "utf8"))
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l) as MmLine);
    await rm(outDir2, { recursive: true, force: true });

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

    console.log(
      failures === 0
        ? `\n🎉 Tous les tests passent.`
        : `\n💥 ${failures} test(s) en échec.`,
    );
  } finally {
    await rm(outDir, { recursive: true, force: true });
    await mongo.stop();
  }
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error("❌ Test en erreur :", err);
  process.exit(1);
});
