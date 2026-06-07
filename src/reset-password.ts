// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Resets the password of ONE migrated user (system user / admin), to let them
 * log in after the import — without creating a synthetic admin account.
 *
 * Reads the user list from the export (out/import.jsonl), offers an interactive
 * search, asks for the password (masked input), then runs
 * `mmctl --local user change-password` on the Mattermost server.
 *
 *   pnpm reset-password            # interactive
 *   pnpm reset-password --dry-run  # prints the command without running it
 */
import { execFile } from "node:child_process";
import { createReadStream, existsSync } from "node:fs";
import { createInterface, type Interface } from "node:readline";
import * as path from "node:path";
import { promisify } from "node:util";
import { config } from "./config.js";

const exec = promisify(execFile);

interface Candidate {
  username: string;
  name: string;
  admin: boolean;
}

async function loadUsers(): Promise<Candidate[]> {
  const jsonlPath = path.join(path.resolve(config.outDir), config.jsonlFile);
  if (!existsSync(jsonlPath)) {
    throw new Error(
      `${jsonlPath} introuvable — lancez d'abord l'export (pnpm export).`,
    );
  }
  const out: Candidate[] = [];
  const rl = createInterface({
    input: createReadStream(jsonlPath),
    crlfDelay: Infinity,
  });
  for await (const line of rl) {
    if (!line.includes('"type":"user"')) continue;
    let o: {
      type: string;
      user?: {
        username: string;
        roles?: string;
        first_name?: string;
        last_name?: string;
      };
    };
    try {
      o = JSON.parse(line);
    } catch {
      continue;
    }
    if (o.type !== "user" || !o.user) continue;
    out.push({
      username: o.user.username,
      name: `${o.user.first_name ?? ""} ${o.user.last_name ?? ""}`.trim(),
      admin: (o.user.roles ?? "").includes("system_admin"),
    });
  }
  out.sort((a, b) => a.username.localeCompare(b.username));
  return out;
}

// --- Interactive helpers on a single readline interface ---

interface MutableRl extends Interface {
  _writeToOutput?: (s: string) => void;
}

function ask(rl: Interface, question: string, fallback = ""): Promise<string> {
  const suffix = fallback ? ` [${fallback}]` : "";
  return new Promise((resolve) => {
    rl.question(`${question}${suffix} `, (answer) =>
      resolve(answer.trim() || fallback),
    );
  });
}

/** Masked input: the question is shown, but not what is typed. */
function askSecret(rl: MutableRl, question: string): Promise<string> {
  return new Promise((resolve) => {
    let muted = false;
    const original = rl._writeToOutput?.bind(rl);
    rl._writeToOutput = (s: string) => {
      if (!muted || s.includes("\n") || s.includes("\r")) original?.(s);
    };
    rl.question(question + " ", (value) => {
      muted = false;
      rl._writeToOutput = original;
      resolve(value);
    });
    muted = true; // after the question is displayed
  });
}

/** Escapes a value for a remote shell (single-quoted). */
function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

type Mode = "ssh" | "docker" | "mmctl";
interface Invocation {
  file: string;
  args: string[];
}

/** Picks the execution mode (env MM_EXEC, or interactive question). */
async function chooseMode(rl: Interface): Promise<Mode> {
  const fromEnv = process.env.MM_EXEC as Mode | undefined;
  if (fromEnv === "ssh" || fromEnv === "docker" || fromEnv === "mmctl") {
    return fromEnv;
  }
  // default: SSH if a host is configured, otherwise local Docker
  const def: Mode = config.sshHost ? "ssh" : "docker";
  const labels: Record<Mode, string> = {
    ssh: "1",
    docker: "2",
    mmctl: "3",
  };
  console.log("\nOù s'exécute Mattermost / mmctl ?");
  console.log("  1. SSH distant   (ssh <hôte> docker exec … mmctl)");
  console.log("  2. Docker local  (docker exec … mmctl)");
  console.log("  3. mmctl local   (mmctl directement)");
  const ans = await ask(rl, "Choix :", labels[def]);
  if (ans === "1" || ans.toLowerCase() === "ssh") return "ssh";
  if (ans === "3" || ans.toLowerCase() === "mmctl") return "mmctl";
  return "docker";
}

/** Builds the command to run depending on the mode. */
async function buildInvocation(
  rl: Interface,
  mode: Mode,
  username: string,
  password: string,
): Promise<Invocation> {
  const mmctlArgs = [
    "--local",
    "user",
    "change-password",
    username,
    "--password",
    password,
  ];

  if (mode === "mmctl") {
    return { file: "mmctl", args: mmctlArgs };
  }

  const container = await ask(
    rl,
    "Conteneur Docker Mattermost :",
    config.mmContainer,
  );
  const dockerArgs = ["exec", container, "mmctl", ...mmctlArgs];

  if (mode === "docker") {
    return config.mmDockerSudo
      ? { file: "sudo", args: ["docker", ...dockerArgs] }
      : { file: "docker", args: dockerArgs };
  }

  // SSH mode: remote command as a single string, escaped for the remote shell
  const sshHost =
    config.sshHost ||
    (await ask(rl, "Hôte SSH du serveur Mattermost (ex. debian@1.2.3.4) :"));
  if (!sshHost) {
    console.error("❌ Hôte SSH requis.");
    process.exit(1);
  }
  const sudo = config.mmDockerSudo ? "sudo " : "";
  const remoteCmd =
    `${sudo}docker exec ${shellQuote(container)} mmctl ` +
    mmctlArgs.map(shellQuote).join(" ");
  // BatchMode=yes: KEY-only authentication — ssh triggers no interactive input
  // (password / passphrase) and fails immediately if no key is available,
  // instead of blocking on a prompt.
  return {
    file: "ssh",
    args: [
      "-o",
      "BatchMode=yes",
      "-o",
      "ConnectTimeout=20",
      sshHost,
      remoteCmd,
    ],
  };
}

/** Human-readable representation of the command, password masked. */
function displayCommand(inv: Invocation, password: string): string {
  const safe = inv.args.map((a) =>
    a === password ? "********" : a.replace(password, "********"),
  );
  return [inv.file, ...safe].join(" ");
}

export async function runResetPassword() {
  console.log(
    "🔑 Réinitialisation d'un mot de passe utilisateur (post-import)\n",
  );

  const users = await loadUsers();
  console.log(
    `${users.length} utilisateurs migrés (${users.filter((u) => u.admin).length} admins).`,
  );

  const rl: MutableRl = createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  try {
    // 1. User selection (search)
    let chosen: Candidate | undefined;
    while (!chosen) {
      const q = (
        await ask(rl, "\nRechercher (nom/username, vide = liste des admins) :")
      ).toLowerCase();
      const matches = q
        ? users.filter(
            (u) =>
              u.username.toLowerCase().includes(q) ||
              u.name.toLowerCase().includes(q),
          )
        : users.filter((u) => u.admin);

      if (matches.length === 0) {
        console.log("  Aucun résultat.");
        continue;
      }
      matches.slice(0, 25).forEach((u, i) => {
        console.log(
          `  ${String(i + 1).padStart(2)}. ${u.username}${u.admin ? " (admin)" : ""}${u.name ? ` — ${u.name}` : ""}`,
        );
      });
      if (matches.length > 25)
        console.log(`  … (${matches.length - 25} de plus)`);

      const pick = await ask(rl, "Numéro ou username exact :");
      const byNum = Number(pick);
      if (
        Number.isInteger(byNum) &&
        byNum >= 1 &&
        byNum <= Math.min(25, matches.length)
      ) {
        chosen = matches[byNum - 1];
      } else {
        chosen = users.find((u) => u.username === pick);
      }
      if (!chosen) console.log("  Sélection invalide, on recommence.");
    }

    console.log(
      `\n→ Utilisateur choisi : ${chosen.username}${chosen.admin ? " (admin)" : ""}`,
    );

    // 2. Password (masked input + confirmation)
    let password = "";
    for (;;) {
      password = await askSecret(rl, "Nouveau mot de passe :");
      if (password.length < 8) {
        console.log("  ⚠️  Trop court (8 caractères minimum). Réessayez.");
        continue;
      }
      const confirm = await askSecret(rl, "Confirmer le mot de passe :");
      if (password !== confirm) {
        console.log("  ⚠️  Les mots de passe ne correspondent pas. Réessayez.");
        continue;
      }
      break;
    }

    // 3. Execution mode (where does mmctl run?)
    const mode = await chooseMode(rl);

    // 4. Build the command depending on the mode
    const inv = await buildInvocation(rl, mode, chosen.username, password);

    // Dry-run mode: run nothing, print the command (password masked).
    if (process.argv.includes("--dry-run") || process.env.DRY_RUN === "1") {
      console.log("\n[dry-run] commande qui serait exécutée :");
      console.log(`  ${displayCommand(inv, password)}`);
      return;
    }

    console.log(`\n⏳ Réinitialisation de "${chosen.username}"…`);
    try {
      const { stdout, stderr } = await exec(inv.file, inv.args, {
        maxBuffer: 16 * 1024 * 1024,
      });
      const output = (stdout + stderr).trim();
      if (output) console.log(output);
      console.log(`\n✅ Mot de passe de "${chosen.username}" réinitialisé.`);
      console.log(
        "   L'utilisateur peut désormais se connecter avec ce mot de passe.",
      );
    } catch (err) {
      const msg = `${(err as Error).message ?? err}`;
      if (mode === "ssh" && /permission denied|publickey|Host key/i.test(msg)) {
        console.error(
          "\n❌ Connexion SSH refusée. Le mode SSH exige une authentification" +
            " par clé (BatchMode) — aucun mot de passe n'est demandé.\n" +
            "   Vérifiez que votre clé est autorisée sur le serveur, p. ex. :\n" +
            "     ssh-copy-id <hôte>   et/ou   ssh-add <clé>",
        );
      } else {
        console.error("\n❌ Échec de la réinitialisation :\n   " + msg);
      }
      process.exit(1);
    }
  } finally {
    rl.close();
  }
}