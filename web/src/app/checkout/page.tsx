"use client";

import { addressUrl, invoiceAbi, invoiceTypedData, authorizationWindow, erc20Abi, txUrl } from "@aevum-kit/aevum";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { Suspense, useEffect, useMemo, useState } from "react";
import { formatUnits, isHex, type Hash, type Hex } from "viem";
import { useAccount, useConfig, useReadContract } from "wagmi";
import { readContract, signTypedData, simulateContract, waitForTransactionReceipt, writeContract } from "wagmi/actions";
import { CheckIcon } from "@/components/Icons";
import { useToken } from "@/components/useToken";
import { useNetwork } from "@/lib/network";
import { explain } from "@/lib/errors";
import { dueLabel, formatTusd8, invoiceLabel, short } from "@/lib/order";

type Mode = "gasless" | "standard";
type Phase = "idle" | "working" | "done" | "error";

const ZERO = "0x0000000000000000000000000000000000000000";

const STEPS: Record<Mode, { title: string; who: string }[]> = {
  gasless: [
    { title: "Sign payment authorization", who: "EIP-3009 · your wallet signs, no gas" },
    { title: "Relayer submits transaction", who: "payWithAuthorization · the relayer pays gas" },
    { title: "Confirmed on Aevum", who: "The InvoicePaid event is your receipt" },
  ],
  standard: [
    { title: "Approve tUSD8", who: "approve(Invoice, exact amount) · you pay gas" },
    { title: "Pay invoice", who: "Invoice.pay(invoiceId) · you pay gas" },
    { title: "Confirmed on Aevum", who: "The InvoicePaid event is your receipt" },
  ],
};

function PayPageInner() {
  const { net } = useNetwork();
  const appChain = net.chain;
  const invoiceAddress = net.invoice;
  const hasExplorer = net.hasExplorer;
  const config = useConfig();
  const { address, isConnected, chainId } = useAccount();
  const onChain = isConnected && chainId === appChain.id;
  const token = useToken();
  const search = useSearchParams();
  const paramId = search.get("id") ?? "";

  const [typedId, setTypedId] = useState(paramId);
  useEffect(() => setTypedId(paramId), [paramId]);
  const invoiceId = (isHex(typedId) && typedId.length === 66 ? typedId : null) as Hex | null;

  const [mode, setMode] = useState<Mode>("gasless");
  const [step, setStep] = useState(0);
  const [phase, setPhase] = useState<Phase>("idle");
  const [error, setError] = useState<string | null>(null);
  const [txHash, setTxHash] = useState<Hash | null>(null);
  const [block, setBlock] = useState<bigint | null>(null);

  const [relayEnabled, setRelayEnabled] = useState(false);
  useEffect(() => {
    let cancelled = false;
    fetch(`/api/relay?chainId=${appChain.id}`)
      .then((r) => r.json())
      .then((d) => {
        if (!cancelled) setRelayEnabled(Boolean((d as { enabled?: boolean }).enabled));
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [appChain.id]);
  const gaslessAvailable = relayEnabled;
  useEffect(() => {
    setMode(gaslessAvailable ? "gasless" : "standard");
  }, [gaslessAvailable]);

  const invoice = useReadContract({
    address: invoiceAddress,
    abi: invoiceAbi,
    functionName: "invoiceOf",
    args: invoiceId ? [invoiceId] : undefined,
    chainId: appChain.id,
    query: { enabled: Boolean(invoiceId && invoiceAddress) },
  });
  const inv = invoice.data;
  const exists = Boolean(inv && inv.amount > 0n);
  const nowSec = Math.floor(Date.now() / 1000);
  const expired = exists && inv!.dueAt !== 0n && Number(inv!.dueAt) < nowSec;
  const status = !exists ? "not-found" : inv!.paid ? "paid" : inv!.cancelled ? "cancelled" : expired ? "expired" : "open";
  const isOpen = status === "open";
  const designated = exists && inv!.payer !== ZERO;
  const wrongPayer = designated && address !== undefined && inv!.payer.toLowerCase() !== address.toLowerCase();
  const amount = exists ? inv!.amount : 0n;

  const balance = useReadContract({
    address: token.address,
    abi: erc20Abi,
    functionName: "balanceOf",
    args: address ? [address] : undefined,
    chainId: appChain.id,
    query: { enabled: onChain && Boolean(token.address) },
  });
  const enoughBalance = balance.data === undefined || balance.data >= amount;
  const busy = phase === "working";

  function reset(nextMode = mode) {
    setMode(nextMode);
    setStep(0);
    setPhase("idle");
    setError(null);
    setTxHash(null);
    setBlock(null);
  }

  /** Stop before any signature or gas is spent if this invoice can't be paid. */
  async function assertPayable() {
    if (!invoiceId || !invoiceAddress) throw new Error("Pick an invoice first.");
    const open = await readContract(config, { address: invoiceAddress, abi: invoiceAbi, functionName: "isOpen", args: [invoiceId], chainId: appChain.id });
    if (!open) throw new Error("This invoice is no longer open (paid, cancelled, or expired).");
  }

  async function payGasless() {
    if (!address || !invoiceAddress || !token.address || !invoiceId) return;
    await assertPayable();
    // 1. Sign. The nonce comes from the contract and ties this signature to this invoice.
    const nonce = await readContract(config, { address: invoiceAddress, abi: invoiceAbi, functionName: "authorizationNonce", args: [invoiceId], chainId: appChain.id });
    const { validAfter, validBefore } = authorizationWindow(600);
    const signature = await signTypedData(config, {
      account: address,
      ...invoiceTypedData(appChain.id, token.address, { from: address, to: invoiceAddress, value: amount, validAfter, validBefore, nonce }),
    });
    setStep(1);
    // 2. Hand it to the relayer (web/src/app/api/relay/route.ts).
    const res = await fetch("/api/relay", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chainId: appChain.id,
        orderId: invoiceId,
        from: address,
        amount: amount.toString(),
        validAfter: validAfter.toString(),
        validBefore: validBefore.toString(),
        signature,
      }),
    });
    const data = (await res.json()) as { hash?: Hash; error?: string };
    if (!res.ok || !data.hash) throw new Error(data.error ?? "The relayer didn't accept the payment.");
    setTxHash(data.hash);
    setStep(2);
    return data.hash;
  }

  async function payStandard() {
    if (!address || !invoiceAddress || !token.address || !invoiceId) return;
    await assertPayable();
    // 1. Approve exactly the invoiced amount, never an unlimited amount.
    const allowance = await readContract(config, { address: token.address, abi: erc20Abi, functionName: "allowance", args: [address, invoiceAddress], chainId: appChain.id });
    if (allowance < amount) {
      const approveHash = await writeContract(config, { address: token.address, abi: erc20Abi, functionName: "approve", args: [invoiceAddress, amount], chainId: appChain.id });
      await waitForTransactionReceipt(config, { hash: approveHash, chainId: appChain.id });
    }
    setStep(1);
    // 2. Pay. The contract takes the exact invoiced amount — there is no amount argument.
    // Simulate first: a revert shows up here with its reason, before the wallet asks for gas.
    const { request } = await simulateContract(config, { account: address, address: invoiceAddress, abi: invoiceAbi, functionName: "pay", args: [invoiceId], chainId: appChain.id });
    const hash = await writeContract(config, request);
    setTxHash(hash);
    setStep(2);
    return hash;
  }

  async function onPay() {
    if (phase === "done") {
      reset();
      return;
    }
    setError(null);
    setPhase("working");
    setStep(0);
    try {
      const hash = mode === "gasless" ? await payGasless() : await payStandard();
      if (!hash) throw new Error("Connect your wallet first.");
      const receipt = await waitForTransactionReceipt(config, { hash, chainId: appChain.id });
      if (receipt.status !== "success") throw new Error("The transaction reverted on chain. Nothing was charged.");
      setBlock(receipt.blockNumber);
      setStep(3);
      setPhase("done");
      balance.refetch();
      invoice.refetch();
    } catch (e) {
      setError(explain(e));
      setPhase("error");
    }
  }

  const blockers = useMemo(() => {
    const list: string[] = [];
    if (!invoiceId) list.push("Paste an invoice id to load it.");
    else if (!exists) list.push("No invoice with this id exists on this network.");
    else if (status === "paid") list.push("This invoice is already paid.");
    else if (status === "cancelled") list.push("This invoice was cancelled by the merchant.");
    else if (status === "expired") list.push("This invoice is past its due date.");
    else if (wrongPayer) list.push("This invoice is for a different payer address.");
    return list;
  }, [invoiceId, exists, status, wrongPayer]);

  const cta = (() => {
    if (!isConnected) return "Connect a wallet to pay";
    if (!onChain) return "Switch network to pay";
    if (!invoiceAddress) return "Deploy Invoice first";
    if (phase === "done") return "Pay another invoice";
    if (phase === "error") return mode === "gasless" ? "Sign again" : "Try again";
    if (busy) return ["Check your wallet…", mode === "gasless" ? "Waiting for relayer…" : "Check your wallet…", "Confirming…"][step] ?? "Working…";
    return mode === "gasless"
      ? `Sign & pay ${formatTusd8(amount, token.decimals)} ${token.symbol}`
      : `Approve & pay ${formatTusd8(amount, token.decimals)} ${token.symbol}`;
  })();
  const ctaDisabled = !onChain || !invoiceAddress || busy || blockers.length > 0 || (!enoughBalance && phase !== "done");

  return (
    <main className="shell">
      <div className="page-head">
        <div>
          <p className="eyebrow">Invoice · {net.label}</p>
          <h1>Pay an invoice</h1>
          <p className="lede">Paste an invoice id — or open a pay link from the merchant — and pay the exact amount in {token.symbol}.</p>
        </div>
      </div>

      <section className="card stack" aria-label="Find invoice" style={{ marginBottom: 16 }}>
        <label style={{ display: "flex", flexDirection: "column", gap: 6 }}>
          <span style={{ fontWeight: 600 }}>Invoice id</span>
          <input
            className="field"
            type="text"
            value={typedId}
            disabled={busy}
            placeholder="0x… (32-byte hex)"
            onChange={(e) => {
              setTypedId(e.target.value.trim());
              reset();
            }}
          />
        </label>
        <p className="fine">
          Don&apos;t have one? The merchant creates invoices on the <Link href="/invoices/new">Create invoice</Link> page.
        </p>
      </section>

      {invoiceId && (
        <div className="row">
          <section className="card stack" aria-label="Invoice" style={{ flex: "1 1 340px" }}>
            <div className="check-top" style={{ alignItems: "baseline" }}>
              <h2>Invoice</h2>
              <span className="mono" style={{ color: "var(--text-muted)" }}>{invoiceLabel(invoiceId)}</span>
            </div>
            {!invoiceAddress ? (
              <p style={{ color: "var(--text-muted)" }}>No Invoice is configured for {appChain.name} in this app.</p>
            ) : invoice.isLoading ? (
              <p className="empty">Reading Invoice.invoiceOf…</p>
            ) : invoice.isError ? (
              <p className="empty">
                Couldn&apos;t read the invoice from {appChain.name}. The RPC may be busy.{" "}
                <button type="button" className="btn small" onClick={() => invoice.refetch()}>
                  Try again
                </button>
              </p>
            ) : !exists ? (
              <p className="empty">No invoice with this id exists on {appChain.name}.</p>
            ) : (
              <>
                <div className="check-top" style={{ alignItems: "center" }}>
                  <span className={`status-pill ${status === "open" ? "good" : status === "paid" ? "good" : "warn"}`}>
                    {status === "open" ? "Open" : status === "paid" ? "Paid" : status === "cancelled" ? "Cancelled" : "Expired"}
                  </span>
                  <span className="fine">{dueLabel(inv!.dueAt)}</span>
                </div>
                {inv!.memo && <p style={{ fontSize: 17, fontWeight: 600 }}>{inv!.memo}</p>}
                <div className="receipt-amount">
                  {formatUnits(inv!.amount, token.decimals)} <small style={{ fontSize: "0.4em", color: "var(--text-muted)" }}>{token.symbol}</small>
                </div>
                <dl className="kv" style={{ fontSize: 13 }}>
                  <dt>Invoice id</dt>
                  <dd>{invoiceId}</dd>
                  <dt>Payer</dt>
                  <dd>
                    {designated ? (
                      hasExplorer ? (
                        <a href={addressUrl(inv!.payer)} target="_blank" rel="noreferrer">
                          {inv!.payer}
                        </a>
                      ) : (
                        inv!.payer
                      )
                    ) : (
                      "Anyone may pay"
                    )}
                  </dd>
                  <dt>Merchant</dt>
                  <dd>{invoiceAddress ? short(invoiceAddress) : "—"}</dd>
                  <dt>Your balance</dt>
                  <dd>{balance.data !== undefined ? `${formatUnits(balance.data, token.decimals)} ${token.symbol}` : "—"}</dd>
                  {inv!.paid && (
                    <>
                      <dt>Paid by</dt>
                      <dd>{inv!.paidBy}</dd>
                      <dt>Paid at</dt>
                      <dd>{new Date(Number(inv!.paidAt) * 1000).toLocaleString()}</dd>
                    </>
                  )}
                </dl>
              </>
            )}
          </section>

          <section className="card stack" aria-label="Payment" style={{ flex: "1.3 1 420px" }}>
            <div className="modes" role="radiogroup" aria-label="Payment mode">
              {(
                [
                  { id: "gasless", title: "Gasless", tag: "EIP-3009", desc: gaslessAvailable ? "Sign once. A relayer submits it. You need no tQDAY." : "Off: set RELAYER_PRIVATE_KEY in web/.env.local to enable." },
                  { id: "standard", title: "Standard", tag: "approve + pay", desc: "Two wallet transactions. You pay gas in tQDAY." },
                ] as const
              ).map((m) => (
                <button
                  key={m.id}
                  type="button"
                  role="radio"
                  className="mode"
                  aria-checked={mode === m.id}
                  disabled={busy || (m.id === "gasless" && !gaslessAvailable)}
                  onClick={() => reset(m.id)}
                >
                  <span className="mode-top">
                    {m.title}
                    <span className="tag">{m.tag}</span>
                  </span>
                  <span className="mode-desc">{m.desc}</span>
                </button>
              ))}
            </div>

            <ol className="steps">
              {STEPS[mode].map((s, i) => {
                const done = step > i;
                const active = busy && step === i;
                return (
                  <li key={s.title} className={`step ${done ? "done" : active ? "active" : ""}`}>
                    <div className="step-dot">{done ? <CheckIcon /> : i + 1}</div>
                    <div className="step-body">
                      <div className="step-top">
                        <span className="step-title">{s.title}</span>
                        <span className="step-state">{done ? "Done" : active ? "In progress…" : "Waiting"}</span>
                      </div>
                      <p className="step-who">{s.who}</p>
                    </div>
                  </li>
                );
              })}
            </ol>

            {blockers.length > 0 && phase !== "done" && (
              <div className="notice warn" role="status">
                <strong>Can&apos;t pay this invoice</strong>
                {blockers.map((b) => (
                  <span key={b}>{b}</span>
                ))}
              </div>
            )}

            {!enoughBalance && phase !== "done" && isOpen && (
              <div className="notice warn" role="status">
                <strong>Not enough {token.symbol}</strong>
                <span>
                  This invoice needs {formatTusd8(amount, token.decimals)} {token.symbol}. See the <Link href="/">Setup</Link> page for how
                  to get test tokens.
                </span>
              </div>
            )}

            {error && (
              <div className="notice bad" role="alert">
                <strong>Payment didn&apos;t go through</strong>
                <span>{error}</span>
              </div>
            )}

            {phase === "done" && txHash && (
              <div className="notice good" role="status">
                <div className="row-between">
                  <strong>
                    Paid {formatTusd8(amount, token.decimals)} {token.symbol}
                    {block !== null ? ` · confirmed in block ${block.toLocaleString("en-US")}` : ""}
                  </strong>
                  <span style={{ display: "flex", gap: 16 }}>
                    {hasExplorer && (
                      <a href={txUrl(txHash)} target="_blank" rel="noreferrer">
                        Explorer
                      </a>
                    )}
                    <Link href={`/receipts/${invoiceId}?tx=${txHash}&chain=${appChain.id}`}>View receipt</Link>
                  </span>
                </div>
              </div>
            )}

            <button type="button" className="btn big block" disabled={ctaDisabled} onClick={onPay}>
              {cta}
            </button>
            <p className="fine">
              {mode === "gasless"
                ? "The signature is valid for 10 minutes, for this exact invoiced amount, and only for this invoice."
                : "The approval is for the exact invoiced amount, never unlimited. The contract takes the amount from the invoice, not from you."}
            </p>
          </section>
        </div>
      )}
    </main>
  );
}

export default function PayPage() {
  return (
    <Suspense fallback={<main className="shell"><p className="empty">Loading…</p></main>}>
      <PayPageInner />
    </Suspense>
  );
}
