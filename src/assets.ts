// SPDX-License-Identifier: AGPL-3.0-or-later
import { createWriteStream } from "node:fs";
import { mkdir, readFile, rm } from "node:fs/promises";
import * as path from "node:path";
import { pipeline } from "node:stream/promises";
import { Collection, Db, Document, GridFSBucket, ObjectId } from "mongodb";
import type { RcAvatar, RcCustomEmoji } from "./types.js";
import { retryTransient } from "./util.js";

// Mattermost's default MaxImageResolution (7680×4320). Images above this are
// rejected by SetProfileImage / emoji creation and abort the whole import job.
const MAX_IMAGE_PIXELS = 7680 * 4320;

/**
 * Reads an image's format and dimensions from its header (PNG, JPEG, GIF only —
 * the formats Mattermost's Go decoder accepts). Returns null for anything it
 * cannot parse, so undecodable/exotic files (WebP, SVG, corrupt) are skipped
 * instead of failing the import.
 */
function probeImage(
  buf: Buffer,
): { width: number; height: number } | null {
  // PNG: 89 50 4E 47 0D 0A 1A 0A, IHDR width/height at bytes 16..23 (BE).
  if (
    buf.length >= 24 &&
    buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47
  ) {
    return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
  }
  // GIF: "GIF87a"/"GIF89a", width/height at bytes 6..9 (LE).
  if (buf.length >= 10 && buf.toString("ascii", 0, 3) === "GIF") {
    return { width: buf.readUInt16LE(6), height: buf.readUInt16LE(8) };
  }
  // JPEG: FFD8, then scan for a Start-Of-Frame marker.
  if (buf.length >= 4 && buf[0] === 0xff && buf[1] === 0xd8) {
    let off = 2;
    while (off + 9 < buf.length) {
      if (buf[off] !== 0xff) {
        off++;
        continue;
      }
      const marker = buf[off + 1];
      // SOF0..SOF15 (excluding DHT/JPG/DAC 0xC4/0xC8/0xCC) carry dimensions.
      if (
        marker >= 0xc0 && marker <= 0xcf &&
        marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc
      ) {
        return {
          height: buf.readUInt16BE(off + 5),
          width: buf.readUInt16BE(off + 7),
        };
      }
      off += 2 + buf.readUInt16BE(off + 2); // skip this segment
    }
  }
  return null;
}

/** Validates a downloaded image; deletes it and returns false if unusable. */
async function validateImage(absPath: string, label: string): Promise<boolean> {
  let dim: { width: number; height: number } | null = null;
  try {
    // The header fits well within the first 64 KiB.
    const buf = await readFile(absPath);
    dim = probeImage(buf.subarray(0, Math.min(buf.length, 65536)));
  } catch {
    dim = null;
  }
  if (!dim) {
    console.warn(`  ⚠️  ${label} : format d'image non reconnu — ignoré.`);
    await rm(absPath, { force: true });
    return false;
  }
  if (dim.width * dim.height > MAX_IMAGE_PIXELS) {
    console.warn(
      `  ⚠️  ${label} : résolution ${dim.width}×${dim.height} trop élevée — ignoré.`,
    );
    await rm(absPath, { force: true });
    return false;
  }
  return true;
}

/** Maps a MIME type to a file extension (defaults to "png"). */
function extFromMime(mime: string | undefined, fallback = "png"): string {
  switch ((mime ?? "").toLowerCase()) {
    case "image/jpeg":
    case "image/jpg":
      return "jpg";
    case "image/png":
      return "png";
    case "image/gif":
      return "gif";
    case "image/webp":
      return "webp";
    case "image/svg+xml":
      return "svg";
    default:
      return fallback;
  }
}

/** GridFS ids may be plain strings or ObjectIds depending on the instance. */
function candidateIds(id: string): (ObjectId | string)[] {
  const out: (ObjectId | string)[] = [id];
  try {
    if (ObjectId.isValid(id) && new ObjectId(id).toString() === id) {
      out.push(new ObjectId(id));
    }
  } catch {
    /* ignore */
  }
  return out;
}

async function downloadGridfs(
  bucket: GridFSBucket,
  ids: (ObjectId | string)[],
  absPath: string,
  label: string,
): Promise<boolean> {
  await mkdir(path.dirname(absPath), { recursive: true });
  for (const id of ids) {
    try {
      await retryTransient(
        () =>
          pipeline(
            bucket.openDownloadStream(id as never),
            createWriteStream(absPath),
          ),
        label,
      );
      return true;
    } catch {
      /* try next id form */
    }
  }
  await rm(absPath, { force: true });
  return false;
}

/**
 * Extracts user avatars from RocketChat (collection `rocketchat_avatars`,
 * GridFS bucket of the same name) into `data/avatars/` and returns a map of
 * Mattermost username → relative `profile_image` path.
 */
export class AvatarExporter {
  private bucket: GridFSBucket;
  private avatars: Collection<Document>;
  private dataAbsDir: string;
  private exported = 0;
  private skipped = 0;

  constructor(db: Db, outDir: string, dataDir: string) {
    this.bucket = new GridFSBucket(db, { bucketName: "rocketchat_avatars" });
    this.avatars = db.collection("rocketchat_avatars");
    this.dataAbsDir = path.join(outDir, dataDir);
  }

  get stats() {
    return { exported: this.exported, skipped: this.skipped };
  }

  /** @param usernameById RocketChat user id → Mattermost username */
  async exportAll(
    usernameById: Map<string, string>,
  ): Promise<Map<string, string>> {
    const out = new Map<string, string>(); // mm username → relPath
    // Newest avatar last so it wins on duplicates.
    const cursor = this.avatars.find().sort({ _updatedAt: 1 });
    for await (const doc of cursor) {
      const a = doc as unknown as RcAvatar;
      const mm = usernameById.get(a.userId);
      if (!mm) {
        this.skipped++;
        continue;
      }
      const ext = extFromMime(a.type, "jpg");
      const fileName = `${mm}.${ext}`;
      const relPath = path.posix.join("avatars", fileName);
      const absPath = path.join(this.dataAbsDir, "avatars", fileName);
      const ok = await downloadGridfs(
        this.bucket,
        candidateIds(a._id),
        absPath,
        `avatar ${mm}`,
      );
      if (ok && (await validateImage(absPath, `avatar ${mm}`))) {
        out.set(mm, relPath);
        this.exported++;
      } else {
        this.skipped++;
      }
    }
    return out;
  }
}

/** Reduces a custom-emoji name to Mattermost's charset (lowercase, [a-z0-9_-+]). */
function sanitizeEmojiName(raw: string): string {
  return raw
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9_+-]/g, "")
    .slice(0, 64);
}

/**
 * Extracts custom emojis from RocketChat (collection `rocketchat_custom_emoji`,
 * GridFS bucket `custom_emoji`) into `data/emoji/` and returns the Mattermost
 * `emoji` import lines. Aliases are emitted as extra emojis sharing the image.
 */
export class EmojiExporter {
  private bucket: GridFSBucket;
  private emojis: Collection<Document>;
  private files: Collection<Document>;
  private dataAbsDir: string;
  private maxBytes: number;
  private exported = 0;
  private skipped = 0;

  constructor(db: Db, outDir: string, dataDir: string, maxBytes = 512 * 1024) {
    this.bucket = new GridFSBucket(db, { bucketName: "custom_emoji" });
    this.emojis = db.collection("rocketchat_custom_emoji");
    this.files = db.collection("custom_emoji.files");
    this.dataAbsDir = path.join(outDir, dataDir);
    this.maxBytes = maxBytes;
  }

  get stats() {
    return { exported: this.exported, skipped: this.skipped };
  }

  /** Locates the GridFS file for an emoji, trying the known naming schemes. */
  private async findFile(
    name: string,
    ext: string,
  ): Promise<{ id: string; length: number } | null> {
    // RocketChat has stored emoji files under both "<name>.<ext>" and the
    // url-encoded ":<name>:.<ext>" over the years.
    const candidates = [
      `${name}.${ext}`,
      `${encodeURIComponent(`:${name}:`)}.${ext}`,
      name,
    ];
    const doc = await this.files.findOne({ filename: { $in: candidates } });
    return doc ? { id: String(doc._id), length: Number(doc.length ?? 0) } : null;
  }

  async exportAll(): Promise<{ name: string; image: string }[]> {
    const out: { name: string; image: string }[] = [];
    const seen = new Set<string>(); // dedup emoji names (incl. aliases)

    const cursor = this.emojis.find();
    for await (const doc of cursor) {
      const e = doc as unknown as RcCustomEmoji;
      const primary = sanitizeEmojiName(e.name);
      if (!primary) {
        this.skipped++;
        continue;
      }
      const ext = (e.extension || "png").toLowerCase();
      const file = await this.findFile(e.name, ext);
      if (!file) {
        this.skipped++;
        continue;
      }
      // Mattermost rejects oversized emoji images (a single one aborts the whole
      // import job), so skip anything above the safe cap — typically a few heavy
      // animated GIFs. See EMOJI_MAX_BYTES.
      if (file.length > this.maxBytes) {
        console.warn(
          `  ⚠️  Émoji "${primary}" ignoré (${Math.round(file.length / 1024)} Ko > ${Math.round(this.maxBytes / 1024)} Ko).`,
        );
        this.skipped++;
        continue;
      }
      const fileName = `${primary}.${ext}`;
      const relPath = path.posix.join("emoji", fileName);
      const absPath = path.join(this.dataAbsDir, "emoji", fileName);
      const ok = await downloadGridfs(
        this.bucket,
        candidateIds(file.id),
        absPath,
        `emoji ${primary}`,
      );
      if (!ok || !(await validateImage(absPath, `emoji ${primary}`))) {
        this.skipped++;
        continue;
      }
      this.exported++;
      // Primary + aliases, all pointing at the same image; skip name clashes.
      for (const raw of [e.name, ...(e.aliases ?? [])]) {
        const nm = sanitizeEmojiName(raw);
        if (!nm || seen.has(nm)) continue;
        seen.add(nm);
        out.push({ name: nm, image: relPath });
      }
    }
    return out;
  }
}
