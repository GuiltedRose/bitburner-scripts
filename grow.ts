import { allHosts } from "lib/utils";

export async function main(ns: NS) {
  const hosts = allHosts(ns).filter(h => h !== "home");

  for (const t of allHosts(ns)) {
    if (!ns.hasRootAccess(t)) continue;

    const goal = ns.getServerMaxMoney(t) * 0.9;

    while (ns.getServerMoneyAvailable(t) < goal) {
      await ns.grow(t);
    }
  }
}
