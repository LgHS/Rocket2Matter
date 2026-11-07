// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Runs shell commands on a host — the local machine, or a remote one over SSH
 * (key-based, non-interactive) — and copies files to it.
 */
import { spawn } from "node:child_process";
import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";
import { config } from "./config.js";

export interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

export interface RunOptions {
  input?: string; // written to stdin
  inputFile?: string; // local file streamed to stdin (large uploads)
  allowFail?: boolean; // do not throw on non-zero exit
  timeoutMs?: number;
}

/** POSIX single-quote escaping. */
export function sh(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

export const SSH_OPTS = [
  "-o", "BatchMode=yes",
  "-o", "ConnectTimeout=15",
  "-o", "ServerAliveInterval=15",
  "-o", "ServerAliveCountMax=4",
];

function exec(
  file: string,
  args: string[],
  opts: RunOptions = {},
): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(file, args, { stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let timer: NodeJS.Timeout | undefined;
    if (opts.timeoutMs) {
      timer = setTimeout(() => child.kill("SIGKILL"), opts.timeoutMs);
    }
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.on("error", reject);
    child.on("close", (code) => {
      if (timer) clearTimeout(timer);
      const res = { code: code ?? -1, stdout, stderr };
      if (res.code !== 0 && !opts.allowFail) {
        const msg = (stderr || stdout).trim().split("\n").slice(-3).join(" | ");
        reject(Object.assign(new Error(`${file} ${args.slice(-1)[0]?.slice(0, 120)} → code ${res.code}: ${msg}`), res));
      } else {
        resolve(res);
      }
    });
    child.stdin.on("error", () => {}); // process may exit before reading stdin
    if (opts.inputFile) createReadStream(opts.inputFile).pipe(child.stdin);
    else if (opts.input !== undefined) child.stdin.end(opts.input);
    else child.stdin.end();
  });
}

/** A machine commands are run on: local when `ssh` is empty. */
export class Host {
  constructor(readonly ssh: string) {}

  get label(): string {
    return this.ssh || "machine locale";
  }

  /** Runs a shell command line on the host. */
  run(command: string, opts: RunOptions = {}): Promise<RunResult> {
    if (!this.ssh) return exec("sh", ["-c", command], opts);
    return exec("ssh", [...SSH_OPTS, this.ssh, command], opts);
  }

  /** Copies a local file to `remotePath` on the host. */
  async copyTo(localPath: string, remotePath: string): Promise<void> {
    if (!this.ssh) {
      await exec("cp", [localPath, remotePath]);
      return;
    }
    await exec("scp", [...SSH_OPTS, "-q", localPath, `${this.ssh}:${remotePath}`]);
  }
}

// --- Confirmations -----------------------------------------------------------

/**
 * Asks a yes/no question. `--yes` / ASSUME_YES answers yes; a non-interactive
 * run without it answers no (never write to a server implicitly).
 */
export async function confirm(question: string): Promise<boolean> {
  if (config.assumeYes) {
    console.log(`${question} → oui (--yes)`);
    return true;
  }
  if (!process.stdin.isTTY) {
    console.log(`${question} → non (pas de terminal ; relancer avec --yes)`);
    return false;
  }
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const answer = await new Promise<string>((r) => rl.question(`${question} [o/N] `, r));
  rl.close();
  return /^(o|oui|y|yes)$/i.test(answer.trim());
}

export function formatBytes(n: number): string {
  if (n >= 1024 ** 3) return `${(n / 1024 ** 3).toFixed(1)} Go`;
  if (n >= 1024 ** 2) return `${(n / 1024 ** 2).toFixed(0)} Mo`;
  if (n >= 1024) return `${(n / 1024).toFixed(0)} Ko`;
  return `${n} o`;
}
