import { allHosts } from "lib/utils";

function tryNuke(ns: NS, host: string): boolean {
  if (ns.hasRootAccess(host)) return true;

  let opened = 0;
  const required = ns.getServerNumPortsRequired(host);

  if (ns.fileExists("BruteSSH.exe", "home")) { ns.brutessh(host); opened++; }
  if (ns.fileExists("FTPCrack.exe", "home")) { ns.ftpcrack(host); opened++; }
  if (ns.fileExists("relaySMTP.exe", "home")) { ns.relaysmtp(host); opened++; }
  if (ns.fileExists("HTTPWorm.exe", "home")) { ns.httpworm(host); opened++; }
  if (ns.fileExists("SQLInject.exe", "home")) { ns.sqlinject(host); opened++; }

  if (opened >= required) {
    ns.nuke(host);
    return true;
  }
  return false;
}

export async function main(ns: NS) {
  const payload = "legacy/payload.ts";
  const payloadRam = ns.getScriptRam(payload);

  const hosts = allHosts(ns).filter(h => h !== "home");

  for (const host of hosts) {
    if (!tryNuke(ns, host)) continue;
    if (ns.getServerMaxRam(host) < payloadRam) continue;

    const desiredThreads = Math.floor(ns.getServerMaxRam(host) / payloadRam);
    if (desiredThreads <= 0) continue;

    const running = ns.getRunningScript(payload, host, host);
    if (running && running.threads === desiredThreads) continue;

    // SCP payload + its imported libs
    await ns.scp([payload, "lib/utils.ts"], host);

    if (running) ns.kill(payload, host, host);
    ns.exec(payload, host, desiredThreads, host);
  }
}
