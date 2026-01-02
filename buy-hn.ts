export async function main(ns: NS) {
  ns.disableLog("sleep");
  ns.disableLog("getServerMoneyAvailable");

  const SLEEP_MS = 2000;

  // Hacknet NODE caps
  const MAX_LEVEL = 200;
  const MAX_RAM = 64;   // GB
  const MAX_CORES = 16;

  const money = () => ns.getServerMoneyAvailable("home");

  const ramUpgradesNeeded = (curRam: number) => {
    if (curRam >= MAX_RAM) return 0;
    return Math.round(Math.log2(MAX_RAM / curRam)); // doublings
  };

  const isMaxed = (i: number) => {
    const s = ns.hacknet.getNodeStats(i);
    return s.level >= MAX_LEVEL && s.ram >= MAX_RAM && s.cores >= MAX_CORES;
  };

  const costToMaxFromCurrent = (i: number) => {
    const s = ns.hacknet.getNodeStats(i);

    const needLv = Math.max(0, MAX_LEVEL - s.level);
    const needCore = Math.max(0, MAX_CORES - s.cores);
    const needRamUp = ramUpgradesNeeded(s.ram);

    const lvlCost = needLv > 0 ? ns.hacknet.getLevelUpgradeCost(i, needLv) : 0;
    const ramCost = needRamUp > 0 ? ns.hacknet.getRamUpgradeCost(i, needRamUp) : 0;
    const coreCost = needCore > 0 ? ns.hacknet.getCoreUpgradeCost(i, needCore) : 0;

    return lvlCost + ramCost + coreCost;
  };

  const maxNodeNow = (i: number) => {
    let s = ns.hacknet.getNodeStats(i);

    const needLv = Math.max(0, MAX_LEVEL - s.level);
    if (needLv > 0) ns.hacknet.upgradeLevel(i, needLv);

    s = ns.hacknet.getNodeStats(i);
    const needRamUp = ramUpgradesNeeded(s.ram);
    if (needRamUp > 0) ns.hacknet.upgradeRam(i, needRamUp);

    s = ns.hacknet.getNodeStats(i);
    const needCore = Math.max(0, MAX_CORES - s.cores);
    if (needCore > 0) ns.hacknet.upgradeCore(i, needCore);
  };

  while (true) {
    const num = ns.hacknet.numNodes();
    const canBuyMore = num < ns.hacknet.maxNumNodes();

    // A) If we can buy more: ONLY buy when we can immediately max
    if (canBuyMore) {
      const buyCost = ns.hacknet.getPurchaseNodeCost();

      // We need an index to compute exact upgrade costs, so:
      // 1) Wait until we can afford the buy itself first (cheap check)
      // 2) Then do a "dry run" by buying, computing exact max cost, and if we can't afford it,
      //    we DO NOT upgrade at all; we just wait until we can, then max in one go.
      // This guarantees: never partial upgrades, and you won't "progress" the node until you can max it.
      if (money() < buyCost) {
        ns.print(`Stalling: need ${ns.formatNumber(buyCost)} to buy new node. Have ${ns.formatNumber(money())}`);
        await ns.sleep(SLEEP_MS);
        continue;
      }

      const idx = ns.hacknet.purchaseNode();
      if (idx === -1) {
        await ns.sleep(SLEEP_MS);
        continue;
      }

      // Now enforce strict rule: do not upgrade unless we can afford the FULL remaining-to-max cost.
      while (!isMaxed(idx)) {
        const need = costToMaxFromCurrent(idx);
        if (money() < need) {
          ns.print(
            `Stalling: refusing partial upgrades. To max new node #${idx} need ${ns.formatNumber(need)}. ` +
            `Have ${ns.formatNumber(money())}`
          );
          await ns.sleep(SLEEP_MS);
          continue;
        }
        maxNodeNow(idx);
      }

      ns.tprint(`Bought + maxed Hacknet node #${idx}.`);
      continue;
    }

    // B) Otherwise: max the cheapest-to-finish existing node, but only when we can afford FULL remaining cost
    let bestIdx = -1;
    let bestCost = Infinity;

    for (let i = 0; i < num; i++) {
      if (isMaxed(i)) continue;
      const c = costToMaxFromCurrent(i);
      if (c < bestCost) {
        bestCost = c;
        bestIdx = i;
      }
    }

    if (bestIdx === -1) {
      ns.print("All Hacknet nodes are maxed. Sleeping...");
      await ns.sleep(10_000);
      continue;
    }

    if (money() < bestCost) {
      ns.print(`Stalling: to max node #${bestIdx} need ${ns.formatNumber(bestCost)}. Have ${ns.formatNumber(money())}`);
      await ns.sleep(SLEEP_MS);
      continue;
    }

    maxNodeNow(bestIdx);
    ns.tprint(`Maxed Hacknet node #${bestIdx}.`);
    await ns.sleep(SLEEP_MS);
  }
}
