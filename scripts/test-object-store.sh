#!/bin/sh
set -eu

if ! command -v docker >/dev/null 2>&1; then
  echo "The object-store Gate requires Docker." >&2
  exit 1
fi
if ! docker info >/dev/null 2>&1; then
  echo "The object-store Gate requires a running Docker daemon." >&2
  exit 1
fi

container_name="crawlume-s3-test-$$"

cleanup() {
  test_status=$?
  trap - EXIT INT TERM
  if docker inspect "$container_name" >/dev/null 2>&1; then
    if ! docker rm --force "$container_name" >/dev/null; then
      echo "Failed to remove S3 test container $container_name." >&2
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
  --env SERVICES=s3 \
  --publish 127.0.0.1::4566 \
  localstack/localstack:4.4.0 >/dev/null

s3_port="$(docker port "$container_name" 4566/tcp | sed -n 's/.*://p' | head -n 1)"
if [ -z "$s3_port" ]; then
  echo "Docker did not publish the S3 test port." >&2
  exit 1
fi

attempt=0
until curl --silent --fail "http://127.0.0.1:$s3_port/_localstack/health" | grep -q '"s3": "\(available\|running\)"'; do
  attempt=$((attempt + 1))
  if [ "$attempt" -ge 60 ]; then
    echo "The S3 emulator did not become ready within 60 seconds." >&2
    docker logs "$container_name" >&2
    exit 1
  fi
  sleep 1
done

# LocalStack accepts any credentials; these never leave the test container.
DIAOYAN_TEST_S3_ENDPOINT="http://127.0.0.1:$s3_port" \
AWS_ACCESS_KEY_ID=test AWS_SECRET_ACCESS_KEY=test AWS_REGION=us-east-1 \
  pnpm exec vitest run tests/artifact-object-store-s3.integration.test.ts --maxWorkers=1
