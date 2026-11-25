#!/usr/bin/env bash
# Worker 专用 agy (Antigravity CLI) 出口守卫（Fail-Closed）：与 claude/codex 共用 ~/.proxy.env 专属出口。
# 安装：install -m 755 deploy/wsl/agy-egress.sh ~/.local/bin/agy-egress
# 然后在 worker.yaml：adapters.antigravity.command: /home/<user>/.local/bin/agy-egress
set -euo pipefail
ENVFILE="$HOME/.proxy.env"
REAL="${AGY_EGRESS_REAL:-$HOME/.local/bin/agy}"
if [[ ! -r "$ENVFILE" ]]; then
  echo "[agy-egress] 错误：$ENVFILE 不存在或不可读，拒绝以本机直连出口运行 agy" >&2
  exit 1
fi
set -a
if ! source "$ENVFILE" >/dev/null 2>&1; then
  echo "[agy-egress] 错误：$ENVFILE 解析失败，拒绝运行 agy" >&2
  exit 1
fi
set +a
PROXY_VAL="${HTTPS_PROXY:-${https_proxy:-${ALL_PROXY:-${all_proxy:-}}}}"
if [[ -z "$PROXY_VAL" ]]; then
  echo "[agy-egress] 错误：代理变量为空，拒绝以本机直连出口运行 agy" >&2
  exit 1
fi
MERGED_NO_PROXY="127.0.0.1,localhost,::1,10.0.0.0/8,172.16.0.0/12,192.168.0.0/16${NO_PROXY:+,$NO_PROXY}"
export HTTP_PROXY="$PROXY_VAL" HTTPS_PROXY="$PROXY_VAL" ALL_PROXY="$PROXY_VAL"
export http_proxy="$PROXY_VAL" https_proxy="$PROXY_VAL" all_proxy="$PROXY_VAL"
export NO_PROXY="$MERGED_NO_PROXY" no_proxy="$MERGED_NO_PROXY"
unset PX_USER PX_PASS
if [[ "$(realpath "$REAL")" == "$(realpath "$0")" ]]; then
  echo "[agy-egress] 错误：真实 agy 指向自身" >&2
  exit 1
fi
exec "$REAL" "$@"
