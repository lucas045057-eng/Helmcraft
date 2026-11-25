#!/usr/bin/env bash
set -euo pipefail
mkdir -p ~/.config/systemd/user
cat > ~/.config/systemd/user/helmcraft-worker.service <<EOF
[Unit]
Description=Helmcraft Worker (WSL)
After=network-online.target

[Service]
Type=simple
WorkingDirectory=%h/helmcraft
Environment=PATH=%h/.local/bin:/usr/local/bin:/usr/bin:/bin
Environment=NODE_ENV=production
ExecStart=/usr/local/bin/node %h/helmcraft/packages/worker/bin/agent-worker.mjs run --config %h/.config/helmcraft/worker.yaml
Restart=always
RestartSec=5
KillMode=mixed
TimeoutStopSec=30

[Install]
WantedBy=default.target
EOF
systemctl --user daemon-reload
systemctl --user enable --now helmcraft-worker.service
loginctl enable-linger "$USER" 2>&1 || echo "linger: needs privilege"
loginctl show-user "$USER" -p Linger
sleep 5
systemctl --user is-active helmcraft-worker.service
journalctl --user -u helmcraft-worker -n 15 --no-pager -o cat | cut -c1-250
