FROM registry:3.1.1

RUN apk add --no-cache apache2-utils curl

COPY config.yml /etc/distribution/config.yml
COPY entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

EXPOSE 5000 5001

ENTRYPOINT ["/entrypoint.sh"]
