#!/usr/bin/env bash
# Worker 专用 codex 出口守卫（Fail-Closed）：与 claude 的 egress-guard 共用 ~/.proxy.env 专属出口。
# 安装：install -m 755 deploy/wsl/codex-egress.sh ~/.local/bin/codex-egress
# 然后在 worker.yaml：adapters.codex.command: /home/<user>/.local/bin/codex-egress
# 不覆盖交互用的 `codex` 命令。
set -euo pipefail
ENVFILE="$HOME/.proxy.env"
REAL="${CODEX_EGRESS_REAL:-/usr/local/bin/codex}"
if [[ ! -r "$ENVFILE" ]]; then
  echo "[codex-egress] 错误：$ENVFILE 不存在或不可读，拒绝以本机直连出口运行 codex" >&2
  exit 1
fi
set -a
if ! source "$ENVFILE" >/dev/null 2>&1; then
  echo "[codex-egress] 错误：$ENVFILE 解析失败，拒绝运行 codex" >&2
  exit 1
fi
set +a
PROXY_VAL="${HTTPS_PROXY:-${https_proxy:-${ALL_PROXY:-${all_proxy:-}}}}"
if [[ -z "$PROXY_VAL" ]]; then
  echo "[codex-egress] 错误：代理变量为空，拒绝以本机直连出口运行 codex" >&2
  exit 1
fi
MERGED_NO_PROXY="127.0.0.1,localhost,::1,10.0.0.0/8,172.16.0.0/12,192.168.0.0/16${NO_PROXY:+,$NO_PROXY}"
export HTTP_PROXY="$PROXY_VAL" HTTPS_PROXY="$PROXY_VAL" ALL_PROXY="$PROXY_VAL"
export http_proxy="$PROXY_VAL" https_proxy="$PROXY_VAL" all_proxy="$PROXY_VAL"
export NO_PROXY="$MERGED_NO_PROXY" no_proxy="$MERGED_NO_PROXY"
unset PX_USER PX_PASS
if [[ "$(realpath "$REAL")" == "$(realpath "$0")" ]]; then
  echo "[codex-egress] 错误：真实 codex 指向自身" >&2
  exit 1
fi
exec "$REAL" "$@"
