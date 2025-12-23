import { uniquePathsGridII } from "lib/utils";

export async function main(ns: NS) {
  const host = String(ns.args[0]);
  const file = String(ns.args[1]);

  const type = ns.codingcontract.getContractType(file, host);
  if (type !== "Unique Paths in a Grid II") {
    ns.tprint(`Skipping ${host}/${file} (type=${type})`);
    return;
  }

  const data = ns.codingcontract.getData(file, host) as number[][];

  const ans = uniquePathsGridII(data);
  const res = ns.codingcontract.attempt(ans, file, host);

  ns.tprint(`${host}/${file}: ${res || "FAILED"}`);
}
