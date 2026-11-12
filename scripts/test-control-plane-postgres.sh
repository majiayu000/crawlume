#!/bin/sh
set -eu

if ! command -v docker >/dev/null 2>&1; then
  echo "The control-plane PostgreSQL Gate requires Docker." >&2
  exit 1
fi
if ! docker info >/dev/null 2>&1; then
  echo "The control-plane PostgreSQL Gate requires a running Docker daemon." >&2
  exit 1
fi

container_name="diaoyan-postgres-test-$$"
test_password="$(od -An -N16 -tx1 /dev/urandom | tr -d ' \n')"

cleanup() {
  test_status=$?
  trap - EXIT INT TERM
  if docker inspect "$container_name" >/dev/null 2>&1; then
    if ! docker rm --force "$container_name" >/dev/null; then
      echo "Failed to remove PostgreSQL test container $container_name." >&2
      if [ "$test_status" -eq 0 ]; then
        test_status=1
      fi
    fi
  fi
  exit "$test_status"
}
trap cleanup EXIT INT TERM

docker run \
  --detach \
  --rm \
  --name "$container_name" \
  --env "POSTGRES_PASSWORD=$test_password" \
  --tmpfs /var/lib/postgresql/data \
  --publish 127.0.0.1::5432 \
  postgres:16-alpine >/dev/null

attempt=0
until docker exec "$container_name" pg_isready --username postgres --dbname postgres >/dev/null 2>&1; do
  attempt=$((attempt + 1))
  if [ "$attempt" -ge 30 ]; then
    echo "PostgreSQL did not become ready within 30 seconds." >&2
    docker logs "$container_name" >&2
    exit 1
  fi
  sleep 1
done

postgres_port="$(docker port "$container_name" 5432/tcp | sed -n 's/.*://p' | head -n 1)"
if [ -z "$postgres_port" ]; then
  echo "Docker did not publish the PostgreSQL test port." >&2
  exit 1
fi

test_database_url="postgresql://postgres:$test_password@127.0.0.1:$postgres_port/postgres"

DIAOYAN_TEST_POSTGRES_URL="$test_database_url" PGCONNECT_TIMEOUT=5 \
  pnpm exec vitest run tests/control-plane-job-postgres.integration.test.ts --maxWorkers=1

DIAOYAN_TEST_POSTGRES_URL="$test_database_url" PGCONNECT_TIMEOUT=5 \
  pnpm exec vitest run tests/control-plane-job-postgres-locking.integration.test.ts --maxWorkers=1

DIAOYAN_TEST_POSTGRES_URL="$test_database_url" PGCONNECT_TIMEOUT=5 \
  pnpm exec vitest run tests/control-plane-postgres.integration.test.ts --maxWorkers=1

DIAOYAN_TEST_POSTGRES_URL="$test_database_url" PGCONNECT_TIMEOUT=5 \
  pnpm exec vitest run tests/control-plane-auth-postgres.integration.test.ts --maxWorkers=1

DIAOYAN_TEST_POSTGRES_URL="$test_database_url" PGCONNECT_TIMEOUT=5 \
  pnpm exec vitest run tests/control-plane-project-admin-postgres.integration.test.ts --maxWorkers=1

DIAOYAN_TEST_POSTGRES_URL="$test_database_url" PGCONNECT_TIMEOUT=5 \
  pnpm exec vitest run tests/control-plane-artifact-postgres.integration.test.ts --maxWorkers=1

DIAOYAN_TEST_POSTGRES_URL="$test_database_url" PGCONNECT_TIMEOUT=5 \
  pnpm exec vitest run tests/control-plane-metrics-postgres.integration.test.ts --maxWorkers=1

DIAOYAN_TEST_POSTGRES_URL="$test_database_url" PGCONNECT_TIMEOUT=5 \
  pnpm exec vitest run tests/control-plane-storage-postgres.integration.test.ts --maxWorkers=1

DIAOYAN_TEST_POSTGRES_URL="$test_database_url" PGCONNECT_TIMEOUT=5 \
  pnpm exec vitest run tests/control-plane-bootstrap-postgres.e2e.test.ts --maxWorkers=1
