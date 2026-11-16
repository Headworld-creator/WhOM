#!/bin/sh
# Spins up server.php on a throwaway SQLite DB and runs the API tests. Usage: sh tests/run.sh
set -e
cd "$(dirname "$0")/.."
DB=$(mktemp -u /tmp/whom-test-XXXXXX.db)
sqlite3 "$DB" < tests/sqlite_schema.sql 2>/dev/null || php -r '$p=new PDO("sqlite:$argv[1]");$p->exec(file_get_contents("tests/sqlite_schema.sql"));' "$DB"
export DB_DSN="sqlite:$DB" AUTO_MIGRATE=false APP_ENV=local APP_DEBUG=true JWT_SECRET=test-secret-test-secret-test-secret-123 CORS_ORIGINS="https://shop.example.com"
PORT=${PORT:-8099}
RATE_LIMIT=false php -S 127.0.0.1:$PORT server.php >/tmp/whom-php.log 2>&1 &
PID=$!
RATE_LIMIT=true php -S 127.0.0.1:$((PORT+1)) server.php >/tmp/whom-php2.log 2>&1 &
PID2=$!
trap 'kill $PID $PID2 2>/dev/null; rm -f "$DB"' EXIT
sleep 1
python3 tests/api_test.py "http://127.0.0.1:$PORT" "http://127.0.0.1:$((PORT+1))"
