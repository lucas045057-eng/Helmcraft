#!/usr/bin/env bash
# 升级 VPS 上的 Hub 程序：只替换 /opt/helmcraft，保留 /etc/helmcraft 配置与 /var/lib/helmcraft 数据。
# 用法：先把 build-bundle.sh 产出的 helmcraft-hub.tgz 传到 /root，再以 root 执行本脚本。失败时自动回滚到上一版。
set -euo pipefail
cd /root
rm -rf /opt/helmcraft.new && mkdir -p /opt/helmcraft.new
tar -xzf helmcraft-hub.tgz -C /opt/helmcraft.new --strip-components=1
chown -R root:root /opt/helmcraft.new
rm -rf /opt/helmcraft.prev
mv /opt/helmcraft /opt/helmcraft.prev
mv /opt/helmcraft.new /opt/helmcraft
systemctl restart helmcraft-hub
for _ in $(seq 1 20); do curl -fsS http://127.0.0.1:18090/readyz >/dev/null 2>&1 && break; sleep 1; done
if curl -fsS http://127.0.0.1:18090/readyz >/dev/null 2>&1; then
  echo "upgrade ok"; rm -f helmcraft-hub.tgz
else
  echo "upgrade FAILED, rolling back"; journalctl -u helmcraft-hub -n 20 --no-pager -o cat
  rm -rf /opt/helmcraft && mv /opt/helmcraft.prev /opt/helmcraft && systemctl restart helmcraft-hub; exit 1
fi
