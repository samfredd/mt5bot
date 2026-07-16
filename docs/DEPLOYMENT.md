# Production deployment

## Configuration boundary

Do not create or edit a project `.env` file. The authenticated **Settings**
screen is the control plane for MT5 bridge connectivity, live-trading
certification, AI providers, news, Telegram, Twilio, and web search. Secret
values entered there are encrypted before storage and are never returned by the
API.

Three deployment bootstrap values remain outside Settings because the backend
needs them before it can connect to and decrypt the Settings database:

- PostgreSQL connection and password
- JWT signing secret
- AES-256-GCM credential-encryption key

Supply these through your platform secret manager (Docker/Kubernetes secrets,
Azure Key Vault, AWS Secrets Manager, etc.), not an `.env` file. They are not
user-operational settings and must never be exposed by the dashboard.

## MT5 bridge topology

The API/backend and the MT5 terminal must be deployed on separate trust zones:

```
Linux services (Postgres, Redis, backend, frontend)
        │ private network + firewall + TLS
        ▼
Windows Server 2022 node
        └─ Windows MT5 bridge container ─ MetaTrader 5 terminal ─ broker
```

The Windows bridge is in [`mt5-bridge/Dockerfile.windows`](../mt5-bridge/Dockerfile.windows)
and its standalone Windows-host Compose file is
[`docker-compose.windows-mt5.yml`](../docker-compose.windows-mt5.yml).

Build it only on a patched Windows Server 2022 Docker host configured for
Windows containers:

```powershell
docker compose -f docker-compose.windows-mt5.yml build
docker compose -f docker-compose.windows-mt5.yml up -d
```

Before starting, create `C:\mt5-secrets\bridge_api_key` with a long random
value and restrict its ACL to the Docker service administrators. Enter that
same value in **Settings → Operational configuration → MT5 bridge API key**.
Configure the backend's MT5 bridge URL to the Windows node's private DNS name
or private IP. Never expose port 5001 directly to the public Internet; place
it behind a private network policy and TLS/mTLS-capable reverse proxy where
available.

The terminal profile/history is persisted in the `mt5_terminal_data` volume.
It has no broker credentials baked into its image. Accounts are connected from
the dashboard and their credentials are encrypted in PostgreSQL.

## Release checklist

1. Use a demo account and leave all live switches disabled.
2. Verify `/health` from the backend and the bridge health check from the
   Windows node.
3. In Settings, configure the bridge key/URL and confirm the account can be
   connected and identified as demo.
4. Run broker-symbol, filling-mode, `order_check`, and small-size demo-order
   acceptance tests.
5. Configure a backup/restore test for PostgreSQL and the MT5 data volume.
6. Add alerts for bridge health, Redis, order failures, reconciliation
   mismatches, and emergency-stop events.
7. Only after independent strategy validation and paper-forward evidence may
   an administrator consider opening the existing live-trading gates.

## Windows-container operating requirements

Use Windows Server for production, keep the host and container base image
compatible, and use Hyper-V isolation if host/image compatibility requires it.
The Windows bridge is a deployment artifact, not a guarantee that a particular
broker terminal build will behave identically in every environment. Complete a
broker-specific acceptance test after every MT5 terminal or Windows update.
