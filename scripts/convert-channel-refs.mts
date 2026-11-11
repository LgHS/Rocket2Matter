// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Post-import fix for an instance imported before `#channel` links were
 * converted: reads posts as JSONL on stdin ({id, message}) plus the channel
 * list (--channels file, JSONL {name, displayname}) and prints, as JSONL, only
 * the posts whose text changes ({id, message}). Same conversion as the export.
 *
 *   tsx scripts/convert-channel-refs.mts --channels channels.jsonl < posts.jsonl > changes.jsonl
 */
import { createInterface } from "node:readline";
import { readFileSync } from "node:fs";
import { convertChannelRefs } from "../src/util.js";

const i = process.argv.indexOf("--channels");
if (i < 0) throw new Error("--channels <file> requis");
const refs = new Map<string, string>();
for (const line of readFileSync(process.argv[i + 1], "utf8").split("\n")) {
  if (!line.trim()) continue;
  const c = JSON.parse(line) as { name: string; displayname: string };
  for (const n of [c.displayname, c.name]) {
    if (n && !refs.has(n.toLowerCase())) refs.set(n.toLowerCase(), c.name);
  }
}

for await (const line of createInterface({ input: process.stdin })) {
  if (!line.trim()) continue;
  const p = JSON.parse(line) as { id: string; message: string };
  const message = convertChannelRefs(p.message, refs);
  if (message !== p.message) console.log(JSON.stringify({ id: p.id, message }));
}
