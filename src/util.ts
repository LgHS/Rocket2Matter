import { createWriteStream, type WriteStream } from "node:fs";
import type { MmLine, MmReaction, RcAttachment, RcReactions } from "./types.js";

/**
 * Normalize a RocketChat channel name to Mattermost constraints:
 * lowercase, [a-z0-9-_], 2 to 64 characters, starting with an alphanumeric.
 */
export function sanitizeChannelName(raw: string): string {
  let name = raw
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "") // strip accents (diacritics)
    .replace(/\s+/g, "-")
    .replace(/[^a-z0-9-_]/g, "")
    .replace(/-+/g, "-")
    .replace(/^[-_]+/, "") // must start with an alphanumeric
    .slice(0, 64);

  if (name.length < 2) {
    name = (name + "-channel").slice(0, 64);
  }
  return name;
}

/**
 * Normalize a RocketChat username to Mattermost constraints:
 * lowercase, [a-z0-9._-] characters, starting with an alphanumeric.
 * Mattermost lowercases usernames on import; we pre-normalize so that both the
 * definitions AND the references (members, authors…) match.
 */
export function sanitizeUsername(raw: string): string {
  let u = raw
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "") // diacritics
    .replace(/[^a-z0-9._-]/g, "")
    .replace(/^[._-]+/, "")
    .slice(0, 64);
  return u.length ? u : "user";
}

/** Split "First Last name" into {first, last}. */
export function splitName(full?: string): { first: string; last: string } {
  const parts = (full ?? "").trim().split(/\s+/).filter(Boolean);
  const first = parts.shift() ?? "";
  return { first, last: parts.join(" ") };
}

/** Turn a RocketChat reaction key ":smile:" into "smile". */
export function emojiName(key: string): string {
  return key.replace(/^:|:$/g, "");
}

/**
 * Convert RocketChat reactions → Mattermost format, mapping RocketChat
 * usernames to their Mattermost equivalent (falling back to the ghost user).
 */
export function convertReactions(
  reactions: RcReactions | undefined,
  usernameMap: Map<string, string>,
  fallbackUser: string,
  createAt: number,
): MmReaction[] {
  if (!reactions) return [];
  const out: MmReaction[] = [];
  for (const [key, data] of Object.entries(reactions)) {
    const name = emojiName(key);
    if (!name) continue;
    for (const username of data.usernames ?? []) {
      out.push({
        user: usernameMap.get(username) ?? fallbackUser,
        emoji_name: name,
        create_at: createAt,
      });
    }
  }
  return out;
}

/**
 * Rewrite @user mentions to the normalized Mattermost username, and "defuse"
 * (drop the @) those that match no exported user, to avoid broken mentions in
 * Mattermost.
 */
export function defuseMentions(
  text: string,
  usernameMap: Map<string, string>,
): string {
  if (!text) return text;
  return text.replace(/@([a-zA-Z0-9._-]+)/g, (match, username: string) => {
    if (username === "all" || username === "here" || username === "channel") {
      return match; // keep special mentions
    }
    const mm = usernameMap.get(username);
    return mm ? "@" + mm : username;
  });
}

/**
 * Extract the caption of a RocketChat file message. Files uploaded with a
 * comment have an empty `msg` and the caption in `attachments[].description`.
 * Only file-type attachments (title_link/image_url/type=file) are considered,
 * to avoid picking up the text of message quotes.
 */
export function extractCaption(attachments: RcAttachment[] | undefined): string {
  if (!attachments?.length) return "";
  const parts: string[] = [];
  for (const a of attachments) {
    const isFile = !!(a.title_link || a.image_url || a.type === "file");
    const isQuote = !!(a.author_name || a.message_link);
    const caption = (a.description ?? "").trim();
    if (caption && isFile && !isQuote && !parts.includes(caption)) {
      parts.push(caption);
    }
  }
  return parts.join("\n");
}

/** Combine the message text and the optional caption (without duplication). */
export function combineMessage(msg: string | undefined, caption: string): string {
  const base = (msg ?? "").trim();
  if (!caption) return base;
  if (!base) return caption;
  if (base.includes(caption)) return base;
  return `${base}\n${caption}`;
}

/** Convert a RocketChat timestamp (Date|string|number) to epoch ms. */
export function toEpochMs(ts: Date | string | number | undefined): number {
  if (ts == null) return 0;
  if (ts instanceof Date) return ts.getTime();
  const d = new Date(ts);
  return Number.isNaN(d.getTime()) ? 0 : d.getTime();
}

/** Typed JSONL writer: one line = one Mattermost object. */
export class JsonlWriter {
  private stream: WriteStream;
  public count = 0;

  constructor(filePath: string) {
    this.stream = createWriteStream(filePath, { encoding: "utf8" });
  }

  write(line: MmLine): void {
    // U+2028 / U+2029 are valid in JSON but left raw by JSON.stringify, while
    // many line-by-line readers treat them as line breaks. We escape them for
    // a robust JSONL output.
    const json = JSON.stringify(line).replace(
      /[\u2028\u2029]/g,
      (c) => "\\u" + c.charCodeAt(0).toString(16).padStart(4, "0"),
    );
    this.stream.write(json + "\n");
    this.count++;
  }

  async close(): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      this.stream.end((err?: Error | null) => (err ? reject(err) : resolve()));
    });
  }
}
