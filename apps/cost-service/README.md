# Terrablox Cost Service

A private HTTP sidecar around the pinned Infracost CLI. The dashboard sends one
bounded set of Terraform source files to `POST /scan`; the service runs Infracost,
returns its JSON, and removes the temporary files.

The service has no database and no public API. Local Compose binds it to
`127.0.0.1`; production Compose exposes it only on the internal Docker network.
Requests require `Authorization: Bearer $COST_SERVICE_TOKEN`.
