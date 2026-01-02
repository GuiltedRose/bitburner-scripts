export async function main(ns: NS) {
  let tierRam = Number(ns.args[0] ?? 8);
  const prefix = String(ns.args[1] ?? "pserv-");
  const reserve = Number(ns.args[2] ?? 0);
  const redeployMode = String(ns.args[3] ?? "each");

  const limit = ns.getPurchasedServerLimit();
  const maxRam = ns.getPurchasedServerMaxRam();
  const deployScript = "deploy.ts";

  const money = () => ns.getServerMoneyAvailable("home");
  const canAfford = (cost: number) => money() >= cost + reserve;

  const waitFor = async (cost: number, label: string) => {
    while (!canAfford(cost)) {
      ns.print(
        `Waiting: ${label} costs ${ns.formatNumber(cost)} (reserve ${ns.formatNumber(reserve)}). ` +
          `Have ${ns.formatNumber(money())}`
      );
      await ns.sleep(1000);
    }
  };

  const redeploy = async () => {
    if (redeployMode === "none") return;
    ns.run(deployScript);
  };

  const passOnce = async (ramGoal: number) => {
    const desiredNames = Array.from({ length: limit }, (_, i) => `${prefix}${i}`);
    const ramOf = (h: string) => ns.getServerMaxRam(h);

    // 1) Buy missing desired servers at ramGoal
    for (const name of desiredNames) {
      if (ns.serverExists(name)) continue;

      const cost = ns.getPurchasedServerCost(ramGoal);
      await waitFor(cost, `buy ${name} @ ${ramGoal}GB`);

      const res = ns.purchaseServer(name, ramGoal);
      if (!res) {
        ns.tprint(`Failed to buy ${name}.`);
        return false;
      }

      ns.tprint(`Bought ${name} (${ramGoal}GB) for ${ns.formatNumber(cost)}`);
      if (redeployMode === "each") await redeploy();
    }

    // 2) Upgrade any purchased server below ramGoal (smallest first)
    let pservs = ns.getPurchasedServers().slice();
    pservs.sort((a, b) => ramOf(a) - ramOf(b));

    let upgraded = 0;
    for (const host of pservs) {
      const cur = ramOf(host);
      if (cur >= ramGoal) continue;

      const cost = ns.getPurchasedServerCost(ramGoal);
      await waitFor(cost, `upgrade ${host} ${cur}GB → ${ramGoal}GB`);

      ns.killall(host);
      const okDel = ns.deleteServer(host);
      if (!okDel) {
        ns.tprint(`Could not delete ${host}. (Still running something?)`);
        continue;
      }

      const res = ns.purchaseServer(host, ramGoal);
      if (!res) {
        ns.tprint(`Failed to repurchase ${host} at ${ramGoal}GB (after delete).`);
        return false;
      }

      upgraded++;
      ns.tprint(`Upgraded ${host}: ${cur}GB → ${ramGoal}GB (cost ${ns.formatNumber(cost)})`);
      if (redeployMode === "each") await redeploy();
    }

    if (redeployMode === "end") await redeploy();

    ns.tprint(
      `Tier complete. Target=${ramGoal}GB. Upgraded ${upgraded}. ` +
        `Purchased servers: ${ns.getPurchasedServers().length}/${limit}`
    );
    return true;
  };

  // Sanitize tier start
  if (!Number.isFinite(tierRam) || tierRam < 1) tierRam = 8;
  tierRam = Math.min(tierRam, maxRam);

  // Main: money-gated tier climb
  while (true) {
    await passOnce(tierRam);

    if (tierRam >= maxRam) {
      ns.tprint(`All done: reached max purchased-server RAM (${maxRam}GB).`);
      return;
    }

    const nextRam = Math.min(tierRam * 2, maxRam);
    const nextCost = ns.getPurchasedServerCost(nextRam);

    // Wait until we can afford at least ONE server at the next tier (plus reserve)
    await waitFor(nextCost, `next tier ${nextRam}GB`);
    ns.tprint(
      `Affordable next tier: ${nextRam}GB costs ${ns.formatNumber(nextCost)}. Moving up...`
    );

    tierRam = nextRam;
  }
}
