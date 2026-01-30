FROM registry:2

RUN apk add --no-cache apache2-utils

COPY config.yml /etc/docker/registry/config.yml
COPY entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

EXPOSE 5000

ENTRYPOINT ["/entrypoint.sh"]
