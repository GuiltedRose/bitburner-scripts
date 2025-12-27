import { allHosts } from "lib/utils"

export function findTarget(ns: NS) {
  const hosts: string[] = allHosts(ns).filter(h => h !== "home")
    .filter(h => ns.hasRootAccess(h))

  let best: string = "n00dles";
  let bestMoney: number = 0;
  const hackLvl: number = ns.getHackingLevel();

  for (const cur of hosts) {
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

export function myRamUsage(ns: NS) {
  const hRam: number = ns.getScriptRam("workers/hack.ts");
  const gRam: number = ns.getScriptRam("workers/grow.ts");
  const wRam: number = ns.getScriptRam("workers/weaken.ts");

  const hosts: string[] = allHosts(ns)
    .filter(h => h !== "home")
    .filter(h => ns.hasRootAccess(h))
    .filter(h => ns.getServerMaxRam(h) > 0);

  const caps: { host: string; freeRam: number; h: number; g: number; w: number }[] = [];

  for (const host of hosts) {
    const freeRam = ns.getServerMaxRam(host) - ns.getServerUsedRam(host);
    caps.push({
      host,
      freeRam,
      h: Math.floor(freeRam / hRam),
      g: Math.floor(freeRam / gRam),
      w: Math.floor(freeRam / wRam),
    });
  }

  return caps;
}

type BabyBatch = {
  target: string;

  // scripts + their ram costs (so controller doesn't re-query)
  scripts: { hack: string; grow: string; weaken: string };
  scriptRam: { hack: number; grow: number; weaken: number };

  // runner capacity map (per host)
  caps: { host: string; freeRam: number; h: number; g: number; w: number }[];

  // target state snapshot
  money: number;
  moneyMax: number;
  sec: number;
  secMin: number;

  // simple derived facts
  moneyRatio: number;
  secDelta: number;

  // "what the target needs most right now" (controller can ignore/override)
  recommendedOp: "GROW" | "WEAKEN" | "HACK";

  // fleet totals if you go “all-in” on one op this tick
  totals: { h: number; g: number; w: number };

  // if you want “no-split” jobs, these are the biggest single-host thread counts available
  singleHostMax: { h: number; g: number; w: number; hostH?: string; hostG?: string; hostW?: string };
};

export function babyBatcher(ns: NS): BabyBatch {
  const target = findTarget(ns);
  const caps = myRamUsage(ns);

  const hack = "workers/hack.ts";
  const grow = "workers/grow.ts";
  const weaken = "workers/weaken.ts";

  const hRam = ns.getScriptRam(hack);
  const gRam = ns.getScriptRam(grow);
  const wRam = ns.getScriptRam(weaken);

  // snapshot target state
  const money = ns.getServerMoneyAvailable(target);
  const moneyMax = ns.getServerMaxMoney(target);
  const sec = ns.getServerSecurityLevel(target);
  const secMin = ns.getServerMinSecurityLevel(target);

  const moneyRatio = moneyMax > 0 ? money / moneyMax : 0;
  const secDelta = Math.max(0, sec - secMin);

  // simple "needs" heuristics (controller can tune/override)
  const moneyFloor = 0.90; // grow until 90%+
  const slack = 3;         // keep security within min+3 most of the time
  const hardSlack = 5;     // if above min+5, prioritize weaken

  let recommendedOp: BabyBatch["recommendedOp"];
  if (secDelta > hardSlack) recommendedOp = "WEAKEN";
  else if (moneyRatio < moneyFloor) recommendedOp = "GROW";
  else if (secDelta > slack) recommendedOp = "WEAKEN";
  else recommendedOp = "HACK";

  // totals across fleet
  const totals = caps.reduce(
    (acc, c) => {
      acc.h += c.h;
      acc.g += c.g;
      acc.w += c.w;
      return acc;
    },
    { h: 0, g: 0, w: 0 }
  );

  // biggest single-host capacity (for your "don't split jobs" rule if desired)
  let bestH = 0, bestG = 0, bestW = 0;
  let hostH: string | undefined, hostG: string | undefined, hostW: string | undefined;

  for (const c of caps) {
    if (c.h > bestH) { bestH = c.h; hostH = c.host; }
    if (c.g > bestG) { bestG = c.g; hostG = c.host; }
    if (c.w > bestW) { bestW = c.w; hostW = c.host; }
  }

  return {
    target,
    scripts: { hack, grow, weaken },
    scriptRam: { hack: hRam, grow: gRam, weaken: wRam },
    caps,

    money,
    moneyMax,
    sec,
    secMin,

    moneyRatio,
    secDelta,

    recommendedOp,
    totals,
    singleHostMax: { h: bestH, g: bestG, w: bestW, hostH, hostG, hostW },
  };
}

export function computeDelays(ns: NS, target: string, spacer = 200) {
  const tH = ns.getHackTime(target);
  const tW = ns.getWeakenTime(target);
  const tG = ns.getGrowTime(target);

  // Choose an anchor "finish time" for the first job.
  // Using weaken time is common because it's the longest.
  const T = tW;

  // Finish order: H then W then G (simple starter)
  const dH = Math.max(0, T - tH);
  const dW = Math.max(0, (T + spacer) - tW);
  const dG = Math.max(0, (T + 2 * spacer) - tG);

  return { dH, dW, dG, spacer, T, tH, tW, tG };
}

