import { generateIPAddresses } from "lib/contracts";

export async function main(ns: NS) {
  const host = String(ns.args[0] ?? "");
  const file = String(ns.args[1] ?? "");

  if (!host || !file) {
    ns.tprint("Usage: run solve-generate-ip.js <host> <file.cct>");
    return;
  }

  const type = ns.codingcontract.getContractType(file, host);
  if (type !== "Generate IP Addresses") {
    ns.tprint(`Skipping ${host}/${file} (type=${type})`);
    return;
  }

  const data = ns.codingcontract.getData(file, host) as string;
  const ans = generateIPAddresses(data);

  // Helpful debug:
  ns.tprint(`Found ${ans.length} IPs: ${JSON.stringify(ans)}`);

  const res = ns.codingcontract.attempt(ans, file, host);
  ns.tprint(`${host}/${file}: ${res || "FAILED"}`);
}
