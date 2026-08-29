FROM docker.io/cloudflare/sandbox:0.13.0-next.751.1

USER root
RUN mkdir -p /workspace && chown -R 1000:1000 /workspace
USER 1000:1000

WORKDIR /workspace
EXPOSE 8080
