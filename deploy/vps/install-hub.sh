set -euo pipefail
cd /root
id helmcraft >/dev/null 2>&1 || useradd --system --home /var/lib/helmcraft --shell /usr/sbin/nologin helmcraft
install -d -m 0750 -o helmcraft -g helmcraft /var/lib/helmcraft /var/lib/helmcraft/backup
install -d -m 0750 -o root -g helmcraft /etc/helmcraft
rm -rf /opt/helmcraft.new && mkdir -p /opt/helmcraft.new && tar -xzf helmcraft-hub.tgz -C /opt/helmcraft.new --strip-components=1
chown -R root:root /opt/helmcraft.new
[ -d /opt/helmcraft ] && mv /opt/helmcraft /opt/helmcraft.prev
mv /opt/helmcraft.new /opt/helmcraft
install -m 0640 -o root -g helmcraft hub.yaml /etc/helmcraft/hub.yaml
install -m 0640 -o root -g helmcraft hub.env /etc/helmcraft/hub.env
install -m 0644 helmcraft-hub.service /etc/systemd/system/helmcraft-hub.service
rm -f hub.env hub.yaml helmcraft-hub.service helmcraft-hub.tgz
systemctl daemon-reload
systemctl enable --now helmcraft-hub.service
sleep 6
systemctl is-active helmcraft-hub.service
curl -fsS http://127.0.0.1:18090/healthz; echo
curl -sS http://127.0.0.1:18090/readyz; echo
journalctl -u helmcraft-hub -n 25 --no-pager -o cat | cut -c1-300
echo "== nginx http vhost"
mkdir -p /var/www/certbot
install -m 0644 helm.sorengao.fun.conf /etc/nginx/conf.d/helm.sorengao.fun.conf && rm -f helm.sorengao.fun.conf
nginx -t && systemctl reload nginx
