#!/bin/bash
# Runs on the EC2 server (sent by CI through SSM).
# Swaps the app container to $IMAGE and rolls back if it doesn't come up healthy.
set -uo pipefail

: "${IMAGE:?IMAGE must be set}"

start_app() {
  docker run -d --name app --network pixel --restart unless-stopped \
    -p 80:3000 \
    -e REDIS_URL=redis://redis:6379 \
    -e DRAIN_MS=0 \
    "$1"
}

# 0 when /readyz returns 200 within 30 s
wait_healthy() {
  for _ in $(seq 1 30); do
    if curl -sf http://localhost/readyz > /dev/null; then
      return 0
    fi
    sleep 1
  done
  return 1
}


PREVIOUS=$(docker inspect --format '{{.Config.Image}}' app)
echo "Currently running: $PREVIOUS"

if ! docker pull "$IMAGE"; then
  echo "Pull failed: $IMAGE"
  exit 1
fi

docker rm -f app
start_app "$IMAGE"

if wait_healthy; then
  echo "Deployed $IMAGE"
  exit 0
else
  echo "New image unhealthy, rolling back to $PREVIOUS"
  docker rm -f app
  start_app "$PREVIOUS"
  exit 1
fi


