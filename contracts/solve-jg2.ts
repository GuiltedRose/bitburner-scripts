import { minJumpsGameII } from "lib/utils";

export async function main(ns: NS) {
  const host = String(ns.args[0] ?? "");
  const file = String(ns.args[1] ?? "");

  if (!host || !file) {
    ns.tprint("Usage: run solve-jump-game-ii.js <host> <file.cct>");
    return;
  }

  const type = ns.codingcontract.getContractType(file, host);
  if (type !== "Array Jumping Game II") {
    ns.tprint(`Skipping ${host}/${file} (type=${type})`);
    return;
  }

  const data = ns.codingcontract.getData(file, host) as number[];
  const ans = minJumpsGameII(data);

  const res = ns.codingcontract.attempt(ans, file, host);
  ns.tprint(`${host}/${file}: answer=${ans} => ${res || "FAILED"}`);
}
