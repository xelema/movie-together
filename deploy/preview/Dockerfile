FROM caddy:2.11-builder AS builder
RUN xcaddy build --with github.com/caddy-dns/duckdns

# Caddy standard + le module DNS DuckDNS, indispensable pour obtenir le certificat
# wildcard des previews par challenge DNS-01 (les ports 80/443 de l'hote sont pris
# par le Caddy de production).
FROM caddy:2.11-alpine
COPY --from=builder /usr/bin/caddy /usr/bin/caddy
