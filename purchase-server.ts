export async function main(ns: NS) {
  const ram = 8;
  const prefix = String(ns.args[0] ?? "pserv-");

  const limit = ns.getPurchasedServerLimit();
  const cost = ns.getPurchasedServerCost(ram);

  let bought = 0;

  for (let i = 0; i < limit; i++) {
    const name = `${prefix}${i}`;

    // Skip if it already exists
    if (ns.serverExists(name)) continue;

    // Wait until we can afford it (or bail if you prefer)
    while (ns.getServerMoneyAvailable("home") < cost) {
      ns.print(
        `Waiting... need ${ns.formatNumber(cost)} for ${name} (8GB). Have ${ns.formatNumber(
          ns.getServerMoneyAvailable("home")
        )}`
      );
      await ns.sleep(1000);
    }

    const res = ns.purchaseServer(name, ram);
    if (res) {
      bought++;
      ns.tprint(`Bought ${res} (8GB) for ${ns.formatNumber(cost)}`);
    } else {
      ns.tprint(`Failed to buy ${name}.`);
      break;
    }
  }

  ns.tprint(`Done. Bought ${bought} server(s) at 8GB.`);
  ns.run("deploy.ts");
}