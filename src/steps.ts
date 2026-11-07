// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * End-to-end migration steps, each usable on its own or chained by `migrate`:
 *
 *   preflight → export → package → upload → import → post-import → verify → cleanup
 *
 * Progress is kept in <OUT_DIR>.state.json so an interrupted run resumes where
 * it stopped. Every write to the Mattermost server is confirmed first (or
 * --yes).
 */
import { existsSync, readFileSync, statSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import * as path from "node:path";
import { MongoClient } from "mongodb";
import { config } from "./config.js";
import { DEFAULT_CONFIG_FILE } from "./env.js";
import { READSTATE_FILE, SUMMARY_FILE, runExport, type ExportSummary } from "./index.js";
import { runPackage } from "./package.js";
import { confirm, formatBytes, Host } from "./shell.js";
import { Target } from "./target.js";
import { MongoTunnel } from "./tunnel.js";

// --- State -------------------------------------------------------------------

interface State {
  done: string[];
  importJobId?: string;
  importStartAt?: number; // cutoff for the read-state patch
  remoteZip?: string; // host path of the uploaded archive
  enabledLocalMode?: boolean;
}

const statePath = () => `${path.resolve(config.outDir)}.state.json`;

function loadState(): State {
  try {
    return JSON.parse(readFileSync(statePath(), "utf8")) as State;
  } catch {
    return { done: [] };
  }
}

async function saveState(s: State): Promise<void> {
  await writeFile(statePath(), JSON.stringify(s, null, 2) + "\n");
}

async function markDone(step: string, patch: Partial<State> = {}): Promise<void> {
  const s = { ...loadState(), ...patch };
  if (!s.done.includes(step)) s.done.push(step);
  await saveState(s);
}

const outFile = (name: string) => path.join(path.resolve(config.outDir), name);
const zipPath = () => path.resolve(config.zipFile);

function title(t: string) {
  console.log(`\n━━━ ${t} ${"━".repeat(Math.max(0, 60 - t.length))}`);
}

// --- Report helpers ----------------------------------------------------------

type Level = "ok" | "warn" | "fail" | "info";
const ICON: Record<Level, string> = { ok: "✅", warn: "⚠️ ", fail: "❌", info: "ℹ️ " };

interface Fix {
  label: string;
  apply: () => Promise<void>;
}

class Report {
  failures = 0;
  warnings = 0;
  fixes: Fix[] = [];
  line(level: Level, what: string, detail = "") {
    if (level === "fail") this.failures++;
    if (level === "warn") this.warnings++;
    console.log(`  ${ICON[level]} ${what}${detail ? ` — ${detail}` : ""}`);
  }
}

const isTargetConfigured = () =>
  !!(config.targetSsh || config.targetDocker || config.mmDir || config.mmctl);

/** "username email" lines of the accounts already in Mattermost. */
export async function fetchExistingUsers(target: Target): Promise<string> {
  const users = await target.mmctlJson<{ username: string; email: string }[]>([
    "user", "list", "--all",
  ]);
  return users.map((u) => `${u.username} ${u.email}`).join("\n") + "\n";
}

// --- preflight ---------------------------------------------------------------

interface SourceFacts {
  users: number;
  channels: number;
  messages: number;
  filesBytes: number;
}

async function checkSource(r: Report): Promise<SourceFacts | undefined> {
  if (config.sourceSsh) {
    const h = new Host(config.sourceSsh);
    const res = await h.run("echo ok; nproc; cut -d' ' -f1-3 /proc/loadavg", { allowFail: true, timeoutMs: 20_000 });
    if (res.code !== 0) {
      r.line("fail", `SSH vers le serveur RocketChat (${config.sourceSsh})`, res.stderr.trim().split("\n").pop());
      return;
    }
    const [, cpus, load] = res.stdout.trim().split("\n");
    r.line("ok", `SSH vers le serveur RocketChat`, `${cpus} CPU, charge ${load}`);
  }
  let tunnel: MongoTunnel | undefined;
  let client: MongoClient | undefined;
  try {
    let uri = config.mongoUri;
    if (config.sourceSsh) {
      tunnel = new MongoTunnel();
      uri = await tunnel.open(config.mongoUri, () => {});
    }
    // Fail fast here (the tunnel URI carries a 10-min timeout meant for the export).
    uri = uri.replace(/serverSelectionTimeoutMS=\d+/, "serverSelectionTimeoutMS=20000");
    client = new MongoClient(uri, { serverSelectionTimeoutMS: 20_000 });
    await client.connect();
    const db = client.db(config.dbName);
    const [users, channels, messages] = await Promise.all([
      db.collection("users").countDocuments({ type: { $ne: "bot" } }),
      db.collection("rocketchat_room").countDocuments({ t: { $in: ["c", "p"] } }),
      db.collection("rocketchat_message").estimatedDocumentCount(),
    ]);
    const agg = await db
      .collection(`${config.gridfsBucket}.files`)
      .aggregate<{ total: number }>([{ $group: { _id: null, total: { $sum: "$length" } } }])
      .toArray();
    const filesBytes = agg[0]?.total ?? 0;
    r.line("ok", `MongoDB RocketChat (base ${config.dbName})`,
      `${users} utilisateurs, ${channels} canaux, ~${messages} messages, ${formatBytes(filesBytes)} de fichiers`);
    return { users, channels, messages, filesBytes };
  } catch (err) {
    r.line("fail", "connexion à MongoDB RocketChat", (err as Error).message);
  } finally {
    await client?.close().catch(() => {});
    tunnel?.close();
  }
}

async function checkRunner(r: Report, src?: SourceFacts) {
  const zip = await new Host("").run("zip -v >/dev/null 2>&1 && echo ok", { allowFail: true });
  if (zip.stdout.trim() === "ok") r.line("ok", "commande zip disponible");
  else r.line("fail", "commande zip introuvable (nécessaire pour `package`)", "installez zip");
  if (src) {
    const need = src.filesBytes * 2.1; // export + archive
    const dir = path.dirname(path.resolve(config.outDir));
    const df = await new Host("").run(`df -Pk ${JSON.stringify(dir)} | awk 'NR==2{print $4}'`);
    const free = Number(df.stdout.trim()) * 1024;
    r.line(free >= need ? "ok" : "fail", `espace disque local (${dir})`,
      `${formatBytes(free)} libres, ~${formatBytes(need)} nécessaires (export + archive)`);
  }
}

async function checkTarget(r: Report, target: Target, src?: SourceFacts) {
  if (target.host.ssh) {
    const res = await target.host.run("echo ok", { allowFail: true, timeoutMs: 20_000 });
    if (res.code !== 0) {
      r.line("fail", `SSH vers le serveur Mattermost (${target.host.ssh})`, res.stderr.trim().split("\n").pop());
      return;
    }
    r.line("ok", `SSH vers le serveur Mattermost (${target.host.ssh})`);
  }
  if (target.docker) {
    const res = await target.host.run(
      `${config.targetSudo ? "sudo -n " : ""}docker inspect -f '{{.State.Running}}' '${target.docker}'`,
      { allowFail: true },
    );
    if (res.stdout.trim() !== "true") {
      r.line("fail", `conteneur Docker "${target.docker}"`, "introuvable ou arrêté");
      return;
    }
    r.line("ok", `conteneur Docker "${target.docker}" démarré`);
  }
  const ver = await target.mmctlRaw(["version"], { allowFail: true });
  if (ver.code !== 0) {
    r.line("fail", "mmctl inutilisable sur la cible",
      `${(ver.stderr || ver.stdout).trim().split("\n").pop()} — vérifiez MMCTL (chemin du binaire)`);
    return;
  }

  if (!(await target.localModeWorks())) {
    r.line("fail", "mode local de Mattermost (mmctl --local)", "désactivé — requis pour importer sans identifiants admin");
    r.fixes.push({
      label: `activer EnableLocalMode (sauvegarde de config.json puis redémarrage de Mattermost sur ${target.label})`,
      apply: async () => {
        await target.enableLocalMode((m) => console.log(`     ${m}`));
        await markDone("local-mode", { enabledLocalMode: true });
      },
    });
    return; // everything below needs local mode
  }
  const version = (await target.mmctl(["system", "version"])).stdout.match(/Server version.*?(\d+\.\d+\.\d+)/i)?.[1];
  r.line("ok", `Mattermost ${version ?? "?"} joignable en mode local`, target.label);

  // Team
  const teams = await target.mmctlJson<{ name: string; display_name: string }[]>(["team", "list"]).catch(() => []);
  const team = teams.find((t) => t.name === config.teamName);
  r.line("info", `team "${config.teamName}"`, team ? `existe (« ${team.display_name} ») : l'import s'y ajoute` : "sera créée par l'import");

  // Team size limit: the import fails at the first member over it.
  const maxUsers = Number(await target.configGet("TeamSettings.MaxUsersPerTeam"));
  if (src) {
    const existing = (await target.mmctlJson<unknown[]>(["user", "list", "--all"]).catch(() => [])).length;
    const need = src.users + existing + 1; // + ghost account
    if (maxUsers < need) {
      const value = Math.max(500, need * 2);
      r.line("fail", "TeamSettings.MaxUsersPerTeam", `${maxUsers}, alors qu'il faut au moins ${need} membres (l'import échouerait)`);
      r.fixes.push({
        label: `passer MaxUsersPerTeam à ${value}`,
        apply: () => target.configSet("TeamSettings.MaxUsersPerTeam", String(value)),
      });
    } else r.line("ok", "TeamSettings.MaxUsersPerTeam", `${maxUsers} (≥ ${need} nécessaires)`);
  }

  // SSO provider
  if (config.authService) {
    const key = { openid: "OpenIdSettings", gitlab: "GitLabSettings", google: "GoogleSettings", office365: "Office365Settings", saml: "SamlSettings", ldap: "LdapSettings" }[config.authService];
    const enabled = key ? await target.configGet<boolean>(`${key}.Enable`).catch(() => false) : false;
    r.line(enabled ? "ok" : "warn", `SSO ${config.authService} (AUTH_SERVICE)`,
      enabled ? "activé : les comptes importés s'y connecteront" : `${key ?? "fournisseur inconnu"}.Enable n'est pas activé — les comptes ne pourront pas se connecter`);
  }

  // Existing accounts (merge by email / reserved usernames)
  try {
    const existing = (await fetchExistingUsers(target)).trim().split("\n").filter(Boolean);
    const human = existing.filter((l) => !/@localhost$/.test(l));
    r.line("info", `${existing.length} comptes déjà présents`,
      human.length ? `fusion automatique par email si un compte RocketChat a le même (${human.slice(0, 4).map((l) => l.split(" ")[0]).join(", ")}${human.length > 4 ? "…" : ""})` : "comptes système uniquement");
  } catch (err) {
    r.line("warn", "liste des comptes existants", (err as Error).message);
  }

  // Disk on the target
  try {
    const hostData = await target.dataDir();
    const free = await target.freeBytes(hostData);
    const need = (src?.filesBytes ?? 0) * 2.1;
    r.line(!src || free >= need ? "ok" : "fail", `espace disque cible (${hostData})`,
      `${formatBytes(free)} libres${src ? `, ~${formatBytes(need)} nécessaires (archive + fichiers importés)` : ""}`);
  } catch (err) {
    r.line("fail", "répertoire de données de la cible", (err as Error).message);
  }

  // SQL access (read-state patch)
  if (config.readState === "last-seen") {
    try {
      await target.sql("SELECT 1;");
      r.line("ok", "accès SQL à la base Mattermost (patch d'état de lecture)");
    } catch (err) {
      r.line("warn", "accès SQL à la base Mattermost", `${(err as Error).message.slice(0, 160)} — l'état lu/non-lu ne pourra pas être appliqué (définir TARGET_PSQL)`);
    }
  }
}

export async function runPreflight(opts: { quiet?: boolean } = {}, pass = 1): Promise<boolean> {
  title(pass === 1 ? "Vérifications préalables" : "Vérifications préalables (après corrections)");
  const r = new Report();
  console.log("Source (RocketChat) :");
  const src = await checkSource(r);
  console.log("Machine locale :");
  await checkRunner(r, src);
  if (isTargetConfigured() || !opts.quiet) {
    console.log("Cible (Mattermost) :");
    await checkTarget(r, new Target(), src);
  }

  let applied = 0;
  if (r.fixes.length) {
    console.log("\nCorrections proposées :");
    for (const f of r.fixes) {
      if (await confirm(`  → ${f.label} ?`)) {
        try {
          await f.apply();
          console.log("     ✅ fait");
          applied++;
        } catch (err) {
          console.log(`     ❌ ${(err as Error).message}`);
        }
      }
    }
  }
  // A fix (e.g. local mode) may unlock checks that were skipped: re-run once.
  if (applied && pass === 1) return runPreflight(opts, 2);
  console.log(
    r.failures > 0
      ? `\n❌ ${r.failures} point(s) bloquant(s) à corriger avant la migration.`
      : `\n✅ Prêt${r.warnings ? ` (${r.warnings} avertissement(s))` : ""}.`,
  );
  return r.failures === 0;
}

// --- export (with existing accounts fetched from the target) -----------------

export async function runExportStep(): Promise<void> {
  let existingUsers: string | undefined;
  if (config.existingUsersFile === "auto" || (!config.existingUsersFile && isTargetConfigured())) {
    const target = new Target();
    try {
      existingUsers = await fetchExistingUsers(target);
      console.log(`Comptes déjà présents sur Mattermost récupérés (${existingUsers.trim().split("\n").length}) : fusion par email.`);
    } catch (err) {
      console.log(`⚠️  Comptes existants non récupérés (${(err as Error).message}) — pas de fusion.`);
    }
  }
  await runExport({ existingUsers });
  await markDone("export");
}

// --- upload ------------------------------------------------------------------

export async function runUpload(): Promise<string> {
  title("Envoi de l'archive vers Mattermost");
  const zip = zipPath();
  if (!existsSync(zip)) throw new Error(`${zip} introuvable — lancez d'abord \`package\``);
  const target = new Target();
  const size = statSync(zip).size;
  console.log(`  ${formatBytes(size)} → ${target.label}`);
  const t0 = Date.now();
  const mmFile = await target.uploadImport(zip, (m) => console.log(`  ${m}`));
  console.log(`  ✅ archive en place, intègre (${Math.round((Date.now() - t0) / 1000)} s) : ${mmFile}`);
  await markDone("upload", { remoteZip: mmFile });
  return mmFile;
}

// --- import ------------------------------------------------------------------

interface Job {
  id: string;
  status: string;
  start_at: number;
  data?: Record<string, string>;
}

export async function runImport(): Promise<void> {
  title("Import dans Mattermost");
  const target = new Target();
  const state = loadState();
  let jobId = state.importJobId;
  if (jobId) {
    const job = (await target.mmctlJson<Job[]>(["import", "job", "show", jobId]))[0];
    if (job?.status === "success") {
      console.log(`  import ${jobId} déjà terminé avec succès`);
      return;
    }
    if (!job || !["pending", "in_progress"].includes(job.status)) jobId = undefined; // failed → new run
  }
  if (!jobId) {
    const mmFile = `${await target.dataDir()}/import/${path.basename(zipPath())}`;
    const out = await target.mmctl(["import", "process", mmFile, "--bypass-upload", "--extract-content=false"]);
    jobId = /ID:\s*(\w+)/.exec(out.stdout)?.[1];
    if (!jobId) throw new Error(`job d'import non créé : ${out.stdout}`);
    await saveState({ ...loadState(), importJobId: jobId });
    console.log(`  job ${jobId} lancé`);
  }
  const t0 = Date.now();
  for (;;) {
    const job = (await target.mmctlJson<Job[]>(["import", "job", "show", jobId]))[0];
    const elapsed = Math.round((Date.now() - t0) / 60_000);
    if (job.status === "success") {
      console.log(`  ✅ import terminé (${elapsed} min)`);
      await markDone("import", { importStartAt: job.start_at });
      return;
    }
    if (!["pending", "in_progress"].includes(job.status)) {
      await saveState({ ...loadState(), importJobId: undefined });
      const line = job.data?.line_number ? ` (ligne ${job.data.line_number} de import.jsonl)` : "";
      throw new Error(`import en échec${line} : ${job.data?.error ?? job.status}`);
    }
    process.stdout.write(`\r  ⏳ ${job.status}… ${elapsed} min écoulées`);
    await new Promise((r) => setTimeout(r, 30_000));
  }
}

// --- post-import -------------------------------------------------------------

export async function runPostImport(): Promise<void> {
  title("Après l'import");
  const target = new Target();
  const state = loadState();

  // 1. Accounts inactive in RocketChat → deactivated.
  const inactiveFile = outFile("deactivated-users.txt");
  if (existsSync(inactiveFile)) {
    const names = readFileSync(inactiveFile, "utf8").split("\n").map((l) => l.trim()).filter(Boolean);
    let ok = 0;
    for (const name of names) {
      const r = await target.mmctl(["user", "deactivate", name], { allowFail: true });
      if (r.code === 0) ok++;
      else console.log(`  ⚠️  ${name} : ${(r.stderr || r.stdout).trim().split("\n").pop()}`);
    }
    console.log(`  ✅ comptes inactifs désactivés : ${ok}/${names.length}`);
  }

  // 2. Per-user read state.
  const rsFile = outFile(READSTATE_FILE);
  if (existsSync(rsFile)) {
    const cutoff = state.importStartAt ?? Date.now();
    await target.sql(readFileSync(rsFile, "utf8"), { cutoff });
    console.log("  ✅ état lu/non-lu appliqué pour chaque utilisateur");
    if (await confirm("  → redémarrer Mattermost pour que les clients voient l'état de lecture (≈ 20 s d'indisponibilité) ?")) {
      await target.restart();
      console.log("  ✅ Mattermost redémarré — les utilisateurs doivent recharger leur client");
    }
  }
  await markDone("post-import");
}

// --- verify ------------------------------------------------------------------

export async function runVerify(): Promise<boolean> {
  title("Vérification");
  const summaryFile = outFile(SUMMARY_FILE);
  if (!existsSync(summaryFile)) throw new Error(`${summaryFile} introuvable — l'export n'a pas été fait ici`);
  const s = JSON.parse(readFileSync(summaryFile, "utf8")) as ExportSummary;
  const target = new Target();
  const team = config.teamName.replace(/'/g, "''");
  const raw = await target.sql(`
    SELECT count(*) FROM users;
    SELECT count(*) FROM users WHERE deleteat > 0;
    SELECT count(*) FROM channels c JOIN teams t ON t.id = c.teamid WHERE t.name = '${team}';
    SELECT count(*) FROM channels c JOIN teams t ON t.id = c.teamid WHERE t.name = '${team}' AND c.deleteat > 0;
    SELECT count(*) FROM channels WHERE type IN ('D', 'G');
    SELECT count(*) FROM posts WHERE rootid = '';
    SELECT count(*) FROM posts WHERE ispinned;
    SELECT count(*) FROM fileinfo;
    SELECT count(*) FROM emoji WHERE deleteat = 0;
    SELECT count(*) FROM users WHERE lastpictureupdate > 0;
  `);
  const [users, deactivated, channels, archived, directs, roots, pinned, files, emojis, avatars] = raw.split("\n").map(Number);
  const r = new Report();
  const cmp = (what: string, got: number, want: number) =>
    r.line(got >= want ? "ok" : "warn", what, `${got} dans Mattermost / ${want} exportés`);
  cmp("utilisateurs", users, s.users);
  cmp("comptes désactivés", deactivated, s.inactiveUsers);
  cmp("canaux de la team", channels, s.channels);
  cmp("canaux archivés", archived, s.archivedChannels);
  cmp("conversations directes / groupes", directs, s.directChannels);
  cmp("messages (hors réponses de fil)", roots, s.posts + s.directPosts);
  cmp("messages épinglés", pinned, s.pinned);
  cmp("fichiers", files, s.files);
  if (emojis >= s.emojis) r.line("ok", "émojis personnalisés", `${emojis} dans Mattermost / ${s.emojis} exportés`);
  else {
    // Mattermost silently skips custom emojis named like a system emoji.
    const present = new Set((await target.sql("SELECT name FROM emoji WHERE deleteat = 0;")).split("\n"));
    const missing = (s.emojiNames ?? []).filter((n) => !present.has(n));
    r.line("info", "émojis personnalisés", `${emojis} / ${s.emojis} — non importés : ${missing.join(", ")} (même nom qu'un émoji système de Mattermost : l'import les ignore)`);
  }
  cmp("avatars", avatars, s.avatars);
  console.log(r.warnings ? `\n⚠️  ${r.warnings} écart(s) à examiner.` : "\n✅ Tout ce qui a été exporté est présent dans Mattermost.");
  await markDone("verify");
  return r.warnings === 0;
}

// --- cleanup -----------------------------------------------------------------

export async function runCleanup(): Promise<void> {
  title("Nettoyage");
  const target = new Target();
  const state = loadState();
  if (state.remoteZip && (await confirm(`  → supprimer l'archive d'import sur la cible (${state.remoteZip}) ?`))) {
    await target.removeFile(state.remoteZip);
    console.log("  ✅ archive supprimée");
  }
  if (state.enabledLocalMode) {
    console.log("  ℹ️  Le mode local a été activé par cet outil. Il ne sert plus qu'à rejouer une migration ;");
    console.log("     vous pouvez le désactiver (ServiceSettings.EnableLocalMode = false) puis redémarrer Mattermost.");
  }
  await markDone("cleanup");
}

// --- migrate -----------------------------------------------------------------

export const STEPS = ["preflight", "export", "package", "upload", "import", "post-import", "verify", "cleanup"] as const;

export async function runMigrate(from?: string): Promise<void> {
  if (from && !STEPS.includes(from as (typeof STEPS)[number])) {
    throw new Error(`étape inconnue "${from}" (étapes : ${STEPS.join(", ")})`);
  }
  let state = loadState();
  if (from) {
    // Restart from `from`: forget it and every later step.
    const idx = STEPS.indexOf(from as (typeof STEPS)[number]);
    state = { ...state, done: state.done.filter((d) => STEPS.indexOf(d as (typeof STEPS)[number]) < idx) };
    if (idx <= STEPS.indexOf("import")) state.importJobId = undefined;
    await saveState(state);
  }
  const target = new Target();
  const skip = (step: string) => {
    if (loadState().done.includes(step)) {
      console.log(`\n⏭  ${step} : déjà fait (--from ${step} pour le refaire)`);
      return true;
    }
    return false;
  };

  if (!skip("preflight")) {
    if (!(await runPreflight())) throw new Error("vérifications préalables en échec — corrigez puis relancez `migrate`");
    await markDone("preflight");
  }
  if (!skip("export")) {
    title("Export depuis RocketChat");
    await runExportStep();
  }
  if (!skip("package")) {
    title("Création de l'archive");
    await runPackage();
    await markDone("package");
  }
  if (!loadState().done.includes("upload") || !loadState().done.includes("import")) {
    const ok = await confirm(
      `\nImporter dans ${target.label}, team "${config.teamName}" ? (écrit dans Mattermost ; les données existantes sont conservées)`,
    );
    if (!ok) {
      console.log("Arrêt avant l'import. Relancez `migrate` pour reprendre ici.");
      return;
    }
  }
  if (!skip("upload")) await runUpload();
  if (!skip("import")) await runImport();
  if (!skip("post-import")) await runPostImport();
  if (!skip("verify")) await runVerify();
  if (!skip("cleanup")) await runCleanup();
  console.log("\n🎉 Migration terminée.");
}

// --- init --------------------------------------------------------------------

const TEMPLATE = `# Rocket2Matter — configuration de la migration RocketChat → Mattermost.
# Chargée automatiquement depuis ./${DEFAULT_CONFIG_FILE} (ou --config <fichier>).
# Lancez ensuite :  rocket2matter preflight   puis   rocket2matter migrate

# ─── Source : RocketChat ──────────────────────────────────────────────────────
# Accès SSH au serveur RocketChat (recommandé) : tunnel vers MongoDB ouvert
# automatiquement + pause de l'export si le serveur sature. Vide = accès direct.
SOURCE_SSH=root@rocketchat.example.org
# URI MongoDB telle que vue DEPUIS le serveur RocketChat. L'hôte peut être le nom
# du conteneur Docker de mongo (ex. rocketchat-mongodb-1).
MONGO_URI=mongodb://localhost:27017/rocketchat
DB_NAME=rocketchat
# Débit max de lecture des fichiers (protège un RocketChat en production).
FILE_RATE_LIMIT=4M

# ─── Cible : Mattermost ───────────────────────────────────────────────────────
# Accès SSH au serveur Mattermost. Vide = l'outil tourne sur ce serveur.
TARGET_SSH=root@mattermost.example.org
# Nom du conteneur Mattermost si installé avec Docker. Vide = installation native.
TARGET_DOCKER=
# true si l'utilisateur SSH n'est pas root (commandes via sudo -n).
TARGET_SUDO=false
# Team de destination (créée si absente) et son nom affiché.
TEAM_NAME=mon-equipe
TEAM_DISPLAY_NAME=Mon équipe

# ─── Comptes ──────────────────────────────────────────────────────────────────
# Lier les comptes à un SSO déjà configuré dans Mattermost (openid, gitlab,
# google, office365, saml, ldap) : auth_data = email. Vide = mots de passe locaux
# (voir \`rocket2matter reset-password\`).
AUTH_SERVICE=

# ─── Options ──────────────────────────────────────────────────────────────────
# État lu/non-lu par utilisateur : last-seen (fidèle à RocketChat) | read | unread
READ_STATE=last-seen
# Archiver tous les canaux (en plus de ceux archivés dans RocketChat).
ARCHIVE_CHANNELS=false
# Répertoire de travail et archive produite.
OUT_DIR=out
ZIP_FILE=mattermost-import.zip

# Réglages avancés (voir le README) : MM_DIR, MMCTL, MM_SERVICE, TARGET_PSQL,
# WATCHDOG, WATCHDOG_IO_HIGH, EXPORT_FILES, EXPORT_DIRECT, MERGE_DISCUSSIONS…
`;

export async function runInit(): Promise<void> {
  if (existsSync(DEFAULT_CONFIG_FILE)) {
    console.log(`${DEFAULT_CONFIG_FILE} existe déjà — rien n'a été modifié.`);
    return;
  }
  await writeFile(DEFAULT_CONFIG_FILE, TEMPLATE);
  console.log(`✅ ${DEFAULT_CONFIG_FILE} créé. Complétez-le, puis :\n   rocket2matter preflight\n   rocket2matter migrate`);
}
