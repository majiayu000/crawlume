#!/bin/sh
# Generates local-only secrets for the Compose deployment into deploy/compose/.secrets (gitignored):
# a throwaway CA and TLS certificate for the test identity provider, Ed25519 token signing keys,
# the webhook encryption key, and the Postgres password. Existing files are kept.
set -eu

cd "$(dirname "$0")"
umask 077
mkdir -p .secrets
cd .secrets

if [ ! -f ca.key ]; then
  openssl req -x509 -newkey rsa:2048 -nodes -days 30 -subj "/CN=crawlume-local-ca" \
    -keyout ca.key -out ca.crt >/dev/null 2>&1
fi
if [ ! -f idp.p12 ]; then
  openssl req -newkey rsa:2048 -nodes -subj "/CN=idp" -keyout idp.key -out idp.csr >/dev/null 2>&1
  printf 'subjectAltName=DNS:idp,DNS:localhost\nextendedKeyUsage=serverAuth\n' > idp.ext
  openssl x509 -req -in idp.csr -CA ca.crt -CAkey ca.key -CAcreateserial -days 30 \
    -extfile idp.ext -out idp.crt >/dev/null 2>&1
  openssl pkcs12 -export -inkey idp.key -in idp.crt -certfile ca.crt -name idp \
    -passout pass:crawlume-local -out idp.p12
fi
if [ ! -f control.crt ]; then
  openssl req -newkey rsa:2048 -nodes -subj "/CN=localhost" -keyout control.key -out control.csr >/dev/null 2>&1
  printf 'subjectAltName=DNS:localhost,IP:127.0.0.1\nextendedKeyUsage=serverAuth\n' > control.ext
  openssl x509 -req -in control.csr -CA ca.crt -CAkey ca.key -CAcreateserial -days 30 \
    -extfile control.ext -out control.crt >/dev/null 2>&1
fi
for name in human-access-token worker-session; do
  if [ ! -f "$name.key" ]; then
    openssl genpkey -algorithm ed25519 -out "$name.key"
    openssl pkey -in "$name.key" -pubout -out "$name.pub"
  fi
done
[ -f webhook.key ] || openssl rand -out webhook.key 32
[ -f postgres-password ] || openssl rand -hex 24 | tr -d '\n' > postgres-password

# Public material is world-readable; private keys stay 0600 and the control plane runs as this
# host user (see HOST_UID/HOST_GID in .env) so it can read them through the bind mount.
chmod 644 ca.crt idp.p12 control.crt human-access-token.pub worker-session.pub
chmod 600 control.key human-access-token.key worker-session.key webhook.key postgres-password
if [ ! -f ../.env ]; then
  printf 'HOST_UID=%s\nHOST_GID=%s\nPOSTGRES_PASSWORD=%s\n' "$(id -u)" "$(id -g)" "$(cat postgres-password)" > ../.env
  chmod 600 ../.env
fi
echo "Secrets ready in $(pwd)"
