// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Protects a production RocketChat during the export: polls its host over SSH
 * and pauses the reads while it is under pressure.
 *
 * Signals: I/O pressure (PSI /proc/pressure/io "some avg10", the % of time
 * tasks stall on I/O), load average, and SSH responsiveness (an unresponsive
 * host is treated as overloaded). Hysteresis between the high/low thresholds.
 *
 * The export awaits `gate()` before each GridFS chunk and every few hundred
 * messages, so a pause stops the load within seconds.
 */
import { config } from "./config.js";
import { Host } from "./shell.js";

let paused = false;
let waiters: (() => void)[] = [];

/** Resolves immediately, or when the watchdog resumes. */
export function gate(): Promise<void> {
  if (!paused) return Promise.resolve();
  return new Promise((r) => waiters.push(r));
}

function setPaused(value: boolean) {
  paused = value;
  if (!value) {
    const w = waiters;
    waiters = [];
    w.forEach((r) => r());
  }
}

export class Watchdog {
  private timer?: NodeJS.Timeout;
  private host = new Host(config.sourceSsh);
  private failures = 0;
  private high = config.watchdogLoadHigh;
  private low = config.watchdogLoadLow;
  pauses = 0;

  constructor(private log: (m: string) => void) {}

  async start(): Promise<void> {
    const r = await this.host.run("nproc", { allowFail: true, timeoutMs: 15_000 });
    const cpus = Number(r.stdout.trim()) || 2;
    if (!this.high) this.high = cpus + 2;
    if (!this.low) this.low = Math.max(1, cpus / 2);
    this.log(
      `watchdog actif sur ${config.sourceSsh} : pause si charge ≥ ${this.high} ou attente I/O ≥ ${config.watchdogPsiHigh} %, reprise sous ${this.low} / ${config.watchdogPsiLow} %`,
    );
    const tick = () => this.poll().finally(() => {
      if (this.timer !== undefined) this.timer = setTimeout(tick, 10_000);
    });
    this.timer = setTimeout(tick, 10_000);
  }

  private async poll(): Promise<void> {
    const r = await this.host.run(
      `cut -d' ' -f1 /proc/loadavg; awk -F'[= ]' '/^some/{print $3}' /proc/pressure/io 2>/dev/null`,
      { allowFail: true, timeoutMs: 20_000 },
    );
    const [loadS, psiS] = r.stdout.trim().split("\n");
    const load = Number(loadS);
    const psi = Number(psiS ?? 0) || 0;
    if (r.code !== 0 || !loadS || Number.isNaN(load)) {
      // Unresponsive host: the very symptom of saturation. Two in a row → pause.
      if (++this.failures >= 2 && !paused) {
        this.pauses++;
        setPaused(true);
        this.log("⏸  PAUSE : le serveur RocketChat ne répond plus en SSH");
      }
      return;
    }
    this.failures = 0;
    if (!paused && (load >= this.high || psi >= config.watchdogPsiHigh)) {
      this.pauses++;
      setPaused(true);
      this.log(`⏸  PAUSE : serveur RocketChat sous pression (charge ${load}, attente I/O ${psi} %)`);
    } else if (paused && load < this.low && psi < config.watchdogPsiLow) {
      setPaused(false);
      this.log(`▶️  REPRISE (charge ${load}, attente I/O ${psi} %)`);
    }
  }

  stop(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    setPaused(false);
  }
}
