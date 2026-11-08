ARG NPM_BASE=jc21/nginx-proxy-manager:latest
FROM ${NPM_BASE}

USER root
COPY check-base.sh /tmp/check-hosts-resolver-base.sh
RUN bash /tmp/check-hosts-resolver-base.sh \
	&& rm /tmp/check-hosts-resolver-base.sh \
	&& apt-get update \
	&& apt-get install -y --no-install-recommends dnsmasq-base \
	&& apt-get clean \
	&& rm -rf /var/lib/apt/lists/*

COPY rootfs/ /
RUN chmod 755 /etc/s6-overlay/s6-rc.d/hosts-resolver/run \
	/etc/s6-overlay/s6-rc.d/hosts-resolver/data/check \
	/etc/s6-overlay/s6-rc.d/hosts-monitor/run \
	&& bash -n /usr/bin/hosts-monitor.sh /usr/bin/run-hosts-dns.sh \
	&& node --check /etc/s6-overlay/s6-rc.d/hosts-resolver/data/check \
	&& /usr/sbin/dnsmasq --test --conf-file=/dev/null

ENV ENABLE_HOSTS_RESOLVER=true
LABEL org.opencontainers.image.title="Nginx Proxy Manager hosts resolver extension"
