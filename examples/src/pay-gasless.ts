/**
 * Gasless invoice payment, end to end, the way a real app does it:
 *   1. MERCHANT creates an invoice (on chain, fixed amount).
 *   2. BUYER signs an EIP-3009 ReceiveWithAuthorization (off-chain, free).
 *   3. RELAYER (your backend) submits Invoice.payWithAuthorization and pays the gas.
 *
 *   MERCHANT_KEY=0x… BUYER_KEY=0x… RELAYER_KEY=0x… pnpm example pay-gasless
 *   AMOUNT=2.5 pnpm example pay-gasless        # invoice amount in tUSD8
 *   INVOICE_ID=0x… pnpm example pay-gasless    # pay an existing invoice instead of creating one
 */
import { createWalletClient, formatUnits, http, keccak256, parseUnits, parseSignature, toHex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { aevumTestnet, authorizationWindow, erc20Abi, invoiceAbi, invoiceTypedData, txUrl } from "@aevum-kit/aevum";
import { connect, requiredAddress, requiredKey } from "./env";

const { client, chain, rpcUrl } = await connect();
const invoice = requiredAddress("INVOICE_ADDRESS");
const buyer = privateKeyToAccount(requiredKey("BUYER_KEY"));
const relayer = createWalletClient({ account: privateKeyToAccount(requiredKey("RELAYER_KEY")), chain, transport: http(rpcUrl) });

const token = await client.readContract({ address: invoice, abi: invoiceAbi, functionName: "token" });
const decimals = await client.readContract({ address: token, abi: erc20Abi, functionName: "decimals" });

// The amount always comes from the invoice on chain — never from a client.
let invoiceId: `0x${string}`;
let amount: bigint;
if (process.env.INVOICE_ID) {
  invoiceId = process.env.INVOICE_ID as `0x${string}`;
  const inv = await client.readContract({ address: invoice, abi: invoiceAbi, functionName: "invoiceOf", args: [invoiceId] });
  if (inv.amount === 0n) throw new Error(`No invoice ${invoiceId} on this Invoice.`);
  amount = inv.amount;
} else {
  const merchant = privateKeyToAccount(requiredKey("MERCHANT_KEY"));
  const merchantClient = createWalletClient({ account: merchant, chain, transport: http(rpcUrl) });
  amount = parseUnits(process.env.AMOUNT ?? "1", decimals);
  invoiceId = keccak256(toHex(`invoice-${Date.now()}-${Math.random()}`));
  const createHash = await merchantClient.writeContract({
    account: merchant,
    address: invoice,
    abi: invoiceAbi,
    functionName: "createInvoice",
    args: [invoiceId, buyer.address, amount, 0n, "Example invoice (pay-gasless)"],
    chain,
    type: "legacy",
  });
  await client.waitForTransactionReceipt({ hash: createHash });
  console.log(`Merchant ${merchant.address} created invoice ${invoiceId} for ${formatUnits(amount, decimals)} tUSD8`);
}

// 1. Buyer signs. The nonce ties the signature to this invoice id.
const nonce = await client.readContract({ address: invoice, abi: invoiceAbi, functionName: "authorizationNonce", args: [invoiceId] });
const { validAfter, validBefore } = authorizationWindow(600);
const signature = await buyer.signTypedData(
  invoiceTypedData(chain.id, token, { from: buyer.address, to: invoice, value: amount, validAfter, validBefore, nonce }),
);
const { v, r, s, yParity } = parseSignature(signature);
console.log(`Buyer ${buyer.address} signed ${formatUnits(amount, decimals)} for invoice ${invoiceId}`);

// 2. Relayer submits. Simulate first so a bad signature fails here, not on chain.
const call = {
  account: relayer.account,
  address: invoice,
  abi: invoiceAbi,
  functionName: "payWithAuthorization",
  args: [invoiceId, buyer.address, validAfter, validBefore, v !== undefined ? Number(v) : 27 + (yParity ?? 0), r, s],
} as const;
await client.simulateContract(call);
const hash = await relayer.writeContract({ ...call, type: "legacy" });
const receipt = await client.waitForTransactionReceipt({ hash });

console.log(`Relayer ${relayer.account.address} submitted: ${receipt.status} in block ${receipt.blockNumber}`);
console.log(chain.id === aevumTestnet.id ? txUrl(hash) : `tx ${hash}`);
