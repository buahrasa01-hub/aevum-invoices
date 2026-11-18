"use client";

import { invoiceAbi, txUrl } from "@aevum-kit/aevum";
import Link from "next/link";
import { useState } from "react";
import { isAddress, parseUnits, type Hash, type Hex } from "viem";
import { useAccount, useConfig } from "wagmi";
import { simulateContract, waitForTransactionReceipt, writeContract } from "wagmi/actions";
import { useNetwork } from "@/lib/network";
import { useToken } from "@/components/useToken";
import { explain } from "@/lib/errors";
import { invoiceLabel, newInvoiceId, short } from "@/lib/order";

type Phase = "idle" | "working" | "done" | "error";

export default function NewInvoicePage() {
  const { net } = useNetwork();
  const appChain = net.chain;
  const invoiceAddress = net.invoice;
  const hasExplorer = net.hasExplorer;
  const config = useConfig();
  const { address, isConnected, chainId } = useAccount();
  const onChain = isConnected && chainId === appChain.id;
  const token = useToken();

  const [payer, setPayer] = useState("");
  const [amount, setAmount] = useState("");
  const [due, setDue] = useState("");
  const [memo, setMemo] = useState("");
  const [phase, setPhase] = useState<Phase>("idle");
  const [error, setError] = useState<string | null>(null);
  const [invoiceId, setInvoiceId] = useState<Hex | null>(null);
  const [txHash, setTxHash] = useState<Hash | null>(null);

  const busy = phase === "working";
  const payerOk = payer.trim() === "" || isAddress(payer.trim());
  const amountOk = (() => {
    try {
      return amount.trim() !== "" && parseUnits(amount.trim(), token.decimals) > 0n;
    } catch {
      return false;
    }
  })();
  const dueOk = (() => {
    if (due.trim() === "") return true;
    const t = new Date(due).getTime();
    return Number.isFinite(t) && t > Date.now();
  })();
  const formOk = payerOk && amountOk && dueOk && memo.trim() !== "";
  const ctaDisabled = !onChain || !invoiceAddress || busy || !formOk;

  async function onCreate() {
    if (!address || !invoiceAddress) return;
    setError(null);
    setPhase("working");
    try {
      const id = newInvoiceId();
      const payerAddr = (payer.trim() === "" ? "0x0000000000000000000000000000000000000000" : payer.trim()) as Hex;
      const value = parseUnits(amount.trim(), token.decimals);
      const dueAt = due.trim() === "" ? 0n : BigInt(Math.floor(new Date(due).getTime() / 1000));
      // Simulate first: a revert shows up here with its reason, before the wallet asks for gas.
      const { request } = await simulateContract(config, {
        account: address,
        address: invoiceAddress,
        abi: invoiceAbi,
        functionName: "createInvoice",
        args: [id, payerAddr, value, dueAt, memo.trim()],
        chainId: appChain.id,
      });
      const hash = await writeContract(config, request);
      const receipt = await waitForTransactionReceipt(config, { hash, chainId: appChain.id });
      if (receipt.status !== "success") throw new Error("The transaction reverted on chain. Nothing was created.");
      setInvoiceId(id);
      setTxHash(hash);
      setPhase("done");
    } catch (e) {
      setError(explain(e));
      setPhase("error");
    }
  }

  function reset() {
    setPayer("");
    setAmount("");
    setDue("");
    setMemo("");
    setPhase("idle");
    setError(null);
    setInvoiceId(null);
    setTxHash(null);
  }

  return (
    <main className="shell" style={{ maxWidth: 760 }}>
      <div className="page-head">
        <div>
          <p className="eyebrow">Invoice · {net.label}</p>
          <h1>Create an invoice</h1>
          <p className="lede">
            The merchant (your connected wallet) creates an invoice for a payer. The buyer then pays the exact amount in {token.symbol} —
            standard or gasless. The money goes straight to you.
          </p>
        </div>
      </div>

      <section className="card stack" aria-label="New invoice">
        {phase === "done" && invoiceId ? (
          <>
            <div className="notice good" role="status">
              <strong>
                Invoice {invoiceLabel(invoiceId)} created
                {txHash && hasExplorer ? (
                  <>
                    {" · "}
                    <a href={txUrl(txHash)} target="_blank" rel="noreferrer">
                      Explorer
                    </a>
                  </>
                ) : null}
              </strong>
              <span>
                Share the pay link with your payer: <code>{`/checkout?id=${invoiceId}`}</code>
              </span>
            </div>
            <div style={{ display: "flex", gap: 12, flexWrap: "wrap" }}>
              <Link className="btn" href={`/checkout?id=${invoiceId}`}>
                Open pay page
              </Link>
              <Link className="btn secondary" href={`/receipts/${invoiceId}?chain=${appChain.id}`}>
                View receipt
              </Link>
              <button type="button" className="btn secondary" onClick={reset}>
                Create another
              </button>
            </div>
          </>
        ) : (
          <>
            <label style={{ display: "flex", flexDirection: "column", gap: 6 }}>
              <span style={{ fontWeight: 600 }}>Payer address (optional)</span>
              <input
                className="field"
                type="text"
                value={payer}
                disabled={busy}
                placeholder="0x… — empty means anyone may pay"
                onChange={(e) => setPayer(e.target.value)}
              />
              {!payerOk && <span className="fine">That doesn&apos;t look like an address.</span>}
            </label>

            <label style={{ display: "flex", flexDirection: "column", gap: 6 }}>
              <span style={{ fontWeight: 600 }}>Amount ({token.symbol})</span>
              <input className="field" type="text" inputMode="decimal" value={amount} disabled={busy} placeholder="e.g. 5.00" onChange={(e) => setAmount(e.target.value)} />
              {!amountOk && amount !== "" && <span className="fine">Enter an amount above 0.</span>}
            </label>

            <label style={{ display: "flex", flexDirection: "column", gap: 6 }}>
              <span style={{ fontWeight: 600 }}>Due date (optional)</span>
              <input className="field" type="datetime-local" value={due} disabled={busy} onChange={(e) => setDue(e.target.value)} />
              {!dueOk && <span className="fine">Pick a date in the future, or leave it empty for no expiry.</span>}
            </label>

            <label style={{ display: "flex", flexDirection: "column", gap: 6 }}>
              <span style={{ fontWeight: 600 }}>Memo</span>
              <input
                className="field"
                type="text"
                value={memo}
                disabled={busy}
                placeholder="e.g. Website redesign - milestone 1"
                onChange={(e) => setMemo(e.target.value)}
              />
            </label>

            <dl className="kv" style={{ fontSize: 13 }}>
              <dt>Invoice contract</dt>
              <dd>{invoiceAddress ? short(invoiceAddress) : "not deployed"}</dd>
              <dt>Merchant</dt>
              <dd>{address ? short(address) : "connect your wallet"}</dd>
            </dl>

            {error && (
              <div className="notice bad" role="alert">
                <strong>Couldn&apos;t create the invoice</strong>
                <span>{error}</span>
              </div>
            )}

            <button type="button" className="btn big block" disabled={ctaDisabled} onClick={onCreate}>
              {!isConnected
                ? "Connect a wallet to create"
                : !onChain
                  ? "Switch network to create"
                  : !invoiceAddress
                    ? "Deploy Invoice first"
                    : busy
                      ? "Check your wallet…"
                      : phase === "error"
                        ? "Try again"
                        : "Create invoice"}
            </button>
            <p className="fine">
              Only the merchant can create invoices — the contract enforces it. The invoice id is random 32 bytes, so nobody can guess and
              claim it in advance.
            </p>
          </>
        )}
      </section>
    </main>
  );
}
