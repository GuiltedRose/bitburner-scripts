import { allHosts } from "lib/utils";

type Sample = {
  t: number; // ms since start
  money: number;
  moneyRatio: number;
  secDelta: number;

  fleetMaxRam: number;
  fleetUsedRam: number;
  util: number;

  thHack: number;
  thGrow: number;
  thWeaken: number;

  modeHack: number;
  modeGrow: number;
  modeWeaken: number;

  activeTargets: number;
  observedTarget: string;
};

function mean(xs: number[]): number {
  if (xs.length === 0) return 0;
  let s = 0;
  for (const x of xs) s += x;
  return s / xs.length;
}
function min(xs: number[]): number {
  if (xs.length === 0) return 0;
  let m = xs[0];
  for (const x of xs) if (x < m) m = x;
  return m;
}
function max(xs: number[]): number {
  if (xs.length === 0) return 0;
  let m = xs[0];
  for (const x of xs) if (x > m) m = x;
  return m;
}

function fmtETA(seconds: number): string {
  if (!isFinite(seconds) || seconds < 0) return "N/A";
  const s = Math.floor(seconds % 60);
  const m = Math.floor((seconds / 60) % 60);
  const h = Math.floor(seconds / 3600);
  if (h > 0) return `${h}h ${m}m ${s}s`;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
}

export async function main(ns: NS) {
  ns.disableLog("sleep");
  ns.disableLog("asleep");
  ns.disableLog("scan");
  ns.disableLog("ps");
  ns.disableLog("getServerUsedRam");
  ns.disableLog("getServerMaxRam");

  // Args:
  // run tools/bench.js [durationMs=600000] [sampleMs=1000] [pinTarget=""] [liveEveryMs=30000]
  const durationMs = Number(ns.args[0] ?? 10 * 60_000); // default 10 min
  const sampleMs = Number(ns.args[1] ?? 1000);          // default 1 sec
  const pinTarget = String(ns.args[2] ?? "");           // optional
  const liveEveryMs = Number(ns.args[3] ?? 30_000);     // print live line every 30s (0 disables)

  const workers = {
    hack: "workers/hack.ts",
    grow: "workers/grow.ts",
    weaken: "workers/weaken.ts",
  };

  const hosts = allHosts(ns)
    .filter(h => ns.hasRootAccess(h))
    .filter(h => ns.getServerMaxRam(h) > 0);

  const t0 = Date.now();
  const endAt = t0 + durationMs;

  const startMoney = ns.getPlayer().money;

  const samples: Sample[] = [];
  let nextLive = t0 + liveEveryMs;

  function inferTargetFromProcesses(): string | null {
    const counts = new Map<string, number>();
    for (const h of hosts) {
      for (const p of ns.ps(h)) {
        if (p.filename !== workers.hack && p.filename !== workers.grow && p.filename !== workers.weaken) continue;
        const tgt = String(p.args[0] ?? "");
        if (!tgt) continue;
        counts.set(tgt, (counts.get(tgt) ?? 0) + p.threads);
      }
    }
    let best: string | null = null;
    let bestThreads = 0;
    for (const [tgt, th] of counts) {
      if (th > bestThreads) { bestThreads = th; best = tgt; }
    }
    return best;
  }

  // Sampling loop
  while (Date.now() < endAt) {
    const now = Date.now();
    const t = now - t0;

    // Fleet RAM + process inspection
    let fleetMaxRam = 0;
    let fleetUsedRam = 0;

    let thHack = 0, thGrow = 0, thWeaken = 0;
    let modeHack = 0, modeGrow = 0, modeWeaken = 0;

    const activeTargetsSet = new Set<string>();

    for (const h of hosts) {
      const maxRam = ns.getServerMaxRam(h);
      const usedRam = ns.getServerUsedRam(h);
      fleetMaxRam += maxRam;
      fleetUsedRam += usedRam;

      for (const p of ns.ps(h)) {
        const isHack = p.filename === workers.hack;
        const isGrow = p.filename === workers.grow;
        const isWeak = p.filename === workers.weaken;
        if (!isHack && !isGrow && !isWeak) continue;

        const tgt = String(p.args[0] ?? "");
        if (tgt) activeTargetsSet.add(tgt);

        // Your exec signature: (target, delay, mode) so args[2] is the mode tag.
        const m = String(p.args[2] ?? "");

        if (isHack) thHack += p.threads;
        if (isGrow) thGrow += p.threads;
        if (isWeak) thWeaken += p.threads;

        if (m === "HACK") modeHack += p.threads;
        else if (m === "GROW") modeGrow += p.threads;
        else if (m === "WEAKEN") modeWeaken += p.threads;
      }
    }

    const util = fleetMaxRam > 0 ? fleetUsedRam / fleetMaxRam : 0;

    const observedTarget = pinTarget || inferTargetFromProcesses() || "n00dles";

    const moneyAvail = ns.getServerMoneyAvailable(observedTarget);
    const moneyMax = ns.getServerMaxMoney(observedTarget);
    const sec = ns.getServerSecurityLevel(observedTarget);
    const secMin = ns.getServerMinSecurityLevel(observedTarget);

    const moneyRatio = moneyMax > 0 ? moneyAvail / moneyMax : 0;
    const secDelta = Math.max(0, sec - secMin);

    const s: Sample = {
      t,
      money: ns.getPlayer().money,
      moneyRatio,
      secDelta,
      fleetMaxRam,
      fleetUsedRam,
      util,
      thHack, thGrow, thWeaken,
      modeHack, modeGrow, modeWeaken,
      activeTargets: activeTargetsSet.size,
      observedTarget,
    };
    samples.push(s);

    // Live status line (optional)
    if (liveEveryMs > 0 && now >= nextLive) {
      const elapsedSec = t / 1000;
      const moneyPerSec = (s.money - startMoney) / Math.max(1e-9, elapsedSec);

      ns.tprint(
        `[BENCH ${Math.round(elapsedSec)}s] target=${observedTarget} ` +
        `$/s=${moneyPerSec.toFixed(2)} util=${(util * 100).toFixed(1)}% ` +
        `moneyRatio=${moneyRatio.toFixed(3)} secΔ=${secDelta.toFixed(2)} ` +
        `modeTh(H/G/W)=${modeHack}/${modeGrow}/${modeWeaken} targets=${s.activeTargets}`
      );
      nextLive = now + liveEveryMs;
    }

    await ns.asleep(sampleMs);
  }

  // ---- Summary ----
  const endMoney = ns.getPlayer().money;
  const elapsedSec = (Date.now() - t0) / 1000;
  const moneyPerSec = (endMoney - startMoney) / Math.max(1e-9, elapsedSec);

  const moneyRatios = samples.map(s => s.moneyRatio);
  const secDeltas = samples.map(s => s.secDelta);
  const utils = samples.map(s => s.util);
  const activeTargets = samples.map(s => s.activeTargets);

  const productiveCount = samples.filter(s => s.moneyRatio >= 0.90 && s.secDelta <= 3).length;
  const productivePct = productiveCount / Math.max(1, samples.length);

  // Mode distribution by threads (averaged)
  const avgModeH = mean(samples.map(s => s.modeHack));
  const avgModeG = mean(samples.map(s => s.modeGrow));
  const avgModeW = mean(samples.map(s => s.modeWeaken));

  // Most common observed target (by samples)
  const targetCounts = new Map<string, number>();
  for (const s of samples) targetCounts.set(s.observedTarget, (targetCounts.get(s.observedTarget) ?? 0) + 1);
  let dominantTarget = "n00dles";
  let dominantCount = 0;
  for (const [tgt, ct] of targetCounts) {
    if (ct > dominantCount) { dominantCount = ct; dominantTarget = tgt; }
  }

  // ---- Effectiveness / ETA ----
  const avgUsedRam = mean(samples.map(s => s.fleetUsedRam));
  const avgMaxRam = mean(samples.map(s => s.fleetMaxRam));

  const dollarsPerGbSecond_used = avgUsedRam > 0 ? moneyPerSec / avgUsedRam : 0;
  const dollarsPerGbSecond_max = avgMaxRam > 0 ? moneyPerSec / avgMaxRam : 0;

  const hackDominance = (() => {
    const denom = avgModeH + avgModeG + avgModeW;
    return denom > 0 ? (avgModeH / denom) : 0;
  })();

  // Fixed goal: 5B
  const goal = 5_000_000_000;
  const remaining = Math.max(0, goal - endMoney);
  const etaSec = moneyPerSec > 0 ? (remaining / moneyPerSec) : Infinity;

  ns.tprint("=== RCB Benchmark Summary (in-memory) ===");
  ns.tprint(`Hack dominance (avg mode threads): ${(hackDominance * 100).toFixed(1)}%`);
  ns.tprint(`Duration: ${elapsedSec.toFixed(1)}s | Samples: ${samples.length} | SampleEvery: ${sampleMs}ms`);
  ns.tprint(`Dominant target: ${dominantTarget}${pinTarget ? " (pinned)" : ""}`);
  ns.tprint(`Money gained: ${(endMoney - startMoney).toFixed(0)} | Money/sec: ${moneyPerSec.toFixed(2)}`);
  ns.tprint(`MoneyRatio avg/min: ${mean(moneyRatios).toFixed(3)} / ${min(moneyRatios).toFixed(3)}`);
  ns.tprint(`SecΔ avg/max: ${mean(secDeltas).toFixed(2)} / ${max(secDeltas).toFixed(2)}`);
  ns.tprint(`Fleet util avg/min: ${(mean(utils) * 100).toFixed(1)}% / ${(min(utils) * 100).toFixed(1)}%`);
  ns.tprint(`Mode threads avg (H/G/W): ${avgModeH.toFixed(1)} / ${avgModeG.toFixed(1)} / ${avgModeW.toFixed(1)}`);
  ns.tprint(`Productive uptime (moneyRatio>=0.90 & secΔ<=3): ${(productivePct * 100).toFixed(1)}%`);
  ns.tprint(`Active targets avg/max: ${mean(activeTargets).toFixed(2)} / ${max(activeTargets).toFixed(0)}`);
  ns.tprint(`$/ (GB*s) using usedRam: ${dollarsPerGbSecond_used.toFixed(2)}`);
  ns.tprint(`$/ (GB*s) using maxRam : ${dollarsPerGbSecond_max.toFixed(2)}`);

  // Goal / ETA
  ns.tprint(`Goal: ${goal.toFixed(0)} | Current: ${endMoney.toFixed(0)} | Remaining: ${remaining.toFixed(0)} | ETA: ${fmtETA(etaSec)}`);
}
