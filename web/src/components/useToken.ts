"use client";

import { erc20Abi, invoiceAbi, TUSD8_ADDRESS } from "@aevum-kit/aevum";
import type { Address } from "viem";
import { useReadContract, useReadContracts } from "wagmi";
import { useNetwork } from "@/lib/network";

/**
 * The payment token. Read from Invoice.token() when an Invoice is configured (works for the
 * local MockUSD8 too); otherwise tUSD8 on Aevum.
 */
export function useToken() {
  const { net } = useNetwork();
  const appChain = net.chain;
  const invoiceAddress = net.invoice;
  const fromInvoice = useReadContract({
    address: invoiceAddress,
    abi: invoiceAbi,
    functionName: "token",
    chainId: appChain.id,
    query: { enabled: Boolean(invoiceAddress) },
  });
  const address: Address | undefined = fromInvoice.data ?? (net.key === "local" ? undefined : TUSD8_ADDRESS);
  const meta = useReadContracts({
    contracts: address
      ? [
          { address, abi: erc20Abi, functionName: "decimals", chainId: appChain.id },
          { address, abi: erc20Abi, functionName: "symbol", chainId: appChain.id },
        ]
      : [],
    query: { enabled: Boolean(address) },

  });
  const decimals = (meta.data?.[0]?.result as number | undefined) ?? 6;
  const symbol = (meta.data?.[1]?.result as string | undefined) ?? "tUSD8";
  return { address, decimals, symbol, isLoading: fromInvoice.isLoading || meta.isLoading };
}
