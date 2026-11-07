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
    throw new Error(`${jsonl} introuvable. Lancez d'abord l'export.`);
  }

  const zipPath = path.resolve(config.zipFile);
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
    throw new Error(
      `échec de la création du zip (la commande \`zip\` est-elle installée ?) : ${(err as Error).message}`,
    );
  }

  console.log(`✅ Archive prête : ${zipPath}`);
  console.log("➡️  Suite : rocket2matter upload, puis rocket2matter import");
}