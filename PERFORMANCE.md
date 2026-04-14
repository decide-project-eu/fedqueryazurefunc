# FedQuery Performance Findings

## Environment

| Component | Details |
|---|---|
| Azure Function | `decide-federated-functions` — West Europe (Amsterdam, NL) |
| Solid Server | `solidserver.bovi-analytics.com` — West Europe (Amsterdam, NL) |
| Engine | `@comunica/query-sparql-file` v5.2.0 |
| Azure Plan (tested) | Consumption (serverless, shared CPU) |

Both servers resolve to the same Azure West Europe region. Network latency between them is near zero — the bottleneck is **CPU**, not network.

---

## Results: Local vs Azure Consumption Plan

| Experiment | Sources | Expected rows | Local (MacBook) | Azure Consumption | Azure result |
|---|---|---|---|---|---|
| Exp 1 — Q1 simple, 5 cattle pods | 5 | 569 | ~22 s | ~224 s | 569 ✓ (no timeout) |
| Exp 2 — Q2 UNION, 12 vertical pods | 12 | 1378 | ~23 s | >300 s | timeout, partial rows |
| Exp 3 — Q2 UNION, 6 horizontal pods | 6 | 1378 | ~23 s | >300 s | timeout, partial rows |

> Local benchmark uses the same engine and queries, run directly from a developer MacBook (Apple M-series, full CPU).

---

## Root Cause

Although both the Azure Function and solidserver are in the same Azure datacenter (Amsterdam), queries are **~10x slower** on the Consumption plan than locally.

The bottleneck is **CPU**, not network:

- Comunica fetches and parses large TTL files (5–10 MB each) into an in-memory RDF store before querying
- This is CPU-intensive work — RDF parsing, triple indexing, SPARQL join evaluation
- Azure **Consumption plan** allocates shared, burstable CPU that is heavily throttled per instance
- A developer MacBook has dedicated, full-speed CPU — hence the 10x difference
- **Auto-scaling does not help**: it adds more instances for concurrent users, but each instance still gets the same throttled CPU per request

---

## Recommendation: Upgrade to Basic B1 App Service Plan

| Plan | CPU | RAM | Cost | Est. query time |
|---|---|---|---|---|
| Consumption (current) | Shared, throttled | Dynamic | ~$0 (pay per exec) | ~200–300+ s |
| Basic B1 | 1 dedicated core | 1.75 GB | ~$13/month | ~30–50 s (estimated) |
| Basic B2 | 2 dedicated cores | 3.5 GB | ~$26/month | ~20–30 s (estimated) |

**B1** should be sufficient to bring query times close to local performance. **B2** would match local timings more closely for the complex 12-source queries.

### How to Upgrade

**Azure Portal:**
1. Open `decide-federated-functions` in the Azure Portal
2. Left menu → **Settings** → **Scale up (App Service plan)**
3. Select **Basic B1** (or B2)
4. Click **Apply** — no code changes or redeployment needed

**Azure CLI:**
```bash
az appservice plan create \
  --name decide-federated-plan \
  --resource-group <your-resource-group> \
  --sku B1

az functionapp update \
  --name decide-federated-functions \
  --resource-group <your-resource-group> \
  --plan decide-federated-plan
```

---

## Timeout Configuration

| Setting | Value | Notes |
|---|---|---|
| `DEFAULT_TIMEOUT_MS` | 300000 (5 min) | Increased from 180s after Consumption plan testing |
| Azure Function host timeout | 300s (5 min) | Must match or exceed `DEFAULT_TIMEOUT_MS` |

On the Consumption plan, Exp 1 (5 sources) completes within the 5-minute timeout but Exp 2/3 (12 and 6 larger sources) do not. Upgrading to B1/B2 is expected to bring all experiments well within the timeout.
