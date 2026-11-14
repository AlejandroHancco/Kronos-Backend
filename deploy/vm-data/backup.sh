#!/usr/bin/env bash
# Daily Postgres backup (custom format), keeps the 7 newest dumps.
# Cron (as the user that runs docker), daily at 03:00:
#   0 3 * * * /opt/smartconcrete/deploy/vm-data/backup.sh >> /var/log/sc-backup.log 2>&1
set -euo pipefail

cd "$(dirname "$0")"
mkdir -p backups

# POSTGRES_USER / POSTGRES_DB are read from the container's own environment.
docker compose exec -T postgres sh -c 'pg_dump -Fc -U "$POSTGRES_USER" "$POSTGRES_DB"' \
  > "backups/$(date +%F).dump.tmp"
mv "backups/$(date +%F).dump.tmp" "backups/$(date +%F).dump"

# Retention: keep the 7 newest
ls -1t backups/*.dump 2>/dev/null | tail -n +8 | xargs -r rm -f --
echo "backup ok: backups/$(date +%F).dump"
