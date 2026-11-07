// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * The Mattermost server being migrated to: a native install (deb/tarball,
 * systemd) or a Docker container, reached locally or over SSH.
 *
 * Everything goes through `mmctl --local` (no admin credentials needed) and,
 * for the post-import SQL patches, through psql.
 */
import { statSync } from "node:fs";
import * as path from "node:path";
import { config } from "./config.js";
import { Host, RunOptions, RunResult, sh } from "./shell.js";

export class Target {
  readonly host: Host;
  readonly docker: string;
  readonly mmDir: string;
  private readonly sudo: string;
  private mmctlBin?: string;

  constructor() {
    this.host = new Host(config.targetSsh);
    this.docker = config.targetDocker;
    this.mmDir = config.mmDir || (this.docker ? "/mattermost" : "/opt/mattermost");
    this.sudo = config.targetSudo ? "sudo -n " : "";
  }

  get label(): string {
    return `${this.host.label}${this.docker ? ` (Docker: ${this.docker})` : " (installation native)"}`;
  }

  /** Command on the host, with sudo when configured. */
  runHost(command: string, opts?: RunOptions): Promise<RunResult> {
    return this.host.run(`${this.sudo}sh -c ${sh(command)}`, opts);
  }

  private shellInContainer?: boolean;

  /**
   * Shell command on Mattermost's filesystem: on the host (native), or for
   * Docker inside the container when it has a shell — the official images do
   * NOT — otherwise in a throwaway helper container (HELPER_IMAGE, busybox)
   * sharing Mattermost's volumes (/mattermost/data, /mattermost/config…).
   */
  async runMm(command: string, opts: RunOptions & { root?: boolean } = {}): Promise<RunResult> {
    if (!this.docker) return this.runHost(command, opts);
    if (this.shellInContainer === undefined) {
      const r = await this.host.run(`${this.sudo}docker exec ${sh(this.docker)} sh -c true`, { allowFail: true });
      this.shellInContainer = r.code === 0;
    }
    if (this.shellInContainer) {
      const user = opts.root ? "-u root " : "";
      return this.host.run(`${this.sudo}docker exec -i ${user}${sh(this.docker)} sh -c ${sh(command)}`, opts);
    }
    return this.host.run(
      `${this.sudo}docker run --rm -i --volumes-from ${sh(this.docker)} ${sh(config.helperImage)} sh -c ${sh(command)}`,
      opts,
    );
  }

  /** Runs a binary where Mattermost lives, without any shell (argv as is). */
  execMm(argv: string[], opts?: RunOptions): Promise<RunResult> {
    const cmd = argv.map(sh).join(" ");
    if (!this.docker) return this.runHost(cmd, opts);
    return this.host.run(`${this.sudo}docker exec -i ${sh(this.docker)} ${cmd}`, opts);
  }

  /** Resolves the mmctl binary (explicit, <MM_DIR>/bin/mmctl, or PATH). */
  async mmctlPath(): Promise<string> {
    if (this.mmctlBin) return this.mmctlBin;
    if (config.mmctl) return (this.mmctlBin = config.mmctl);
    if (this.docker) return (this.mmctlBin = "mmctl"); // on the image PATH
    const bundled = `${this.mmDir}/bin/mmctl`;
    const r = await this.runHost(`test -x ${sh(bundled)} && echo yes`, { allowFail: true });
    this.mmctlBin = r.stdout.trim() === "yes" ? bundled : "mmctl";
    return this.mmctlBin;
  }

  /**
   * Runs mmctl. A process killed by a signal (exit code ≥ 128: crash, e.g.
   * under CPU emulation) is retried; a genuine error (code 1) is not.
   */
  async mmctlRaw(args: string[], opts: RunOptions = {}): Promise<RunResult> {
    const argv = [await this.mmctlPath(), ...args];
    for (let attempt = 1; ; attempt++) {
      const r = await this.execMm(argv, { ...opts, allowFail: true });
      if (r.code < 128 || attempt === 3) {
        if (r.code !== 0 && !opts.allowFail) {
          const msg = (r.stderr || r.stdout).trim().split("\n").slice(-3).join(" | ");
          throw Object.assign(new Error(`mmctl ${args.join(" ").slice(0, 100)} → code ${r.code}: ${msg}`), r);
        }
        return r;
      }
      await new Promise((res) => setTimeout(res, 2000));
    }
  }

  mmctl(args: string[], opts?: RunOptions): Promise<RunResult> {
    return this.mmctlRaw(["--local", ...args], opts);
  }

  /** mmctl --json; an empty list comes back as `null` (e.g. no team yet) → []. */
  async mmctlJson<T = unknown>(args: string[]): Promise<T> {
    const r = await this.mmctl([...args, "--json"]);
    const out = r.stdout.trim();
    return (out && out !== "null" ? JSON.parse(out) : []) as T;
  }

  /** Reads a config setting through mmctl (requires local mode). */
  async configGet<T = unknown>(key: string): Promise<T> {
    const r = await this.mmctl(["config", "get", key]);
    return JSON.parse(r.stdout) as T;
  }

  async configSet(key: string, value: string): Promise<void> {
    await this.mmctl(["config", "set", key, value]);
  }

  async localModeWorks(): Promise<boolean> {
    const r = await this.mmctl(["system", "version"], { allowFail: true, timeoutMs: 30_000 });
    return r.code === 0;
  }

  // --- Files -----------------------------------------------------------------

  /** Absolute data directory as seen by Mattermost (FileSettings.Directory). */
  async dataDir(): Promise<string> {
    const dir = await this.configGet<string>("FileSettings.Directory");
    return path.posix.resolve(this.mmDir, dir);
  }

  /** "uid:gid" owning the data dir (the import zip must belong to it). */
  async dataOwner(): Promise<string> {
    const r = await this.runMm(`stat -c %u:%g ${sh(await this.dataDir())}`);
    return r.stdout.trim();
  }

  /** Size of a file as seen by Mattermost (-1 if absent). */
  async fileSize(mmPath: string): Promise<number> {
    const r = await this.runMm(`stat -c %s ${sh(mmPath)} 2>/dev/null || echo -1`, { root: true });
    return Number(r.stdout.trim());
  }

  /** Free bytes on the filesystem holding `mmPath` (inside the container for Docker). */
  async freeBytes(mmPath: string): Promise<number> {
    const r = await this.runMm(`df -Pk ${sh(mmPath)} | awk 'NR==2{print $4}'`);
    return Number(r.stdout.trim()) * 1024;
  }

  /**
   * Uploads the import zip into <data>/import/ by streaming it straight into
   * Mattermost's filesystem (through `docker exec` for containers): no staging
   * copy in /tmp, no dependency on host permissions or on where a Docker
   * volume lives. Resumable (an identical file already there is kept); the
   * size is checked, then the file is handed to Mattermost's user.
   * Returns the path as seen by Mattermost.
   */
  async uploadImport(localZip: string, log: (m: string) => void): Promise<string> {
    const size = statSync(localZip).size;
    const importDir = `${await this.dataDir()}/import`;
    const file = `${importDir}/${path.basename(localZip)}`;
    const owner = await this.dataOwner();
    await this.runMm(`mkdir -p ${sh(importDir)} && chown ${owner} ${sh(importDir)}`, { root: true });
    if ((await this.fileSize(file)) === size) {
      log(`archive déjà présente et complète sur la cible — transfert ignoré`);
    } else {
      const part = `${file}.part`;
      await this.runMm(`cat > ${sh(part)}`, { root: true, inputFile: localZip });
      const got = await this.fileSize(part);
      if (got !== size) {
        throw new Error(`archive transférée incomplète (${got} / ${size} octets) — relancez upload`);
      }
      await this.runMm(`mv ${sh(part)} ${sh(file)}`, { root: true });
    }
    await this.runMm(`chown ${owner} ${sh(file)}`, { root: true });
    return file;
  }

  async removeFile(mmPath: string): Promise<void> {
    await this.runMm(`rm -f ${sh(mmPath)}`, { root: true });
  }

  // --- Service ---------------------------------------------------------------

  async restart(): Promise<void> {
    if (this.docker) await this.host.run(`${this.sudo}docker restart ${sh(this.docker)}`);
    else await this.runHost(`systemctl restart ${sh(config.mmService)}`);
    for (let i = 0; i < 60; i++) {
      if (await this.localModeWorks()) return;
      await new Promise((r) => setTimeout(r, 3000));
    }
    throw new Error("Mattermost ne répond pas (mmctl --local) après le redémarrage");
  }

  /** Env vars of the running Mattermost process (overrides config.json). */
  async mmEnv(): Promise<Record<string, string>> {
    const cmd = this.docker
      ? `${this.sudo}docker inspect -f '{{range .Config.Env}}{{println .}}{{end}}' ${sh(this.docker)}`
      : `${this.sudo}sh -c ${sh(`systemctl show ${config.mmService} -p Environment --value | tr ' ' '\\n'`)}`;
    const r = await this.host.run(cmd, { allowFail: true });
    const out: Record<string, string> = {};
    for (const l of r.stdout.split("\n")) {
      const i = l.indexOf("=");
      if (i > 0) out[l.slice(0, i)] = l.slice(i + 1);
    }
    return out;
  }

  /**
   * Enables local mode (required for mmctl --local): edits config.json after a
   * backup, then restarts. Refuses when the setting is forced by an env var or
   * when the configuration lives in the database.
   */
  async enableLocalMode(log: (m: string) => void): Promise<void> {
    const env = await this.mmEnv();
    if (env.MM_SERVICESETTINGS_ENABLELOCALMODE !== undefined) {
      throw new Error(
        `EnableLocalMode est imposé par la variable d'environnement MM_SERVICESETTINGS_ENABLELOCALMODE=${env.MM_SERVICESETTINGS_ENABLELOCALMODE} — à changer dans ${this.docker ? "le docker-compose" : "l'unité systemd"}`,
      );
    }
    if (env.MM_CONFIG && !env.MM_CONFIG.endsWith(".json")) {
      throw new Error("la configuration est stockée en base (MM_CONFIG) : activez EnableLocalMode depuis la console système");
    }
    const file = env.MM_CONFIG || `${this.mmDir}/config/config.json`;
    const raw = (await this.runMm(`cat ${sh(file)}`, { root: true })).stdout;
    const conf = JSON.parse(raw);
    conf.ServiceSettings = { ...conf.ServiceSettings, EnableLocalMode: true };
    const backup = `${file}.bak-r2m-${Date.now()}`;
    await this.runMm(`cp -p ${sh(file)} ${sh(backup)}`, { root: true });
    // `cat >` rewrites in place: owner and permissions of the file are kept.
    await this.runMm(`cat > ${sh(file)}`, { root: true, input: JSON.stringify(conf, null, 4) + "\n" });
    log(`config.json modifié (sauvegarde : ${backup}) — redémarrage de Mattermost…`);
    await this.restart();
  }

  // --- SQL -------------------------------------------------------------------

  /**
   * Command that reads SQL on stdin: TARGET_PSQL, or psql with the DataSource
   * of Mattermost (on the host for native installs; for Docker, inside the
   * database container found on Mattermost's network).
   */
  async psqlCommand(): Promise<string> {
    if (config.targetPsql) return config.targetPsql;
    const ds = await this.configGet<string>("SqlSettings.DataSource");
    const driver = await this.configGet<string>("SqlSettings.DriverName");
    if (driver !== "postgres") {
      throw new Error(`base ${driver} non gérée pour les correctifs SQL (PostgreSQL uniquement)`);
    }
    const url = new URL(ds.replace(/^postgresql:/, "postgres:"));
    // Keep only libpq parameters psql understands.
    for (const k of [...url.searchParams.keys()]) {
      if (!["sslmode", "connect_timeout", "sslrootcert", "sslcert", "sslkey"].includes(k)) {
        url.searchParams.delete(k);
      }
    }
    if (!this.docker) return `psql ${sh(url.toString())}`;
    // Docker: find the database container by its hostname/alias on MM's networks.
    const dbHost = url.hostname;
    const r = await this.host.run(
      `for c in $(${this.sudo}docker ps -q); do ${this.sudo}docker inspect -f '{{.Name}} {{range .NetworkSettings.Networks}}{{join .Aliases " "}} {{end}}' $c; done`,
    );
    const hit = r.stdout
      .split("\n")
      .map((l) => l.trim().split(/\s+/))
      .find((parts) => parts[0] && (parts[0].replace(/^\//, "") === dbHost || parts.slice(1).includes(dbHost)));
    if (!hit) {
      throw new Error(`conteneur de base de données "${dbHost}" introuvable — définissez TARGET_PSQL`);
    }
    url.hostname = "localhost";
    return `${this.sudo}docker exec -i ${sh(hit[0].replace(/^\//, ""))} psql ${sh(url.toString())}`;
  }

  /** Runs SQL (text) with psql variables; ON_ERROR_STOP. */
  async sql(text: string, vars: Record<string, string | number> = {}): Promise<string> {
    const psql = await this.psqlCommand();
    const v = Object.entries(vars).map(([k, val]) => `-v ${sh(`${k}=${val}`)}`).join(" ");
    const r = await this.host.run(`${psql} -X -q -A -t -v ON_ERROR_STOP=1 ${v} -f -`, { input: text });
    return r.stdout.trim();
  }
}
