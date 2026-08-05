# ArgonautWorks Base Token Momentum Pulse

An accountless x402 v2 API that derives a transparent Base-mainnet USDC-pool activity snapshot from direct JSON-RPC calls. It has no market-data aggregator, API key, account, or paid data dependency.

`GET` or JSON `POST /api/v1/momentum` costs exactly **$0.004 USDC on Base**. `GET` or JSON `POST /api/v1/resolve` costs exactly **$0.002 USDC on Base**. Both settle directly to `0x5e2023b1D1366d6366E768fe432AD627bfAa5d57` through the PayAI x402 v2 facilitator.

Free representative outputs and copy-ready purchase commands: <https://argonaut-base-token-momentum-pulse.vercel.app/sample>

```sh
npx -y agentcash fetch 'https://argonaut-base-token-momentum-pulse.vercel.app/api/v1/momentum?limit=5' --payment-network base --max-amount 0.004 --yes --format json

npx -y agentcash fetch 'https://argonaut-base-token-momentum-pulse.vercel.app/api/v1/resolve?query=cbBTC&limit=5' --payment-network base --max-amount 0.002 --yes --format json
```

## Input

`limit` is an integer from `1` to `10`, defaulting to `5`.

```sh
curl -i 'http://localhost:3000/api/v1/momentum?limit=5'
```

Input validation and the complete direct-RPC scan happen before an x402 challenge. Invalid input, RPC failure, failed Multicall validation, or no validated inventory returns an uncharged error.

## Bounded token resolver

`/api/v1/resolve` requires one `query` string of 1–80 characters and accepts an optional `limit` integer from `1` to `5` (default `5`). It is deliberately not a complete or general token resolver: it searches only the full in-process validated ranking inventory from the same sealed 300-block window. Lowercased matching is deterministic: exact address, exact symbol/name, prefix, then substring; ties use exact USDC-side volume, unique transaction count, then address. Empty matches are valid paid responses.

```sh
curl -i 'http://localhost:3000/api/v1/resolve?query=token&limit=5'
```

## Methodology

Each refresh scans a fixed **300-block** Base window ending **two sealed blocks** behind the latest block. It requests `eth_getLogs` for these exact `Swap` topics:

- Uniswap V3: `0xc42079f94a6350d7e6235f29174924f928cc2ac818eb64fed8004e115fbcca67`
- Aerodrome Slipstream: `0x19b47279256b2a23a1665c810c8d55a1758940ee09377d4f8d26497a3577dc83`
- V2-style/Aerodrome classic: `0xd78ad95fa46c994b6551d0da85fc275fe613ce37657fb8d5e3d130840159d822`

Every observed pool is validated in bounded Multicall3 chunks through direct Base RPC. The pool must expose `factory()`, `token0()`, and `token1()`, include native Base USDC (`0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913`), and match this explicit first-party deployment allowlist:

- Uniswap V3: `0x33128a8fC17869897dcE68Ed026d694621f6FDfD`; its `getPool(token0, token1, fee)` must return the observed pool.
- Aerodrome classic: `0x420DD381b31aEf6683db6B902084cB0FFECe40Da`; `isPool(pool)` must return true.
- Aerodrome Slipstream: `0x5e7BB104d84c7CB9B682AaC2F3d509f5F406809A`, `0xaDe65c38CD4849aDBA595a4323a8C7DdfE89716a`, or `0xf8f2eB4940CFE7d13603DDDD87f123820Fc061Ef`; `isPool(pool)` must return true.

Topic/factory-family mismatches are rejected. USDC-side volume is decoded exactly as 6-decimal integer atoms: signed `amount0`/`amount1` for V3 and Slipstream, and `max(in, out)` for the USDC side of V2-style swaps. The service uses `BigInt` for all atomic sums, then ranks non-USDC tokens by descending USDC volume, unique transaction count, and address. Token name, symbol, and decimals are queried onchain in batched Multicall3 calls. Evidence links are direct Base Blockscout token and pool pages.

The official primary RPC is `https://mainnet.base.org`; `https://base.drpc.org` is the accountless compatible fallback. The selected endpoint and source state are returned. Refreshes are fresh for about 60 seconds and can explicitly serve a last valid snapshot as stale for up to five minutes. Momentum and resolver requests share one singleflight refresh and one bounded inventory (up to 250 validated tokens), so resolver traffic does not duplicate scanning in-process.

## Limitations

- The sampled 300-block window is not a complete market view.
- Only explicitly approved native-Base-USDC pools are included.
- Raw onchain activity can include bots or wash trading.
- This service makes no safety, quality, or return judgment.
- **Not investment advice.**

## Free discovery surfaces

- `/`, `/health`, `/openapi.json`, `/llms.txt`
- `/.well-known/x402`
- `/.well-known/agent-card.json` and legacy `/.well-known/agent.json`
- `POST /a2a` for completed purchase guidance only; it never fetches RPC data, initializes payment, settles payment, or reflects request text.

## Development

Requires Node 20 or newer.

```sh
npm install
npm test
npm run check
npm start
```

MIT licensed.

## PayanAgent relay and realized-revenue monitor

`npm run payanagent:register` is a deliberately manual deployment step and is not run automatically. When invoked after production deployment, it idempotently creates or updates and verifies two relay offers before persisting their non-secret identifiers: the 4,000-atomic-unit `GET https://argonaut-base-token-momentum-pulse.vercel.app/api/v1/momentum` momentum offer and the 2,000-atomic-unit resolver offer at the exact relay external URL `https://argonaut-base-token-momentum-pulse.vercel.app/api/v1/resolve?query=token`. The resolver offer instructs buyers to `POST /x402/{offerId}` JSON such as `{"query":"token","limit":5}` (`query` is 1–80 characters; `limit` is 1–5); its relay forwards that POST body to the resolver, whose body query overrides the fixed registration query. Each offer is checked with a GET relay probe for the exact Base-USDC challenge, receiving wallet, network, amount, active state, price, and external URL. It never prints the API key.

`npm run monitor:revenue` is also opt-in. It records a receipt only when it finds a confirmed external Base-USDC `transferWithAuthorization` payment to the fixed receiving wallet: 4,000 atoms for momentum (E055) or 2,000 atoms for resolver (E056). If a configured PayanAgent relay exists, either amount is labeled `payanagent` only after an exact confirmed, delivered independent-buyer receipt for that product's exact offer, external URL, amount, and transaction hash; resolver relay attribution requires the exact `?query=token` URL, while direct resolver revenue remains the bare `/api/v1/resolve` endpoint. Other transfers, self-payments, wrong amounts, ordinary ERC-20 transfers, receipt mismatches, and duplicates are excluded. The default local ledger is `revenue-ledger.csv`; it does not write to the main venture-lab repository.
