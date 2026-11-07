// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Loads a configuration file (KEY=VALUE lines, dotenv style) into process.env.
 *
 * Must be the FIRST import of the CLI: config.ts reads process.env when it is
 * evaluated, and ES modules are evaluated in import order.
 *
 * File: `--config <file>` / `-c <file>`, otherwise ./rocket2matter.env if it
 * exists. Variables already set in the real environment take precedence.
 */
import { existsSync, readFileSync } from "node:fs";

export const DEFAULT_CONFIG_FILE = "rocket2matter.env";

function argValue(names: string[]): string | undefined {
  const argv = process.argv;
  for (let i = 0; i < argv.length; i++) {
    for (const n of names) {
      if (argv[i] === n) return argv[i + 1];
      if (argv[i].startsWith(`${n}=`)) return argv[i].slice(n.length + 1);
    }
  }
  return undefined;
}

/** Parses dotenv-style content: KEY=VALUE, # comments, optional quotes. */
export function parseEnvFile(content: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const raw of content.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const m = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (!m) continue;
    let value = m[2];
    if (/^".*"$/.test(value) || /^'.*'$/.test(value)) {
      value = value.slice(1, -1);
    } else {
      value = value.replace(/\s+#.*$/, ""); // trailing comment
    }
    out[m[1]] = value;
  }
  return out;
}

export const configFile: string | undefined = (() => {
  const explicit = argValue(["--config", "-c"]);
  const file = explicit ?? (existsSync(DEFAULT_CONFIG_FILE) ? DEFAULT_CONFIG_FILE : undefined);
  if (!file) return undefined;
  if (!existsSync(file)) {
    console.error(`❌ Fichier de configuration introuvable : ${file}`);
    process.exit(1);
  }
  for (const [k, v] of Object.entries(parseEnvFile(readFileSync(file, "utf8")))) {
    if (process.env[k] === undefined) process.env[k] = v;
  }
  return file;
})();
