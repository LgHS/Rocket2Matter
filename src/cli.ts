/**
 * Single entry point of the RocketChat → Mattermost migration tool.
 * Groups the subcommands behind one CLI, which also makes it possible to
 * compile a standalone binary (Node SEA).
 *
 *   rocketchat-mattermost export
 *   rocketchat-mattermost package
 *   rocketchat-mattermost reset-password [--dry-run]
 */
import { runExport } from "./index.js";
import { runPackage } from "./package.js";
import { runResetPassword } from "./reset-password.js";
import pkg from "../package.json" with { type: "json" };

// Note: in the standalone binary (SEA), Node prints an informational warning on
// stderr ("require() … only supports loading built-in modules"). It is benign
// (all code is bundled) and emitted by the loader before our code runs; only
// NODE_NO_WARNINGS=1 at launch hides it. The stdout output stays clean.

const HELP = `rocketchat-mattermost ${pkg.version} — migration RocketChat → Mattermost

Usage : rocketchat-mattermost <commande> [options]

Commandes :
  export           Lit MongoDB (RocketChat) et écrit out/import.jsonl + out/data/
  package          Empaquette out/ dans mattermost-import.zip
  reset-password   Réinitialise le mot de passe d'un utilisateur migré (interactif)
                   options : --dry-run

Options :
  -h, --help       Affiche cette aide
  -v, --version    Affiche la version

Configuration : voir les variables d'environnement (MONGO_URI, TEAM_NAME, …)
documentées dans le README.`;

async function main() {
  const cmd = process.argv[2];
  switch (cmd) {
    case "export":
      await runExport();
      break;
    case "package":
      await runPackage();
      break;
    case "reset-password":
      await runResetPassword();
      break;
    case "-v":
    case "--version":
      console.log(pkg.version);
      break;
    case undefined:
    case "-h":
    case "--help":
      console.log(HELP);
      break;
    default:
      console.error(`Commande inconnue : ${cmd}\n`);
      console.log(HELP);
      process.exit(1);
  }
}

main().catch((err) => {
  console.error("❌ Erreur :", (err as Error)?.message ?? err);
  process.exit(1);
});
