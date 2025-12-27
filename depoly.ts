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
  const hosts = allHosts(ns).filter(h => h !== "home");
  const workerFiles: string[] = ["workers/hack.ts", "workers/grow.ts", "workers/weaken.ts"];

  for (const host of hosts) {
    if (!tryNuke(ns, host)) continue;
    await ns.scp(workerFiles, host);
  }
}
