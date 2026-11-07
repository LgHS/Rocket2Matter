// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * SSH tunnel to the RocketChat MongoDB, so the export can run from a third
 * machine (recommended: writing ~the size of GridFS on the RocketChat host
 * itself saturates its disk).
 *
 * MONGO_URI is written as seen FROM the RocketChat server; its host may be a
 * Docker container name, resolved to the container IP. The tunnel is restarted
 * if it drops; the MongoDB driver's retries bridge the gap.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { createServer, connect } from "node:net";
import { config } from "./config.js";
import { Host, SSH_OPTS, sh } from "./shell.js";

interface ParsedUri {
  prefix: string; // "mongodb://user:pass@"
  host: string;
  port: number;
  rest: string; // "/db?opts"
}

export function parseMongoUri(uri: string): ParsedUri {
  const m = /^(mongodb:\/\/(?:[^@/]*@)?)([^/?,]+?)(?::(\d+))?(?:,[^/?]*)?(\/.*)?$/.exec(uri);
  if (!m) {
    throw new Error("MONGO_URI invalide pour un tunnel (attendu mongodb://[user:pass@]hôte[:port]/base ; mongodb+srv non géré)");
  }
  return { prefix: m[1], host: m[2], port: Number(m[3] ?? 27017), rest: m[4] ?? "/" };
}

/** Adds connection options if absent (tunnel-friendly defaults). */
export function withOptions(rest: string, opts: Record<string, string>): string {
  const [pathPart, query = ""] = rest.split("?");
  const params = new URLSearchParams(query);
  for (const [k, v] of Object.entries(opts)) if (!params.has(k)) params.set(k, v);
  return `${pathPart || "/"}?${params.toString()}`;
}

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.once("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const port = (srv.address() as { port: number }).port;
      srv.close(() => resolve(port));
    });
  });
}

function portOpen(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const s = connect({ host: "127.0.0.1", port }, () => {
      s.destroy();
      resolve(true);
    });
    s.once("error", () => resolve(false));
  });
}

export class MongoTunnel {
  private child?: ChildProcess;
  private closing = false;
  private port = 0;
  private remote = "";

  /** Opens the tunnel and returns the MONGO_URI to use locally. */
  async open(uri: string, log: (m: string) => void): Promise<string> {
    const p = parseMongoUri(uri);
    const host = new Host(config.sourceSsh);
    let target = p.host;
    if (!/^(localhost|127\.0\.0\.1|\d+\.\d+\.\d+\.\d+)$/.test(p.host)) {
      // Probably a Docker container name: resolve its IP on the source host.
      const r = await host.run(
        `docker inspect -f '{{range .NetworkSettings.Networks}}{{.IPAddress}} {{end}}' ${sh(p.host)} 2>/dev/null || sudo -n docker inspect -f '{{range .NetworkSettings.Networks}}{{.IPAddress}} {{end}}' ${sh(p.host)} 2>/dev/null`,
        { allowFail: true },
      );
      const ip = r.stdout.trim().split(/\s+/).find((x) => /^\d+\.\d+\.\d+\.\d+$/.test(x));
      if (ip) {
        log(`conteneur "${p.host}" → ${ip}`);
        target = ip;
      }
    }
    this.remote = `${target}:${p.port}`;
    this.port = await freePort();
    try {
      await this.start(log);
    } catch (err) {
      this.close(); // stop the auto-restart loop: fail fast on first opening
      throw err;
    }
    return (
      p.prefix +
      `127.0.0.1:${this.port}` +
      withOptions(p.rest, {
        directConnection: "true", // never follow replica-set hostnames
        serverSelectionTimeoutMS: "600000",
        connectTimeoutMS: "120000",
        socketTimeoutMS: "0",
        heartbeatFrequencyMS: "60000",
        retryReads: "true",
      })
    );
  }

  private async start(log: (m: string) => void): Promise<void> {
    const child = spawn(
      "ssh",
      [...SSH_OPTS, "-N", "-o", "ExitOnForwardFailure=yes", "-L", `127.0.0.1:${this.port}:${this.remote}`, config.sourceSsh],
      { stdio: ["ignore", "ignore", "pipe"] },
    );
    let err = "";
    child.stderr!.on("data", (d) => (err += d));
    this.child = child;
    child.on("exit", (code) => {
      if (this.closing) return;
      log(`⚠️  tunnel SSH interrompu (code ${code}${err ? ` : ${err.trim().split("\n").pop()}` : ""}) — relance…`);
      setTimeout(() => this.start(log).catch((e) => log(`❌ relance du tunnel impossible : ${e.message}`)), 3000);
    });
    for (let i = 0; i < 40; i++) {
      if (child.exitCode !== null) break;
      if (await portOpen(this.port)) {
        log(`tunnel SSH ouvert : 127.0.0.1:${this.port} → ${config.sourceSsh} → ${this.remote}`);
        return;
      }
      await new Promise((r) => setTimeout(r, 500));
    }
    throw new Error(`tunnel SSH vers ${config.sourceSsh} impossible${err ? ` : ${err.trim()}` : ""}`);
  }

  close(): void {
    this.closing = true;
    this.child?.kill();
  }
}
