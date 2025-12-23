import { mergeOverlappingIntervals } from "lib/utils";

export async function main(ns: NS) {
  const host = String(ns.args[0] ?? "");
  const file = String(ns.args[1] ?? "");

  if (!host || !file) {
    ns.tprint("Usage: run solve-merge-intervals.js <host> <file.cct>");
    return;
  }

  const type = ns.codingcontract.getContractType(file, host);
  if (type !== "Merge Overlapping Intervals") {
    ns.tprint(`Skipping ${host}/${file} (type=${type})`);
    return;
  }

  const data = ns.codingcontract.getData(file, host) as number[][];
  const ans = mergeOverlappingIntervals(data);

  const res = ns.codingcontract.attempt(ans, file, host);
  ns.tprint(`${host}/${file}: answer=${JSON.stringify(ans)} => ${res || "FAILED"}`);
}
