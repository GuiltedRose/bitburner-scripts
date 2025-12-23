export async function main(ns: NS) {
  ns.disableLog("sleep");

  while (true) {
    const money = ns.getServerMoneyAvailable("home");

    // 1) Buy new node if possible
    if (ns.hacknet.numNodes() < ns.hacknet.maxNumNodes()) {
      const cost = ns.hacknet.getPurchaseNodeCost();
      if (money > cost) {
        ns.hacknet.purchaseNode();
        continue;
      }
    }

    // 2) Upgrade existing nodes
    for (let i = 0; i < ns.hacknet.numNodes(); i++) {
      const lvlCost = ns.hacknet.getLevelUpgradeCost(i, 1);
      const ramCost = ns.hacknet.getRamUpgradeCost(i, 1);
      const coreCost = ns.hacknet.getCoreUpgradeCost(i, 1);

      if (money > lvlCost) {
        ns.hacknet.upgradeLevel(i, 1);
      } else if (money > ramCost) {
        ns.hacknet.upgradeRam(i, 1);
      } else if (money > coreCost) {
        ns.hacknet.upgradeCore(i, 1);
      }
    }

    await ns.sleep(2000);
  }
}
