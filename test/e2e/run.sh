#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-or-later
#
# End-to-end test: real `rocket2matter migrate` from a seeded RocketChat MongoDB
# into a stock Mattermost running in Docker, then checks the result in its DB.
#
#   test/e2e/run.sh            # needs docker + docker compose
#   KEEP=1 test/e2e/run.sh     # leave the containers up afterwards
#
set -euo pipefail
cd "$(dirname "$0")"
ROOT=$(cd ../.. && pwd)
WORK="$PWD/work"
fail=0

cleanup() { [ "${KEEP:-}" = 1 ] || docker compose down -v >/dev/null 2>&1 || true; }
trap cleanup EXIT

echo "▶ conteneurs"
docker compose down -v >/dev/null 2>&1 || true
docker compose up -d --quiet-pull
printf "  attente de Mattermost"
for _ in $(seq 1 120); do
  docker exec r2m-e2e-mm mmctl --local system version >/dev/null 2>&1 && break
  printf "."; sleep 2
done
echo

# Deliberately too low: preflight must detect it and fix it (--yes).
docker exec r2m-e2e-mm mmctl --local config set TeamSettings.MaxUsersPerTeam 3 >/dev/null

echo "▶ données RocketChat de test"
(cd "$ROOT" && pnpm -s tsx test/e2e/seed.mts)

rm -rf "$WORK" && mkdir -p "$WORK"
cat > "$WORK/rocket2matter.env" <<EOF
MONGO_URI=mongodb://127.0.0.1:27099/rocketchat
TARGET_DOCKER=r2m-e2e-mm
TEAM_NAME=e2e
TEAM_DISPLAY_NAME=Équipe E2E
FILE_RATE_LIMIT=0
OUT_DIR=$WORK/out
ZIP_FILE=$WORK/import.zip
EOF

echo "▶ rocket2matter migrate --yes"
(cd "$WORK" && pnpm -s --dir "$ROOT" cli migrate --config "$WORK/rocket2matter.env" --yes) | tee "$WORK/migrate.log"

sql() { docker exec -i r2m-e2e-db psql -U mmuser -d mattermost -tAX -c "$1"; }
check() { # label, sql, expected
  local got; got=$(sql "$2" | tr -d '[:space:]')
  if [ "$got" = "$3" ]; then echo "  ✅ $1"; else echo "  ❌ $1 — obtenu « $got », attendu « $3 »"; fail=1; fi
}

echo "▶ vérifications dans Mattermost"
if docker exec r2m-e2e-mm mmctl --local system version >/dev/null 2>&1; then echo "  ✅ mode local activé par preflight"; else echo "  ❌ mode local inactif"; fail=1; fi
[ "$(docker exec r2m-e2e-mm mmctl --local config get TeamSettings.MaxUsersPerTeam)" -ge 500 ] \
  && echo "  ✅ MaxUsersPerTeam corrigé (≥ 500)" || { echo "  ❌ MaxUsersPerTeam non corrigé"; fail=1; }
check "team créée"                             "select displayname from teams where name='e2e'"        "ÉquipeE2E"
check "utilisateurs (3 + fantôme + dave)"      "select count(*) from users where email like '%e2e.test' or username='utilisateur-archive'" "5"
check "dave désactivé (inactif dans RC)"       "select deleteat>0 from users where email='dave@e2e.test'" "t"
check "bot ignoré"                             "select count(*) from users where email='cat@e2e.test'"  "0"
check "canal archivé resté archivé"            "select deleteat>0 from channels where name='vieux-projet'" "t"
check "discussion : pas de canal"              "select count(*) from channels where displayname like 'On en parle%'" "0"
check "discussion : thread de 2 réponses"      "select count(*) from posts r join posts p on p.id=r.rootid where p.message='On en parle ici ?'" "2"
check "réponse de thread rattachée"            "select count(*) from posts r join posts p on p.id=r.rootid where p.message='Bienvenue à tous !' and r.message='Merci !'" "1"
check "message épinglé"                        "select count(*) from posts where ispinned" "1"
check "message favori (flagged)"               "select count(*) from preferences where category='flagged_post'" "1"
check "réactions"                              "select count(*) from reactions where emojiname='tada'" "2"
check "fichier + légende"                      "select count(*) from fileinfo f join posts p on p.id=f.postid where p.message='Le schéma du projet'" "1"
check "avatar d'Alice"                         "select lastpictureupdate>0 from users where email='alice@e2e.test'" "t"
check "émoji + alias"                          "select count(*) from emoji where name in ('partyparrot','perroquet-fou')" "2"
check "alias en conflit avec un émoji système ignoré" "select count(*) from emoji where name='parrot'" "0"
grep -q "non importés : parrot" "$WORK/migrate.log" && echo "  ✅ verify explique l'émoji ignoré" || { echo "  ❌ verify n'explique pas l'émoji ignoré"; fail=1; }
check "DM et groupe"                           "select count(*) from channels where type in ('D','G')" "2"
check "DM visible dans la barre (Alice, Bob)"   "select count(*) from preferences where category='direct_channel_show' and value='true'" "2"
check "groupe visible sauf pour Carol (fermé)"  "select count(*) from preferences where category='group_channel_show' and value='true'" "2"
check "message système RC ignoré"              "select count(*) from posts where message='a rejoint'" "0"
check "auteur supprimé → reste attribué (dave)" "select u.email from posts p join users u on u.id=p.userid where p.message like 'Message de Dave%'" "dave@e2e.test"
# Read state, per user (from each user's RocketChat subscription)
unread() { echo "select c.totalmsgcountroot - cm.msgcountroot from channelmembers cm join channels c on c.id=cm.channelid join users u on u.id=cm.userid where u.email='$1' and $2"; }
check "Alice : general lu (flags RC, ls en retard)"  "$(unread alice@e2e.test "c.name='general'")"  "0"
check "Bob : general 1 non lu (après son ls)"        "$(unread bob@e2e.test "c.name='general'")"    "1"
check "Bob : mention reprise"                        "select cm.mentioncount from channelmembers cm join channels c on c.id=cm.channelid join users u on u.id=cm.userid where u.email='bob@e2e.test' and c.name='general'" "1"
check "Carol : general jamais ouvert → non lu"       "select c.totalmsgcountroot - cm.msgcountroot > 0 from channelmembers cm join channels c on c.id=cm.channelid join users u on u.id=cm.userid where u.email='carol@e2e.test' and c.name='general'" "t"
check "Alice : DM lu"                                "$(unread alice@e2e.test "c.type='D'")"        "0"
check "Bob : DM non lu"                              "$(unread bob@e2e.test "c.type='D'")"          "1"
check "Carol : groupe lu"                            "$(unread carol@e2e.test "c.type='G'")"        "0"
grep -q "Tout ce qui a été exporté est présent" "$WORK/migrate.log" && echo "  ✅ verify sans écart" || { echo "  ❌ verify signale des écarts"; fail=1; }

echo "▶ reprise : relancer migrate ne refait rien"
(cd "$WORK" && pnpm -s --dir "$ROOT" cli migrate --config "$WORK/rocket2matter.env" --yes) | grep -c "déjà fait" | grep -qx 8 \
  && echo "  ✅ les 8 étapes sont reconnues comme faites" || { echo "  ❌ la reprise refait des étapes"; fail=1; }

[ $fail = 0 ] && echo "🎉 E2E OK" || { echo "💥 E2E en échec"; exit 1; }
