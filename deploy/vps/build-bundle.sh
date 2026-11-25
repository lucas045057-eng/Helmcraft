#!/usr/bin/env bash
# 在 Linux/WSL 构建 Hub 生产包（与 VPS 同为 Ubuntu 24.04 + Node 24，原生 better-sqlite3 可直接复用）。
# 用法：deploy/vps/build-bundle.sh [输出路径]；再把 tgz、hub.yaml、hub.env、helmcraft-hub.service 传到 VPS /root 后执行 install-hub.sh
set -euo pipefail
export PATH=$HOME/.local/bin:$PATH COREPACK_ENABLE_DOWNLOAD_PROMPT=0 CI=true
cd ~/helmcraft
git pull -q --ff-only origin main
git log -1 --oneline
pnpm install --frozen-lockfile >/dev/null
pnpm --filter '@agent-hub/hub...' --filter '@agent-hub/dashboard...' -r build >/dev/null
S=$(mktemp -d)/helmcraft
mkdir -p "$S"
cp package.json pnpm-lock.yaml pnpm-workspace.yaml "$S"/
for p in common protocol hub dashboard worker mock-cli; do mkdir -p "$S/packages/$p"; cp packages/$p/package.json "$S/packages/$p/"; done
( cd "$S" && pnpm --filter '@agent-hub/hub...' install --prod --frozen-lockfile >/dev/null )
for p in protocol common hub; do cp -r packages/$p/dist "$S/packages/$p/"; done
cp -r packages/hub/migrations packages/hub/maintenance "$S/packages/hub/"
mkdir -p "$S/packages/dashboard/dist" && cp -r packages/dashboard/dist/site "$S/packages/dashboard/dist/"
rm -rf "$S/packages/worker" "$S/packages/mock-cli"
( cd "$S" && node -e 'const D=require("./packages/hub/node_modules/better-sqlite3"); new D(":memory:"); console.log("bundle sqlite ok")' )
OUT=${1:-$HOME/helmcraft-hub.tgz}
tar -C "$(dirname "$S")" -czf "$OUT" helmcraft
ls -la "$OUT" | awk '{print $5, $9}'
