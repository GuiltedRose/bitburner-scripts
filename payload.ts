import { allHosts } from "lib/utils";

function bestMoneyTarget(ns: NS): string {
  let best = "n00dles";
  let bestMoney = 0;
  const hackLvl = ns.getHackingLevel();

  for (const cur of allHosts(ns)) {
    const maxMoney = ns.getServerMaxMoney(cur);
    if (
      maxMoney > bestMoney &&
      ns.hasRootAccess(cur) &&
      ns.getServerRequiredHackingLevel(cur) <= hackLvl
    ) {
      bestMoney = maxMoney;
      best = cur;
    }
  }
  return best;
}

export async function main(ns: NS) {
  let target = String(ns.args[0] ?? ns.getHostname()); // If this server can't hold money, redirect to a real target 
  if (ns.getServerMaxMoney(target) === 0) {
    target = bestMoneyTarget(ns);
  }
  while (true) {
    if (ns.getServerSecurityLevel(target) > ns.getServerMinSecurityLevel(target) + 5) {
      await ns.weaken(target);
    }
    else if (ns.getServerMoneyAvailable(target) < ns.getServerMaxMoney(target) * 0.75) {
      await ns.grow(target);
    } else {
      await ns.hack(target);
    }
  }
}
