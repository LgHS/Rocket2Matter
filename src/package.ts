// SPDX-License-Identifier: AGPL-3.0-or-later
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { rm } from "node:fs/promises";
import * as path from "node:path";
import { promisify } from "node:util";
import { config } from "./config.js";

const exec = promisify(execFile);

/**
 * Packages the export output (import.jsonl + data/) into a zip archive directly
 * consumable by `mmctl import upload`.
 *
 * At its root, the zip contains:
 *   import.jsonl
 *   data/<id>/<file>   (paths referenced by attachments)
 */
export async function runPackage() {
  const outDir = path.resolve(config.outDir);
  const jsonl = path.join(outDir, config.jsonlFile);
  if (!existsSync(jsonl)) {
    console.error(
      `❌ ${jsonl} introuvable. Lancez d'abord l'export : pnpm export`,
    );
    process.exit(1);
  }

  const zipPath = path.resolve("mattermost-import.zip");
  if (existsSync(zipPath)) await rm(zipPath);

  const entries: string[] = [config.jsonlFile];
  if (existsSync(path.join(outDir, config.dataDir))) {
    entries.push(config.dataDir);
  }

  console.log(`📦 Création de ${zipPath} …`);
  try {
    // -r recursive, -X no extra attributes, -q quiet; run from outDir
    await exec("zip", ["-r", "-X", "-q", zipPath, ...entries], {
      cwd: outDir,
      maxBuffer: 256 * 1024 * 1024,
    });
  } catch (err) {
    console.error(
      "❌ Échec de la création du zip (la commande `zip` est-elle installée ?)",
    );
    console.error((err as Error).message);
    process.exit(1);
  }

  console.log(`✅ Archive prête : ${zipPath}`);
  console.log("\nImport côté Mattermost :");
  console.log("  mmctl import upload ./mattermost-import.zip");
  console.log("  mmctl import process <id-renvoyé>");
}