#!/usr/bin/env bash
# Private Share — one-shot setup on a Google Cloud VM (app + TURN relay on the same VM).
# Usage (from the project folder):   bash deploy/gcp-setup.sh
# Optional: bash deploy/gcp-setup.sh turn.share.rakzu.xyz   (use a DNS name instead of the IP)
set -euo pipefail
cd "$(dirname "$0")/.."

SUDO=""; [ "$(id -u)" -eq 0 ] || SUDO="sudo"
say() { printf '\n\033[1;33m==>\033[0m %s\n' "$*"; }
md() { curl -fs --max-time 3 -H 'Metadata-Flavor: Google' "http://metadata.google.internal/computeMetadata/v1/$1" 2>/dev/null || true; }

command -v docker >/dev/null || { echo "Docker is not installed. Install it first: https://docs.docker.com/engine/install/ubuntu/"; exit 1; }
$SUDO docker compose version >/dev/null 2>&1 || { echo "The Docker Compose plugin is missing: sudo apt-get install -y docker-compose-plugin"; exit 1; }

say "Reading this VM's addresses from Google Cloud"
PUBLIC_IP=$(md instance/network-interfaces/0/access-configs/0/external-ip)
PRIVATE_IP=$(md instance/network-interfaces/0/ip)
ZONE=$(md instance/zone); ZONE=${ZONE##*/}
NAME=$(md instance/name)
NETWORK=$(md instance/network-interfaces/0/network); NETWORK=${NETWORK##*/}
[ -n "$PUBLIC_IP" ] || PUBLIC_IP=$(curl -fs --max-time 5 https://api.ipify.org || true)
[ -n "$PRIVATE_IP" ] || PRIVATE_IP=$(hostname -I | awk '{print $1}')
if [ -z "$PUBLIC_IP" ]; then echo "This VM has no external IP. Give it one in the Google Cloud console, then run this again."; exit 1; fi
echo "Public IP:  $PUBLIC_IP"
echo "Private IP: $PRIVATE_IP"

TURN_NAME=${1:-$PUBLIC_IP}

[ -f .env ] || cp .env.example .env
set_env() {
  if grep -q "^$1=" .env; then sed -i "s|^$1=.*|$1=$2|" .env; else printf '%s=%s\n' "$1" "$2" >> .env; fi
}
SECRET=$(grep '^TURN_SHARED_SECRET=' .env | cut -d= -f2- || true)
if [ "${#SECRET}" -lt 32 ] || [[ "$SECRET" == *REPLACE* ]]; then
  say "Generating a new TURN secret"
  set_env TURN_SHARED_SECRET "$(openssl rand -hex 32)"
fi
set_env TURN_HOST "$TURN_NAME"
set_env TURN_PUBLIC_IP "$PUBLIC_IP/$PRIVATE_IP"
set_env TURN_PORT 3478
grep -q '^DEV_LOGIN=' .env || set_env DEV_LOGIN false
chmod 600 .env

if command -v ufw >/dev/null && $SUDO ufw status 2>/dev/null | grep -q "Status: active"; then
  say "Opening TURN ports in ufw"
  $SUDO ufw allow 3478/udp; $SUDO ufw allow 3478/tcp; $SUDO ufw allow 49160:49200/udp
fi

APP_PORT=$(grep '^HOST_PORT=' .env | cut -d= -f2 || true); APP_PORT=${APP_PORT:-8188}
PROJECT=$(basename "$PWD" | tr '[:upper:]' '[:lower:]' | tr -cd 'a-z0-9_-')
OLD=$($SUDO docker ps --filter "publish=$APP_PORT" --format '{{.Names}} {{.Label "com.docker.compose.project"}}' 2>/dev/null | awk -v p="$PROJECT" '$2 != p {print $1}' || true)
if [ -n "$OLD" ]; then
  say "Stopping the old version that is using port $APP_PORT: $OLD"
  # shellcheck disable=SC2086
  $SUDO docker stop $OLD
fi

say "Building and starting the app"
$SUDO docker compose up -d --build --remove-orphans app
say "Starting the TURN relay (coturn)"
$SUDO docker compose --profile turn up -d coturn
sleep 4

say "Checking"
if curl -fs --max-time 5 "http://127.0.0.1:$APP_PORT/api/health" >/dev/null; then
  echo "App:     running on 127.0.0.1:$APP_PORT"
else
  echo "App:     NOT responding. Run: sudo docker compose logs --tail=80 app"
fi
if $SUDO ss -lunp 2>/dev/null | grep -q ':3478 '; then
  echo "coturn:  listening on UDP 3478"
else
  echo "coturn:  NOT listening. Run: sudo docker compose logs --tail=80 coturn"
fi

cat <<EOF

Last step: allow the TURN ports through Google Cloud's firewall.
Open Cloud Shell (the >_ icon in the console) and run these once:

  gcloud compute instances add-tags ${NAME:-YOUR_VM_NAME} --tags=turn-server --zone=${ZONE:-YOUR_ZONE}

  gcloud compute firewall-rules create allow-private-share-turn \\
    --network=${NETWORK:-default} --direction=INGRESS --action=ALLOW \\
    --rules=udp:3478,tcp:3478,udp:49160-49200 \\
    --source-ranges=0.0.0.0/0 --target-tags=turn-server

Strongly recommended: make the IP permanent (an ephemeral IP changes if the VM stops):

  gcloud compute addresses create private-share-ip --addresses=$PUBLIC_IP --region=${ZONE%-*}

Then open https://share.rakzu.xyz, sign in, click the lock icon → "Check relay".
EOF
