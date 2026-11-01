<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset=".github/aricxpoint-logo-white.png">
    <img alt="aricxpoint technologies" src=".github/aricxpoint-logo-black.png" width="320">
  </picture>
</p>

# paylab-api-gateway

Part of **PayLab** (aricxpoint DevOps class: "Payment Web App Deployment").

The **public API** entry point. On AWS the ALB `paylab-alb` sends `https://api.lab.aricxpoint.co/*` and every
`https://pay.lab.aricxpoint.co/api/*` request here (target group `paylab-tg`); everything else goes to the **paylab-web** frontend.
On AWS the task definition sets `WALLET_URL=http://wallet-svc.paylab.internal:8082`, `PAYMENT_URL=http://payment-svc.paylab.internal:8081`
(ECS Service Discovery) and `CORS_ORIGIN=https://pay.lab.aricxpoint.co`.

- `/api/wallets*` is forwarded to wallet-svc (prefix `/api` removed), e.g. `GET /api/wallets/by-handle/bola` -> `GET http://wallet-svc:8082/wallets/by-handle/bola`.
- `/api/payments*` is forwarded to payment-svc.
- Nothing else is forwarded. wallet-svc's `/transfers` stays **internal**, so money only moves through payment-svc.
  The gateway checks the final upstream path, so tricks like `/api/wallets/../transfers` get a 404.
- `GET /health` is used by the `paylab-tg` health check.
- **CORS**: every response gets `Access-Control-Allow-Origin: $CORS_ORIGIN` and `OPTIONS` preflight requests get a 204,
  so the web page can call the API from another origin when testing locally (web on :3000, gateway on :8080).
  On AWS the page calls the API on its own origin, so CORS only matters for direct calls to `api.lab.aricxpoint.co` from the page's origin.

## Environment variables

| Variable | Default |
|---|---|
| `PORT` | `8080` |
| `WALLET_URL` | `http://wallet-svc:8082` |
| `PAYMENT_URL` | `http://payment-svc:8081` |
| `CORS_ORIGIN` | `*` (e.g. set `http://localhost:3000` to allow only the local web page) |

## Run it alone with Docker

On its own, `/health` works but `/api/*` calls return 502 (`upstream unreachable`). To run the whole stack locally,
build all five images from their repos, then:

```bash
docker network create paylab
docker run -d --name pg --network paylab \
  -e POSTGRES_DB=paylab -e POSTGRES_USER=paylab -e POSTGRES_PASSWORD=paylab-local-pass \
  -p 5432:5432 postgres:16-alpine
docker run -d --name wallet-svc  --network paylab -e DB_HOST=pg -e DB_PASSWORD=paylab-local-pass paylab/wallet-svc
docker run -d --name payment-svc --network paylab -e DB_HOST=pg -e DB_PASSWORD=paylab-local-pass paylab/payment-svc
docker run -d --name notify-svc  --network paylab paylab/notify-svc

docker build -t paylab/api-gateway .
docker run -d --name api-gateway --network paylab -p 8080:8080 paylab/api-gateway

# the frontend (from the paylab-web repo), pointed at the gateway
docker run -d --name web -p 3000:3000 -e API_BASE=http://localhost:8080 paylab/web
```

Open http://localhost:3000, or test the API directly:

```bash
curl -s -X POST localhost:8080/api/wallets  -H 'Content-Type: application/json' -d '{"owner":"Ada","handle":"ada"}'    # ₦10,000 demo credit
curl -s -X POST localhost:8080/api/wallets  -H 'Content-Type: application/json' -d '{"owner":"Bola","handle":"bola"}'
curl -s -X POST localhost:8080/api/payments -H 'Content-Type: application/json' \
  -d '{"fromWalletId":1,"toHandle":"bola","amountKobo":150000,"reference":"ref-1","note":"Lunch"}'     # 201 success
curl -s -X POST localhost:8080/api/payments -H 'Content-Type: application/json' \
  -d '{"fromWalletId":1,"toHandle":"bola","amountKobo":99999900,"reference":"ref-2"}'                  # 402 insufficient funds
curl -s localhost:8080/api/wallets/1                  # Ada: 850000 kobo
curl -s 'localhost:8080/api/payments?walletId=2'      # Bola's history
docker logs notify-svc                                # sent + received receipts
```

Clean up: `docker rm -f web api-gateway payment-svc wallet-svc notify-svc pg && docker network rm paylab`

## Deployment (AWS)

This repo is deployed by its own **CodePipeline** `paylab-api-gateway-pipeline` on every push to `main`:

```
git push (main) -> CodePipeline Source -> CodeBuild (buildspec.yml) -> ECR paylab/api-gateway:<commit> -> ECS service "api-gateway" in cluster "paylab"
```

| File | Purpose |
|---|---|
| `buildspec.yml` | CodeBuild steps: log in to ECR, build, push `:<short-commit>` and `:latest`, write `imagedefinitions.json`. |
| `taskdef.json` | ECS task definition template (with `<ACCOUNT_ID>`-style placeholders). Registered by `paylab-infra/terraform` (`ecs.tf`); the pipeline then registers a new revision on every deploy. |

The container name in `taskdef.json` and in `imagedefinitions.json` is `api-gateway`. They **must match**, or the deploy stage fails.

The shared AWS setup (network, database, cluster, load balancer, pipelines) lives in the **paylab-infra** repo.
