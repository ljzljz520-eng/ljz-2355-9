#!/usr/bin/env bash
# 在无 root 的机器上把 Debian 包中的 PostgreSQL 解压到用户目录并启动（端口 5433）
set -euo pipefail
PGBIN="${PGBIN:-/tmp/pglocal/usr/lib/postgresql/15/bin}"
PGDATA="${PGDATA:-/tmp/pgdata}"
SOCKET=/tmp
PORT=5433
DB=finance_training
case "${1:-start}" in
  start)
    if [ ! -x "$PGBIN/postgres" ]; then
      mkdir -p /tmp/pgdeb && cd /tmp/pgdeb
      apt-get download postgresql-15 postgresql-client-15
      mkdir -p /tmp/pglocal
      for d in *.deb; do dpkg-deb -x "$d" /tmp/pglocal; done
    fi
    [ -d "$PGDATA" ] || "$PGBIN/initdb" -D "$PGDATA" -U postgres --auth=trust --no-locale -E UTF8
    "$PGBIN/pg_ctl" -D "$PGDATA" -o "-p $PORT -k $SOCKET" -l /tmp/pg.log start
    sleep 1
    "$PGBIN/psql" -h "$SOCKET" -p "$PORT" -U postgres -tc "SELECT 1 FROM pg_database WHERE datname='$DB'" | grep -q 1 || \
      "$PGBIN/createdb" -h "$SOCKET" -p "$PORT" -U postgres "$DB"
    echo "PostgreSQL ready: postgres://postgres@localhost:$PORT/$DB?host=$SOCKET"
    ;;
  stop) "$PGBIN/pg_ctl" -D "$PGDATA" stop ;;
  psql) "$PGBIN/psql" -h "$SOCKET" -p "$PORT" -U postgres "$DB" ;;
  *) echo "usage: $0 start|stop|psql"; exit 1 ;;
esac
