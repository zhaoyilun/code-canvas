#!/bin/sh
# Mirrors docker/images/n8n/docker-entrypoint.sh from the n8n snapshot.
if [ -d /opt/custom-certificates ]; then
  echo "Trusting custom certificates from /opt/custom-certificates."
  export NODE_OPTIONS="--use-openssl-ca $NODE_OPTIONS"
  export SSL_CERT_DIR=/opt/custom-certificates
  c_rehash /opt/custom-certificates
fi

if [ "$#" -gt 0 ]; then
  exec "$@"
else
  exec n8n
fi
