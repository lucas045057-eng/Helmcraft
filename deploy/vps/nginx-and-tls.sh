set -euo pipefail
certbot certonly --webroot -w /var/www/certbot -d helm.sorengao.fun --non-interactive --agree-tos --keep-until-expiring 2>&1 | tail -4
cat > /etc/nginx/conf.d/helm.sorengao.fun.conf <<'EOF'
server {
    listen 80;
    listen [::]:80;
    server_name helm.sorengao.fun;
    location ^~ /.well-known/acme-challenge/ {
        root /var/www/certbot;
        default_type text/plain;
        try_files $uri =404;
    }
    location / { return 301 https://$host$request_uri; }
}
server {
    listen 443 ssl http2;
    listen [::]:443 ssl http2;
    server_name helm.sorengao.fun;
    ssl_certificate     /etc/letsencrypt/live/helm.sorengao.fun/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/helm.sorengao.fun/privkey.pem;
    ssl_protocols TLSv1.2 TLSv1.3;
    client_max_body_size 2m;
    location / {
        proxy_pass http://127.0.0.1:18090;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection $connection_upgrade_helm;
        proxy_read_timeout 3600s;
        proxy_send_timeout 3600s;
        proxy_buffering off;
    }
}
map $http_upgrade $connection_upgrade_helm { default upgrade; '' close; }
EOF
nginx -t && systemctl reload nginx
sleep 1
curl -sS -o /dev/null -w "https healthz %{http_code}\n" https://helm.sorengao.fun/healthz
curl -sS -o /dev/null -w "http redirect %{http_code} -> %{redirect_url}\n" http://helm.sorengao.fun/
systemctl list-timers --no-pager | grep -i certbot | head -2
