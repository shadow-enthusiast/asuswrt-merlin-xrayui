# A stand-in for an Asuswrt-Merlin router: busybox ash, crond, syslogd, the real Xray core,
# Merlin's cru/nvram/service/helper.sh, and the stateful firewall fakes from tests/backend/firewall.
FROM alpine:3.20
ARG XRAY_VERSION=26.3.27
RUN apk add --no-cache jq curl unzip socat \
    && (command -v flock >/dev/null || apk add --no-cache util-linux-misc) \
    && curl -fsSL -o /tmp/xray.zip "https://github.com/XTLS/Xray-core/releases/download/v${XRAY_VERSION}/Xray-linux-64.zip" \
    && mkdir -p /opt/sbin && unzip -o /tmp/xray.zip xray geoip.dat geosite.dat -d /opt/sbin && rm /tmp/xray.zip \
    && chmod +x /opt/sbin/xray && /opt/sbin/xray version
ENV PATH=/opt/bin:/opt/sbin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
COPY helper.sh /usr/sbin/helper.sh
COPY bin/ /opt/bin/
COPY setup.sh /setup.sh
RUN chmod +x /opt/bin/* /setup.sh
CMD ["/setup.sh"]
