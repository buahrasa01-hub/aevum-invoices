# Aevum Invoices

Create and pay stablecoin invoices on **QDay Aevum testnet** (chain `44005`) — an entry for the **Aevum Builder Challenge #1** ($1,500 USDT; submission deadline 11 Dec 2026, 15:00 WIB).

- **Contracts (Foundry):** `Invoice.sol` — a merchant creates an invoice with a fixed amount, due date and payer; the buyer pays the exact amount in tUSD8, standard or gasless (EIP-3009 + relayer). Invoices expire, the merchant can cancel unpaid ones, and stray tokens are recoverable. 25 unit tests + 3 fork tests against the real tUSD8.
- **Web app (Next.js):** a setup checker, create-invoice and pay pages (standard + gasless), on-chain receipts and an activity feed. Connect with MetaMask, Rabby, any browser wallet, or WalletConnect.
- **TypeScript examples:** sign and relay a gasless invoice payment, read events past the 1,000-block log limit, and check a wallet's setup.
- **`@aevum-kit/aevum`:** chain config, ABIs and helpers shared by all of the above.

Based on the [Aevum Starter Kit](https://github.com/qday-io/aevum-starter-kit) (MIT, PQA Labs) — `Checkout.sol` is kept in `contracts/src/` as the kit's original; the app runs on its fork, `Invoice.sol`.

## Live deployment

**Live web app: https://aevum-invoices-buahrasa01.vercel.app/** (Vercel, account `buahrasa01`, public — no login wall; project `aevum-invoices`, deploy `dpl_75WBi5ypCEjKmogaUBSdMHU8XeQg`).

**Invoice on Aevum testnet (chain `44005`): [`0xeA7892a5B3fa083B2F86E39Eb8086Aa6Bd04a995`](https://explorer-test.qday.info/address/0xeA7892a5B3fa083B2F86E39Eb8086Aa6Bd04a995)** — token tUSD8 [`0x456569838f1d43009A91ebA4263147Afd7233483`](https://explorer-test.qday.info/address/0x456569838f1d43009A91ebA4263147Afd7233483), merchant `0xFFFfA2423dAbfE6128D8F01c5BEbc3571F344610`. Deployed 18 Nov 2026, **block `3493736`**, deploy tx [`0x1976e601d7d120c4984497f1857d8f1b0ffb9a15a64a160623055e79fda80f5d`](https://explorer-test.qday.info/tx/0x1976e601d7d120c4984497f1857d8f1b0ffb9a15a64a160623055e79fda80f5d) (status success, 1,090,386 gas). Deployed with `make deploy-invoice-aevum` (Foundry keystore, legacy tx).

**End-to-end proof on the real testnet (18 Nov 2026):**

| Step | Result |
|---|---|
| Standard pay, invoice `0xea824866…` | pay tx [`0x05ba593b…`](https://explorer-test.qday.info/tx/0x05ba593b8c0755be7dad247993fb6787c7bc32fcb88c79a2cffee03659006663), `isPaid=true` |
| Gasless pay via local relay, invoice `0x8c17c277…` | relay HTTP 200, tx [`0x4ecbcedb…`](https://explorer-test.qday.info/tx/0x4ecbcedb0592d1bd0a5bee8385de65d78aebc53e5a39573efd1d18af422c7246), `isPaid=true` |
| Gasless pay via the **live Vercel relay**, invoice `0x02ac8f26…` | relay HTTP 200, tx [`0xbe349196…`](https://explorer-test.qday.info/tx/0xbe349196c8e4d3634c042a0e8a988eb2a6f671e3658b60d9ce35f636f7ed4a88), `isPaid=true` |
| Wrong amount to the relay | HTTP 400 `The amount doesn't match this invoice.` |
| Merchant tUSD8 balance | 2 → 4 → 5 (all 3 test payments received) |

> **Judging counts activity on Aevum.** Contracts, payments and transfers must happen on Aevum testnet. Settling only on another chain (for example x402 on Base) doesn't count.

**Vercel deploy note:** the live site is deployed from this repo via the Vercel REST API (file upload, no git link — the Vercel CLI rejects Vault surrogate tokens). Two deployment-only transforms are applied to the uploaded tree, never to the repo: (1) `@aevum-kit/aevum` is vendored as `file:./vendor/aevum`, because file-upload deployments only extract the `web/` subtree for the build, so the pnpm workspace at the repo root is not visible to the installer; (2) `@x402/core`, `@x402/evm`, `@x402/svm`, `@x402/extensions` (`^2.29.0`) are pinned, because Vercel's `npm install` resolves `@base-org/account` 2.4.0 (the local pnpm lockfile pins 2.2.0) whose `@coinbase/cdp-sdk` dynamically imports `@x402/*`, which are optional peers npm skips — without them the Turbopack build fails on `Can't resolve '@x402/core/client'`.

---

## Contents

- [Quickstart (5 minutes, no funds needed)](#quickstart-5-minutes-no-funds-needed)
- [Network details](#network-details)
- [Get test tokens](#get-test-tokens)
- [Deploy to Aevum testnet](#deploy-to-aevum-testnet)
- [Deploy the web app to Vercel](#deploy-the-web-app-to-vercel)
- [How invoices work](#how-invoices-work)
- [Things that differ from Ethereum](#things-that-differ-from-ethereum)
- [Project layout](#project-layout)
- [Commands](#commands)
- [Submitting your project](#submitting-your-project)
- [FAQ](#faq)

---

## Quickstart (5 minutes, no funds needed)

You need [Node 22+](https://nodejs.org), [pnpm](https://pnpm.io/installation) and [Foundry](https://book.getfoundry.sh/getting-started/installation) (`foundryup`).

```bash
git clone --recursive https://github.com/buahrasa01-hub/aevum-invoices.git
cd aevum-invoices
make install          # Solidity libs + JS packages
make check            # build, Shanghai opcode check, unit tests, fork tests
```

Run the whole app against a **local copy of Aevum**, with the real tUSD8 and free test balances:

```bash
# terminal 1: local copy of Aevum testnet on 127.0.0.1:8555 (chain 440050)
make fork

# terminal 2: deploy Invoice and give yourself test money
make deploy-invoice-fork              # prints the Invoice address
make deal TO=<your wallet address>    # 100 tUSD8 + 10 tQDAY, on the fork only

cp web/.env.example web/.env.local
#   NEXT_PUBLIC_NETWORKS=fork,aevum
#   NEXT_PUBLIC_INVOICE_FORK=<address from deploy-invoice-fork>
#   RELAYER_PRIVATE_KEY=<a test key, see below>   (optional: enables gasless mode)
make dev                              # http://localhost:3000
```

Use the **Local fork / Aevum testnet** switcher in the app's header. The first time you pick the fork, your wallet offers to add "Aevum fork (local)" as a new network; after that, switching is one click and your real testnet network stays untouched.

**Why the fork has its own chain ID (440050):** it copies Aevum's state (accounts, balances, tUSD8) but anything you sign there, such as an EIP-3009 authorization or a permit, can't be replayed on the real testnet, and wallets never mix the two up. `make deploy-invoice-fork` also deploys from a random address nobody has the key to, so its contract addresses can't be claimed on the real testnet.

For a local relayer, any of anvil's [default test accounts](https://book.getfoundry.sh/anvil/#getting-started) works. Those keys are public, so the relayer refuses them on any chain but `make fork` and `make anvil`. When you add `aevum`, put a fresh test wallet's key in `RELAYER_PRIVATE_KEY` instead.

Want an empty chain instead of a fork? `make anvil` + `make deploy-invoice-local` deploys a `MockUSD8` (same decimals, EIP-712 domain and EIP-3009 functions as tUSD8) that anyone can mint with `make mint`.

---

## Network details

| | |
|---|---|
| Network | QDay Aevum Testnet |
| Chain ID | `44005` |
| RPC | `https://rpc-test.qday.info` (HTTPS only, no WebSocket) |
| Explorer | https://explorer-test.qday.info |
| Gas token | tQDAY (18 decimals) |
| Gas price | about 1 gwei. 1 tQDAY covers hundreds of contract calls. |
| EVM version | **Shanghai** |
| tUSD8 | [`0x456569838f1d43009A91ebA4263147Afd7233483`](https://explorer-test.qday.info/address/0x456569838f1d43009A91ebA4263147Afd7233483), 6 decimals, USDC-style (EIP-2612 `permit`, EIP-3009 signed transfers), EIP-712 domain `name: "tUSD8"`, `version: "2"` |
| Multicall3 | `0xcA11bde05977b3631167028862bE2a173976CA11` |

All of this is in [`packages/aevum/src/chain.ts`](packages/aevum/src/chain.ts) and [`contracts.ts`](packages/aevum/src/contracts.ts).

---

## Get test tokens

- **Discord faucet (for Builder Challenge participants):** join the [QDay Discord](https://discord.gg/bYPhjmrSfK), react ✅ in `#verify`, then run `/faucet <your address>`. You get **1 tQDAY + 5 tUSD8**, once per Discord account and once per address. No Ethereum mainnet balance needed.
- **Web faucet:** https://faucet.qday.info. Check the page for its rules.
- **Local fork:** `make deal TO=<address>` for unlimited test balances. Nothing leaves your machine.

1 tQDAY is plenty for development: deploying `Invoice` costs well under 0.01 tQDAY.

---

## Deploy to Aevum testnet

Keep your deployer key out of files and shell history. Foundry's encrypted keystore asks for the key once and a password each time:

```bash
cast wallet import aevum-deployer --interactive   # paste the key of a TEST wallet
cast wallet address --account aevum-deployer      # fund this address from the faucet

make deploy-invoice-aevum ACCOUNT=aevum-deployer  # uses real tUSD8; MERCHANT defaults to the deployer
# MERCHANT=0x... make deploy-invoice-aevum ACCOUNT=aevum-deployer   to send payments elsewhere
```

Then set `NEXT_PUBLIC_INVOICE_AEVUM` in `web/.env.local` (and `NEXT_PUBLIC_DEPLOY_BLOCK_AEVUM` to the deploy block, so the Activity page starts scanning there) and add `aevum` to `NEXT_PUBLIC_NETWORKS`.

**Putting the web app online:** see [Deploy the web app to Vercel](#deploy-the-web-app-to-vercel). The same settings apply to any other host.

> Use a wallet made only for testing. Never paste a private key into chat, an issue, or a committed file.

**Contract verification:** the explorer's verifier isn't working yet, so `forge verify-contract` will fail for now. Put your contract addresses and a link to the source (the exact commit) in your README and submission instead. The command, for when it's back:

```bash
forge verify-contract <address> src/Invoice.sol:Invoice --chain-id 44005 \
  --verifier blockscout --verifier-url https://explorer-test.qday.info/api/
```

---

## Deploy the web app to Vercel

Deploy your contract first ([above](#deploy-to-aevum-testnet)), then:

[![Deploy with Vercel](https://vercel.com/button)](https://vercel.com/new/clone?repository-url=https%3A%2F%2Fgithub.com%2Fbuahrasa01-hub%2Faevum-invoices&root-directory=web&project-name=aevum-invoices&repository-name=aevum-invoices&env=NEXT_PUBLIC_NETWORKS%2CNEXT_PUBLIC_INVOICE_AEVUM%2CTRUSTED_IP_HEADER&envDefaults=%7B%22NEXT_PUBLIC_NETWORKS%22%3A%22aevum%22%2C%22TRUSTED_IP_HEADER%22%3A%22x-vercel-forwarded-for%22%7D&envDescription=Your%20Invoice%20address%20from%20%60make%20deploy-invoice-aevum%60.%20Add%20RELAYER_PRIVATE_KEY%20later%20in%20Project%20Settings%20to%20turn%20on%20gasless%20invoice%20payment.&envLink=https%3A%2F%2Fgithub.com%2Fbuahrasa01-hub%2Faevum-invoices%23deploy-the-web-app-to-vercel)

The button copies this repo into your GitHub account and creates a Vercel project with **Root Directory** `web`. It asks for:

| Variable | Value |
|---|---|
| `NEXT_PUBLIC_NETWORKS` | `aevum` (prefilled). Keep it to `aevum` online: with `fork` or `local`, visitors get a "Local fork" option that points at *their own* 127.0.0.1. |
| `NEXT_PUBLIC_INVOICE_AEVUM` | Your Invoice address from `make deploy-invoice-aevum`. |
| `TRUSTED_IP_HEADER` | `x-vercel-forwarded-for` (prefilled). The relayer rate-limits on this header, which Vercel sets and visitors can't fake. |

Optional, in **Project Settings → Environment Variables** (then redeploy):

| Variable | Value |
|---|---|
| `RELAYER_PRIVATE_KEY` | Turns on gasless invoice payment. A **fresh** wallet with a little tQDAY, never one that holds anything else, and never an anvil key (the relayer refuses those on Aevum). Mark it Sensitive. |
| `NEXT_PUBLIC_DEPLOY_BLOCK_AEVUM` | Your deploy block. The Activity page starts scanning there. |
| `NEXT_PUBLIC_WC_PROJECT_ID` | Enables WalletConnect (mobile wallets). Free at [cloud.reown.com](https://cloud.reown.com). |
| `NEXT_PUBLIC_REPO_URL` | Your repo, for the Docs page's Source link. |

Doing it by hand instead: **Add New → Project**, import your repo, set **Root Directory** to `web`, add the variables above, and deploy. Keep the whole repo connected (not just `web/`): the app imports `packages/aevum` through the pnpm workspace, and Vercel reads `pnpm-lock.yaml` at the repo root.

> **The relayer's limits live in memory.** On Vercel each function instance has its own copy, so they slow down an attacker but don't stop one. Keep only a little tQDAY in the relayer, and move the limits to a shared store (for example Upstash Redis) if your app gets real traffic.

---

## How invoices work

`Invoice` takes one token and one merchant address. The merchant creates an invoice with `createInvoice(invoiceId, payer, amount, dueAt, memo)`: a fixed amount in tUSD8, an optional due date, and an optional payer (empty means anyone may pay). The buyer then pays the exact amount — `pay(invoiceId)` after approving it, or gasless with `payWithAuthorization(invoiceId, …)`. The money goes straight to the merchant, and the `InvoicePaid(invoiceId, payer, amount)` event is the receipt.

**Standard** (two transactions, buyer pays gas):

```
buyer ── approve(Invoice, amount) ──▶ tUSD8
buyer ── pay(invoiceId) ────────────▶ Invoice ── transferFrom ──▶ merchant
```

**Gasless** (one signature, the buyer needs no tQDAY):

```
buyer  ── signs ReceiveWithAuthorization(from, to=Invoice, value, validAfter, validBefore, nonce) ── off-chain
relayer ── payWithAuthorization(invoiceId, from, …, v, r, s) ──▶ Invoice
           Invoice ── receiveWithAuthorization ──▶ tUSD8 ──▶ Invoice ──▶ merchant
```

Design choices:

- The signed `nonce` must equal `Invoice.authorizationNonce(invoiceId)`. That binds the signature to one invoice, so a relayer can't reuse it to mark a different invoice as paid.
- `receiveWithAuthorization` (not `transferWithAuthorization`) means only the Invoice can pull the funds, so nobody can front-run the signature into a plain transfer.
- **The amount lives on chain, in the invoice.** There is no price table in the app and nothing for a payer to over- or underpay — unlike the kit's `Checkout`, where any amount could mark an order as paid. The relayer reads `invoiceOf(invoiceId)` and refuses any amount that doesn't match.
- Invoices expire at their due date and the merchant can cancel unpaid ones. Tokens sent straight to the contract are recoverable with `recoverERC20` — nothing stays stuck.

The web relayer ([`web/src/app/api/relay/route.ts`](web/src/app/api/relay/route.ts)) pays gas for anyone who calls it, so it has rails. Keep them if you build on it:

- It only calls `payWithAuthorization` on your Invoice, never anything else.
- It only relays the amount the invoice itself sets on chain. Otherwise anyone could burn your gas with 0.000001 tUSD8 payments.
- It skips invoices that are already paid, cancelled, expired, or already being submitted, and simulates before sending.
- It refuses anvil's public keys on a real network, caps the signature window at 1 hour, and rate-limits per IP and per payer with a daily cap.
- **The limits live in memory.** That works for `next start` on one server. On serverless hosts each instance has its own copy, so move them to a shared store (Redis, your database) before going live. Set `TRUSTED_IP_HEADER` to your host's client-IP header (`x-vercel-forwarded-for` on Vercel, `cf-connecting-ip` behind Cloudflare).

Known limits:

- An invoice with no designated payer is payable by any address, so share its pay link only with the intended payer, or set the payer when you create it. Invoice ids are random 32 bytes, so nobody can guess and claim one in advance.
- The merchant is fixed at deploy time.

Code to read, in order:

1. [`contracts/src/Invoice.sol`](contracts/src/Invoice.sol)
2. [`contracts/test/Invoice.t.sol`](contracts/test/Invoice.t.sol): every rule above as a test
3. [`contracts/test/fork/AevumForkInvoice.t.sol`](contracts/test/fork/AevumForkInvoice.t.sol): the same flows against the real tUSD8
4. [`examples/src/pay-gasless.ts`](examples/src/pay-gasless.ts): create, sign + relay in about 60 lines
5. [`web/src/app/checkout/page.tsx`](web/src/app/checkout/page.tsx): both modes in the UI

---

## Things that differ from Ethereum

| | What happens | What to do |
|---|---|---|
| **Shanghai EVM** | Cancun opcodes (`MCOPY`, `TSTORE`/`TLOAD`, blob ops) don't exist. Code compiled for Cancun deploys fine, then reverts with `invalid opcode`. | Keep `evm_version = "shanghai"` in `foundry.toml` (already set). `make build` runs [`tools/check-shanghai.mjs`](tools/check-shanghai.mjs) to catch it. Don't use OpenZeppelin's `*Transient` contracts. |
| **anvil hides it** | A plain `anvil --fork-url` runs Cancun, so bad bytecode passes local tests. | Always add `--hardfork shanghai` (the Makefile does). |
| **1,000-block log limit** | `eth_getLogs` over more than 1,000 blocks fails. | Use `getLogsChunked` from `@aevum-kit/aevum`. Store your deploy block and start from there. |
| **No WebSocket RPC** | `watchContractEvent` over WS won't connect. | Poll over HTTPS (viem's default for `http()` transports). |
| **Explorer verification** | Not working yet. | See [Deploy](#deploy-to-aevum-testnet). |
| **Legacy transactions** | The kit's scripts and relayer send legacy (type 0) transactions, the same as QDay's own faucet. | `--legacy` in `forge script`, `type: "legacy"` in viem. |

---

## Project layout

```
contracts/            Foundry project
  src/Invoice.sol       the invoice contract (this app)
  src/Checkout.sol      the kit's original pay-per-order contract (kept, unused by the app)
  src/mocks/MockUSD8.sol  local tUSD8 stand-in (anyone can mint)
  test/                 unit tests + test/fork (real tUSD8 on a fork)
  script/DeployInvoice.s.sol  deploys Invoice to anvil, a fork or Aevum
packages/aevum/       chain config, ABIs, EIP-3009 typed data, getLogsChunked
web/                  Next.js app (wagmi + RainbowKit)
  src/app/page.tsx        Setup check
  src/app/invoices/new    create an invoice (merchant)
  src/app/checkout/       pay an invoice: standard + gasless
  src/app/receipts/       receipt read from the chain
  src/app/activity/       InvoiceCreated/Paid/Cancelled events, read in 1,000-block chunks
  src/app/api/relay/      gasless relayer (server-side)
  src/app/globals.css     every color and font; edit to rebrand
examples/             runnable TypeScript scripts
tools/check-shanghai.mjs  fails the build on Cancun-only opcodes
LICENSE, NOTICE.md     MIT license and third-party licenses
```

---

## Commands

```
make install        Fetch Solidity libs and JS packages
make build          Compile contracts and check they are Shanghai-safe
make test           Unit tests (local, no network)
make test-fork      Tests against the real tUSD8 on a local fork of Aevum
make check          Build, tests and typecheck (CI also runs pnpm build)
make anvil          Empty local chain (31337) with Aevum's EVM rules
make fork           Local copy of Aevum testnet on 127.0.0.1:8555 (chain 440050)
make deploy-local   Deploy MockUSD8 + Checkout to `make anvil`
make deploy-fork    Deploy Checkout (real tUSD8) to `make fork`
make deploy-aevum   Deploy Checkout to Aevum testnet (ACCOUNT=<keystore>)
make deploy-invoice-local   Deploy MockUSD8 + Invoice to `make anvil`
make deploy-invoice-fork    Deploy Invoice (real tUSD8) to `make fork`
make deploy-invoice-aevum   Deploy Invoice to Aevum testnet (ACCOUNT=<keystore>)
make mint           `make anvil` only: mint MockUSD8 (TO=, CONTRACT=, AMOUNT=)
make deal           `make fork` only: give TO tUSD8 and tQDAY
make dev            Start the web app on http://localhost:3000
```

Examples (copy `examples/.env.example` to `examples/.env` first):

```bash
pnpm example check-setup      # chain, block, gas price and balances of ADDRESS
pnpm example pay-gasless      # MERCHANT_KEY creates, BUYER_KEY signs, RELAYER_KEY submits
pnpm example read-payments    # every InvoicePaid event, 1,000 blocks at a time
```

---

## Submitting your project

Make it easy for judges to check your on-chain activity:

- Contract addresses on Aevum testnet (`44005`), with explorer links.
- A link to the exact commit you deployed.
- A few transaction hashes that show your app working (the receipt page and the activity page show them).
- A short demo video or a live URL.

Read the official rules on the DoraHacks challenge page. They win over anything here.

### Licenses and credit

The organizers confirmed that boilerplate, scaffolding and templates are allowed, as long as their license permits the use. This kit is MIT licensed, so you can build on it.

- Put a permissive open-source license on your repo, usually MIT or Apache 2.0.
- If you start from this kit, keep its `LICENSE` file (or its copyright notice) and say so in your README, for example: "Based on Aevum Starter Kit (MIT, PQA Labs)".
- Keep the original copyright and license headers in any file you copy from another project.
- Put a short comment above any code snippet you borrow, naming the source repo, author and license.
- List your third-party dependencies and their licenses in your README or a `NOTICE` file. [NOTICE.md](NOTICE.md) shows one way to do it.
- If you copy a whole directory or library, keep its original `LICENSE` file in that folder.

---

## FAQ

**Do I have to use `Invoice`?** No. It's this app's contract, forked from the kit's `Checkout`. Keep the parts you need (`packages/aevum`, the chunked log reader, the setup checker) and replace the rest.

**Can I use account abstraction?** Aevum has an ERC-4337 bundler (EntryPoint v0.7) and Kernel v3.1 accounts. A smart-account example is coming to this kit.

**Can I use Hardhat?** Yes. Set `evmVersion: "shanghai"` in the Solidity settings, and `hardfork: "shanghai"` for the Hardhat network.

**My transaction fails with `invalid opcode`.** You compiled for Cancun. See [Things that differ from Ethereum](#things-that-differ-from-ethereum).

**`eth_getLogs` errors on a big range.** Split it into 1,000-block chunks with `getLogsChunked`.

**Where do I ask for help?** In the [QDay Discord](https://discord.gg/bYPhjmrSfK)'s Builder Challenge channels (verify first to see them), Monday to Friday, 10:00 to 18:00 HKT.

**`pnpm audit` reports high advisories in `zod` and `decode-uri-component`.** Both come in through WalletConnect (`@reown/appkit-wallet` pins `zod` 3.22.4; `@walletconnect/utils` 2.21 uses `query-string`). They run only in the browser, are only reached when you set `NEXT_PUBLIC_WC_PROJECT_ID`, and at worst slow down the user's own tab. The relay route doesn't load them. The fix is upstream: RainbowKit moving to wagmi 3 brings WalletConnect 2.26, which drops `query-string`. Forcing newer versions with `pnpm.overrides` swaps in major versions WalletConnect wasn't tested with, so the kit doesn't.

---

Based on the Aevum Starter Kit (MIT, PQA Labs). MIT licensed, © 2026 PQA Labs. See [LICENSE](LICENSE). Third-party licenses are listed in [NOTICE.md](NOTICE.md).
