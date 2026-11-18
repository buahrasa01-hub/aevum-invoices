/**
 * Reads every InvoicePaid event from your Invoice, 1,000 blocks at a time (Aevum's eth_getLogs limit).
 *   FROM_BLOCK=2970000 pnpm example read-payments
 *   ADDRESS=0x… pnpm example read-payments        # only this payer
 */
import { formatUnits, getAbiItem, isAddress, type Address } from "viem";
import { erc20Abi, getLogsChunked, invoiceAbi } from "@aevum-kit/aevum";
import { connect, requiredAddress } from "./env";

const { client } = await connect();
const invoice = requiredAddress("INVOICE_ADDRESS");
const payer = process.env.ADDRESS && isAddress(process.env.ADDRESS) ? (process.env.ADDRESS as Address) : undefined;

const head = await client.getBlockNumber();
const fromBlock = process.env.FROM_BLOCK ? BigInt(process.env.FROM_BLOCK) : head > 5000n ? head - 5000n : 0n;
const token = await client.readContract({ address: invoice, abi: invoiceAbi, functionName: "token" });
const decimals = await client.readContract({ address: token, abi: erc20Abi, functionName: "decimals" });

const logs = await getLogsChunked(client, {
  address: invoice,
  event: getAbiItem({ abi: invoiceAbi, name: "InvoicePaid" }),
  args: payer ? { payer } : undefined,
  fromBlock,
  toBlock: head,
  onProgress: (done, total) => process.stderr.write(`\rscanned ${done}/${total} blocks`),
});
process.stderr.write("\n");

for (const log of logs) {
  console.log(`block ${log.blockNumber}  invoice ${log.args.invoiceId}  payer ${log.args.payer}  ${formatUnits(log.args.amount ?? 0n, decimals)}`);
}
console.log(`${logs.length} payment(s) between blocks ${fromBlock} and ${head}.`);
