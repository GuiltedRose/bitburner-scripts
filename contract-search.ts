import { allHosts } from "lib/utils";

export async function main(ns: NS) {
  for (const host of allHosts(ns)) {
    const contracts = ns.ls(host, ".cct");

    for (const file of contracts) {
      const type = ns.codingcontract.getContractType(file, host);
      const data = ns.codingcontract.getData(file, host);
      const desc = ns.codingcontract.getDescription(file, host);

      ns.tprint("────────────────────────────");
      ns.tprint(`Host: ${host}`);
      ns.tprint(`File: ${file}`);
      ns.tprint(`Type: ${type}`);
      ns.tprint(`Data: ${JSON.stringify(data)}`);
      ns.tprint(`Description:\n${desc}`);
    }
  }
}

