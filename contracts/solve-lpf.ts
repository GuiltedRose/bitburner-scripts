import { largestPrimeFactor } from "lib/contracts";

export async function main(ns: NS) {
  const host = String(ns.args[0] ?? "");
  const file = String(ns.args[1] ?? "");

  if (!host || !file) {
    ns.tprint("Usage: run solve-lpf.js <host> <file.cct>");
    return;
  }

  const type = ns.codingcontract.getContractType(file, host);
  if (type !== "Find Largest Prime Factor") {
    ns.tprint(`Skipping ${host}/${file} (type=${type})`);
    return;
  }

  const data = ns.codingcontract.getData(file, host) as number;
  const ans = largestPrimeFactor(data);

  const res = ns.codingcontract.attempt(ans, file, host);
  ns.tprint(`${host}/${file}: answer=${ans} => ${res || "FAILED"}`);
}