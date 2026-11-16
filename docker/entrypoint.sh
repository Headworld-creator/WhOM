#!/bin/sh
set -e

# Render tells us which port to bind via $PORT.
PORT="${PORT:-10000}"
sed -ri "s/^Listen .*/Listen ${PORT}/" /etc/apache2/ports.conf
sed -ri "s/<VirtualHost \*:[0-9]+>/<VirtualHost *:${PORT}>/" /etc/apache2/sites-available/000-default.conf

# Create tables on boot. Never block startup if the DB is briefly unreachable:
# the first API request retries the migration automatically (AUTO_MIGRATE).
if [ "${AUTO_MIGRATE:-true}" = "true" ]; then
  php /var/www/html/server.php migrate || echo "[entrypoint] migration skipped (DB not reachable yet)"
fi

exec apache2-foreground
