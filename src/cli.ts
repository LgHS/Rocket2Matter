// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Single entry point of the RocketChat → Mattermost migration tool.
 * Groups the subcommands behind one CLI, which also makes it possible to
 * compile a standalone binary (Node SEA).
 */
// Must stay the first import: loads the config file into process.env before
// config.ts (imported by everything below) reads it.
import { configFile } from "./env.js";
import { runPackage } from "./package.js";
import { runResetPassword } from "./reset-password.js";
import {
  STEPS,
  runCleanup,
  runExportStep,
  runImport,
  runInit,
  runMigrate,
  runPostImport,
  runPreflight,
  runUpload,
  runVerify,
} from "./steps.js";
import pkg from "../package.json" with { type: "json" };

// Note: in the standalone binary (SEA), Node prints an informational warning on
// stderr ("require() … only supports loading built-in modules"). It is benign
// (all code is bundled) and emitted by the loader before our code runs; only
// NODE_NO_WARNINGS=1 at launch hides it. The stdout output stays clean.

const HELP = `Rocket2Matter ${pkg.version} — migration RocketChat → Mattermost

Usage : rocket2matter <commande> [--config fichier] [--yes]

Démarrage :
  init             Crée rocket2matter.env (configuration commentée à compléter)
  preflight        Vérifie source, machine locale et cible ; propose les corrections
  migrate          Enchaîne toutes les étapes ci-dessous, avec reprise après échec
                   options : --from <étape>  reprendre/refaire à partir d'une étape

Étapes (dans l'ordre) :
  export           Lit RocketChat (tunnel SSH + watchdog si SOURCE_SSH) → out/
  package          Empaquette out/ dans l'archive d'import (ZIP_FILE)
  upload           Dépose l'archive sur le serveur Mattermost (reprise, contrôle)
  import           Lance l'import mmctl et attend sa fin
  post-import      Désactive les comptes inactifs, applique l'état lu/non-lu
  verify           Compare ce qui est dans Mattermost à ce qui a été exporté
  cleanup          Supprime l'archive déposée sur le serveur

Autres :
  reset-password   Réinitialise le mot de passe d'un utilisateur (sans SSO)
                   options : --dry-run

Options :
  -c, --config F   Fichier de configuration (défaut : ./rocket2matter.env)
  -y, --yes        Répond oui à toutes les confirmations (exécution non interactive)
  -h, --help       Affiche cette aide
  -v, --version    Affiche la version

Toute la configuration passe par le fichier (ou des variables d'environnement) :
voir \`rocket2matter init\` et le README.`;

function flagValue(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function main() {
  const cmd = process.argv[2];
  if (configFile && cmd && !cmd.startsWith("-") && cmd !== "init") {
    console.log(`(configuration : ${configFile})`);
  }
  switch (cmd) {
    case "init":
      return runInit();
    case "preflight":
      if (!(await runPreflight())) process.exitCode = 1;
      return;
    case "migrate":
      return runMigrate(flagValue("--from"));
    case "export":
      return runExportStep();
    case "package":
      return runPackage();
    case "upload":
      await runUpload();
      return;
    case "import":
      return runImport();
    case "post-import":
      return runPostImport();
    case "verify":
      if (!(await runVerify())) process.exitCode = 1;
      return;
    case "cleanup":
      return runCleanup();
    case "reset-password":
      return runResetPassword();
    case "-v":
    case "--version":
      console.log(pkg.version);
      return;
    case undefined:
    case "-h":
    case "--help":
      console.log(HELP);
      return;
    default:
      console.error(`Commande inconnue : ${cmd}\n`);
      console.log(HELP);
      process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error("\n❌ Erreur :", (err as Error)?.message ?? err);
  if (process.argv[2] === "migrate") {
    console.error(`   Corrigez puis relancez \`rocket2matter migrate\` : il reprendra à l'étape interrompue (${STEPS.join(" → ")}).`);
  }
  process.exit(1);
});
