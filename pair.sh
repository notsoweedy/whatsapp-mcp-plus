#!/bin/zsh
# Pairs this machine as a WhatsApp linked device and runs the initial history sync.
# Run after `npm install && npm run build`.
cd "${0:A:h}"
export WAMCP_DATA_DIR=${WAMCP_DATA_DIR:-$PWD/data} WAMCP_AUTH_DIR=${WAMCP_AUTH_DIR:-$PWD/auth_info} WAMCP_MODE=read-only
echo "Scan the QR below: WhatsApp on phone > Settings > Linked Devices > Link a device"
echo "After it says 'Connected', leave this open ~3-5 min for history to sync, then press Ctrl+C."
node dist/index.js
