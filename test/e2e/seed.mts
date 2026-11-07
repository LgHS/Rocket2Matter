// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Seeds the e2e MongoDB with a small RocketChat dataset exercising every
 * feature: files, avatar, custom emoji, threads, discussion, archived channel,
 * DM + group DM, pins, stars, reactions, an inactive account, and per-user read
 * state (alert/unread/ls).
 */
import { Readable } from "node:stream";
import { GridFSBucket, MongoClient } from "mongodb";

const uri = process.env.MONGO_URI ?? "mongodb://127.0.0.1:27099/rocketchat";
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==", "base64");
const GIF = Buffer.from("R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7", "base64");
const d = (s: string) => new Date(`2024-03-01T${s}Z`);

async function put(db: import("mongodb").Db, bucket: string, id: string, name: string, data: Buffer) {
  const b = new GridFSBucket(db, { bucketName: bucket });
  await new Promise<void>((res, rej) =>
    Readable.from([data]).pipe(b.openUploadStreamWithId(id as never, name)).on("finish", () => res()).on("error", rej),
  );
}

const client = new MongoClient(uri);
await client.connect();
const db = client.db();
await db.dropDatabase();

await db.collection("users").insertMany([
  { _id: "u1", username: "Alice", name: "Alice Martin", emails: [{ address: "alice@e2e.test" }], roles: ["admin", "user"], active: true, language: "fr" },
  { _id: "u2", username: "bob", name: "Bob Durand", emails: [{ address: "bob@e2e.test" }], roles: ["user"], active: true, nickname: "Bobby" },
  { _id: "u3", username: "carol", name: "Carol Petit", emails: [{ address: "carol@e2e.test" }], roles: ["user"], active: true },
  { _id: "u4", username: "dave", name: "Dave Parti", emails: [{ address: "dave@e2e.test" }], roles: ["user"], active: false },
  { _id: "ubot", username: "rocket.cat", emails: [{ address: "cat@e2e.test" }], type: "bot" },
] as never);

await db.collection("rocketchat_room").insertMany([
  { _id: "r1", t: "c", name: "general", fname: "Général", topic: "Le salon principal" },
  { _id: "r2", t: "p", name: "vieux-projet", archived: true },
  { _id: "r3", t: "d", usernames: ["Alice", "bob"], uids: ["u1", "u2"] },
  { _id: "r4", t: "d", usernames: ["Alice", "bob", "carol"], uids: ["u1", "u2", "u3"] },
  { _id: "r5", t: "c", name: "x7Hk2discussion", fname: "On en parle ici ?", prid: "r1", ts: d("11:00:00"), u: { _id: "u2", username: "bob" } },
] as never);

await db.collection("rocketchat_subscription").insertMany([
  // Alice: general read (flags) although ls lags; vieux-projet read; DM read.
  { _id: "s1", rid: "r1", t: "c", u: { _id: "u1", username: "Alice" }, roles: ["owner"], alert: false, unread: 0, ls: d("09:00:00") },
  { _id: "s2", rid: "r2", t: "p", u: { _id: "u1", username: "Alice" }, alert: false, unread: 0 },
  { _id: "s3", rid: "r3", t: "d", u: { _id: "u1", username: "Alice" }, alert: false, unread: 0 },
  { _id: "s4", rid: "r4", t: "d", u: { _id: "u1", username: "Alice" }, alert: false, unread: 0 },
  // Bob: general UNREAD after 10:00 (the 10:30 message by Alice), with a mention.
  { _id: "s5", rid: "r1", t: "c", u: { _id: "u2", username: "bob" }, alert: true, unread: 1, userMentions: 1, ls: d("10:00:00") },
  { _id: "s6", rid: "r3", t: "d", u: { _id: "u2", username: "bob" }, alert: true, unread: 1, ls: d("09:00:00") },
  { _id: "s7", rid: "r4", t: "d", u: { _id: "u2", username: "bob" }, alert: false, unread: 0 },
  // Carol: never opened general (no ls, unread), group read but closed
  // from her sidebar (open: false → no group_channel_show).
  { _id: "s8", rid: "r1", t: "c", u: { _id: "u3", username: "carol" }, alert: true, unread: 3 },
  { _id: "s9", rid: "r4", t: "d", u: { _id: "u3", username: "carol" }, alert: false, unread: 0, open: false },
] as never);

await db.collection("rocketchat_message").insertMany([
  { _id: "m1", rid: "r1", msg: "Bienvenue à tous !", ts: d("08:00:00"), u: { _id: "u1", username: "Alice" }, pinned: true, starred: [{ _id: "u2" }],
    reactions: { ":tada:": { usernames: ["bob", "carol"] } } },
  { _id: "m2", rid: "r1", msg: "Merci !", ts: d("08:05:00"), u: { _id: "u2", username: "bob" }, tmid: "m1" },
  { _id: "m3", rid: "r1", msg: "", ts: d("09:30:00"), u: { _id: "u2", username: "bob" },
    file: { _id: "f1", name: "schéma.png", type: "image/png" }, files: [{ _id: "f1", name: "schéma.png", type: "image/png" }],
    attachments: [{ type: "file", description: "Le schéma du projet" }] },
  { _id: "m4", rid: "r1", msg: "@bob tu peux regarder ? :partyparrot:", ts: d("10:30:00"), u: { _id: "u1", username: "Alice" } },
  { _id: "m5", rid: "r1", t: "uj", msg: "a rejoint", ts: d("07:00:00"), u: { _id: "u3", username: "carol" } },
  { _id: "m6", rid: "r2", msg: "Projet terminé, on archive.", ts: d("08:10:00"), u: { _id: "u1", username: "Alice" } },
  { _id: "m7", rid: "r3", msg: "Salut Bob, en privé", ts: d("09:10:00"), u: { _id: "u1", username: "Alice" } },
  { _id: "m8", rid: "r4", msg: "Petit groupe !", ts: d("09:20:00"), u: { _id: "u3", username: "carol" } },
  { _id: "m9", rid: "r1", msg: "Message de Dave, parti depuis", ts: d("08:20:00"), u: { _id: "u4", username: "dave" } },
  // Discussion r5, started from a message in general
  { _id: "md0", rid: "r1", t: "discussion-created", drid: "r5", msg: "On en parle ici ?", ts: d("11:00:00"), u: { _id: "u2", username: "bob" } },
  { _id: "md1", rid: "r5", msg: "Oui, bonne idée", ts: d("11:01:00"), u: { _id: "u1", username: "Alice" } },
  { _id: "md2", rid: "r5", msg: "Je suis d'accord", ts: d("11:02:00"), u: { _id: "u3", username: "carol" } },
] as never);

await put(db, "rocketchat_uploads", "f1", "f1", PNG);
await db.collection("rocketchat_uploads").insertOne({ _id: "f1", name: "schéma.png", type: "image/png", store: "GridFS:Uploads" } as never);
await put(db, "rocketchat_avatars", "av1", "av1", PNG);
await db.collection("rocketchat_avatars").insertOne({ _id: "av1", userId: "u1", name: "Alice", type: "image/png", store: "GridFS:Avatars" } as never);
await put(db, "custom_emoji", "e1", "partyparrot.gif", GIF);
await db.collection("rocketchat_custom_emoji").insertOne({ _id: "e1", name: "partyparrot", aliases: ["parrot", "perroquet-fou"], extension: "gif" } as never);

await client.close();
console.log("✅ base RocketChat de test peuplée");
