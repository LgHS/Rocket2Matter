#!/usr/bin/env bash
# Throttled, watchdog-guarded RocketChat export — runs ON the RC host.
# Authorized in-session by the user despite the usual "don't export on prod"
# rule, BECAUSE the off-host tunnel is unusable (flaky VPN) and this run is
# I/O-deprioritized (ionice idle + nice 19) and auto-aborted on load spikes.
set -u
cd /root/r2m || exit 1
rm -rf out export.log watchdog.log

NCPU=$(nproc 2>/dev/null || echo 2)
THRESH=$((NCPU + 2))   # abort if 1-min load average reaches this
URI="mongodb://172.18.0.2:27017/rocketchat?directConnection=true&serverSelectionTimeoutMS=600000&connectTimeoutMS=120000&socketTimeoutMS=0&heartbeatFrequencyMS=60000&retryReads=true"

ionice -c3 nice -n19 env \
  MONGO_URI="$URI" DB_NAME=rocketchat \
  TEAM_NAME=lghs TEAM_DISPLAY_NAME=LGHS READ_STATE=last-seen \
  OUT_DIR=/root/r2m/out \
  nohup ./node-v22.12.0-linux-x64/bin/node cli.cjs export > export.log 2>&1 &
EPID=$!
echo "export pid=$EPID ncpu=$NCPU watchdog_threshold_load1=$THRESH"

# Watchdog: protect production. Abort the export if the host load spikes
# (CPU or I/O saturation both show up as load) or mongo stops answering.
nohup bash -c '
EPID='"$EPID"'; THRESH='"$THRESH"'
log(){ echo "$(date +%H:%M:%S) $*" >> /root/r2m/watchdog.log; }
log "watchdog start (pid_export=$EPID threshold=$THRESH)"
fails=0
while kill -0 "$EPID" 2>/dev/null; do
  L=$(awk "{print \$1}" /proc/loadavg)
  if awk "BEGIN{exit !($L >= $THRESH)}"; then
    log "ABORT: load1=$L >= $THRESH — killing export"
    kill "$EPID" 2>/dev/null; sleep 2; kill -9 "$EPID" 2>/dev/null
    break
  fi
  # mongo liveness (cheap ping); 3 consecutive failures => abort
  if ! timeout 8 docker exec chatlghsbe-mongo-1 mongosh --quiet --eval "db.adminCommand({ping:1})" >/dev/null 2>&1; then
    fails=$((fails+1)); log "mongo ping fail #$fails (load1=$L)"
    if [ "$fails" -ge 3 ]; then log "ABORT: mongo unresponsive — killing export"; kill "$EPID" 2>/dev/null; sleep 2; kill -9 "$EPID" 2>/dev/null; break; fi
  else
    fails=0
  fi
  sleep 15
done
log "watchdog exit (export ended or aborted)"
' >/dev/null 2>&1 &
disown -a 2>/dev/null || true
echo "watchdog started"
