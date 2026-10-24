#!/bin/sh
# Lays out the router file system, installs the dist/ package the way `xrayui update` does,
# then boots XRAYUI through its real post-mount entry point (service_event startup).
set -e
mkdir -p /jffs/scripts /jffs/addons/xrayui /opt/etc/xray /opt/share /www/user /www/require/modules /var/run /tmp/fw /var/spool/cron/crontabs
touch /www/require/modules/menuTree.js

cp -r /dist/. /jffs/addons/xrayui/
mv /jffs/addons/xrayui/xrayui /jffs/scripts/xrayui
chmod 0777 /jffs/scripts/xrayui

printf 'xray_startup y\nxray_version %s\n' "$(sed -n 's/^XRAYUI_VERSION="\(.*\)"/\1/p' /jffs/scripts/xrayui)" >/jffs/addons/custom_settings.txt
cat >/opt/etc/xray/config.json <<'JSON'
{
  "log": { "loglevel": "warning" },
  "inbounds": [{ "tag": "socks-in", "listen": "127.0.0.1", "port": 10808, "protocol": "socks", "settings": { "udp": true } }],
  "outbounds": [{ "tag": "direct", "protocol": "freedom" }],
  "routing": { "rules": [] }
}
JSON

syslogd -O /tmp/syslog.log -s 0
crond -b -l 8 -L /tmp/crond.log -c /var/spool/cron/crontabs

sh /jffs/scripts/xrayui service_event startup >/tmp/startup.log 2>&1 || true
echo ready >/tmp/router.ready
exec tail -f /dev/null
