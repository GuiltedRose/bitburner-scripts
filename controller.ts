import { babyBatcher, computeDelays } from "lib/math-utils";
import { RCB_TUNING } from "lib/rcb-tuning";

type Mode = "GROW" | "WEAKEN" | "HACK";
type Threads = { h: number; g: number; w: number };

function allocCombined(
  freeRam: number,
  ram: { h: number; g: number; w: number },
  mode: Mode
): Threads {
  const weights =
    mode === "WEAKEN" ? { h: 0.00, g: 0.10, w: 0.90 } :
    mode === "GROW"   ? { h: 0.05, g: 0.70, w: 0.25 } :
                       { h: 0.60, g: 0.20, w: 0.20 };

  let h = weights.h > 0 ? Math.floor((freeRam * weights.h) / ram.h) : 0;
  let g = weights.g > 0 ? Math.floor((freeRam * weights.g) / ram.g) : 0;
  let w = weights.w > 0 ? Math.floor((freeRam * weights.w) / ram.w) : 0;

  const used = () => h * ram.h + g * ram.g + w * ram.w;

  const ensureOne = (cur: number, opRam: number) =>
    (cur > 0 ? cur : (freeRam >= opRam ? 1 : 0));

  if (weights.h > 0) h = ensureOne(h, ram.h);
  if (weights.g > 0) g = ensureOne(g, ram.g);
  if (weights.w > 0) w = ensureOne(w, ram.w);

  while (used() > freeRam) {
    const costH = h > 0 ? ram.h : -1;
    const costG = g > 0 ? ram.g : -1;
    const costW = w > 0 ? ram.w : -1;

    if (costH >= costG && costH >= costW && h > 0) h--;
    else if (costG >= costH && costG >= costW && g > 0) g--;
    else if (w > 0) w--;
    else break;
  }

  return { h, g, w };
}

function bucket(ms: number, stepMs: number) {
  return Math.round(ms / stepMs) * stepMs;
}

function pct(x: number) {
  return `${(x * 100).toFixed(1)}%`;
}

export async function main(ns: NS) {
  ns.disableLog("ALL");

  const spacer = RCB_TUNING.spacer;
  const tick = RCB_TUNING.tick;
  const delayBucketMs = RCB_TUNING.delayBucketMs;

  const lastTargetByHost = new Map<string, string>();
  const lastModeByHost = new Map<string, Mode>();
  const lastPlanKeyByHost = new Map<string, string>();

  // --- Telemetry throttle ---
  const LOG_EVERY_MS = 1000;
  let lastLog = 0;

  // Rolling-window accumulators (reset each LOG_EVERY_MS)
  let winPlannedH = 0, winPlannedG = 0, winPlannedW = 0; // fresh capacity plan
  let winLaunchH = 0,  winLaunchG = 0,  winLaunchW = 0;  // actual launches in window

  // One-time tuning sanity warnings
  let warnedTuning = false;

  while (true) {
    const bb = babyBatcher(ns);
    const target = bb.target;
    const mode: Mode = bb.recommendedOp;

    // Compute raw delays, then bucket them for stability
    const { dH, dW, dG } = computeDelays(ns, target, spacer);

    const bH = bucket(dH, delayBucketMs);
    const bW = bucket(dW, delayBucketMs);
    const bG = bucket(dG, delayBucketMs);

    const planKey = `H${bH}|W${bW}|G${bG}|S${spacer}`;

    // Fleet RAM totals (cheap, no ps())
    let fleetMax = 0;
    let fleetUsed = 0;

    // “Stranded” counters
    let skippedHosts = 0;         // h=g=w=0 after allocation
    let strandedFitHosts = 0;     // freeRam >= minOpRam but we still launch nothing (rare; bug signal)
    let unusableFreeRam = 0;      // free that is < minOpRam
    let totalFreeRam = 0;

    // Collision/thrash proxies (checked during log pass)
    let dupWorkersHosts = 0;      // any host running >1 of the same worker script
    let lateProxy = 0;            // abs(raw-bucket) > tick (H/W/G summed)

    // Quick “settings too tight” warning (one-time)
    if (!warnedTuning) {
      const tooTight =
        spacer < 2 * tick ||              // separation too small vs loop
        spacer < 2 * delayBucketMs ||     // bucket comparable to spacer
        delayBucketMs > spacer;           // nonsensical
      if (tooTight) {
        warnedTuning = true;
        ns.tprint(
          `[WARN] Tuning is very tight: spacer=${spacer} tick=${tick} bucket=${delayBucketMs}. ` +
          `Expect jitter to dominate and timing to smear.`
        );
      }
    }

    // Late-launch proxy (fast to compute, no ps())
    lateProxy =
      (Math.abs(dH - bH) > tick ? 1 : 0) +
      (Math.abs(dW - bW) > tick ? 1 : 0) +
      (Math.abs(dG - bG) > tick ? 1 : 0);

    const ramH = bb.scriptRam.hack1;
    const ramG = bb.scriptRam.grow1;
    const ramW = bb.scriptRam.weaken1;
    const minOpRam = Math.min(ramH, ramG, ramW);

    for (const c of bb.caps) {
      const host = c.host;

      // Fleet totals
      const mx = ns.getServerMaxRam(host);
      const us = ns.getServerUsedRam(host);
      fleetMax += mx;
      fleetUsed += us;

      const prevTarget = lastTargetByHost.get(host);
      const prevMode = lastModeByHost.get(host);
      const prevPlanKey = lastPlanKeyByHost.get(host);

      const changed =
        (prevTarget !== undefined && prevTarget !== target) ||
        (prevMode !== undefined && prevMode !== mode) ||
        (prevPlanKey !== undefined && prevPlanKey !== planKey);

      if (changed) {
        ns.scriptKill(bb.scripts.hack1, host);
        ns.scriptKill(bb.scripts.grow1, host);
        ns.scriptKill(bb.scripts.weaken1, host);
      }

      lastTargetByHost.set(host, target);
      lastModeByHost.set(host, mode);
      lastPlanKeyByHost.set(host, planKey);

      // Recompute free RAM after kills (caps are a snapshot)
      const freeRam = mx - ns.getServerUsedRam(host);

      // Fragmentation proxy
      const fr = Math.max(0, freeRam);
      totalFreeRam += fr;
      if (fr > 0 && fr < minOpRam) unusableFreeRam += fr;

      // ---- Planned capacity (fresh) ----
      // This is the "if host were empty, how many threads would we allocate?"
      {
        let { h: ph, g: pg, w: pw } = allocCombined(
          mx, // <= max ram (fresh)
          { h: ramH, g: ramG, w: ramW },
          mode
        );

        // Match controller greedy packing for planned capacity too
        const usedFresh = () => ph * ramH + pg * ramG + pw * ramW;
        let remainFresh = mx - usedFresh();

        const addFresh = (op: "H" | "G" | "W") => {
          if (op === "H" && remainFresh >= ramH) { ph++; remainFresh -= ramH; return true; }
          if (op === "G" && remainFresh >= ramG) { pg++; remainFresh -= ramG; return true; }
          if (op === "W" && remainFresh >= ramW) { pw++; remainFresh -= ramW; return true; }
          return false;
        };

        const primary: "H" | "G" | "W" =
          mode === "HACK" ? "H" :
          mode === "GROW" ? "G" : "W";

        while (
          addFresh(primary) ||
          addFresh("W") ||
          addFresh("G") ||
          addFresh("H")
        ) {}

        winPlannedH += ph;
        winPlannedG += pg;
        winPlannedW += pw;
      }

      // ---- Actual launch planning (uses FREE RAM) ----
      let { h, g, w } = allocCombined(
        freeRam,
        { h: ramH, g: ramG, w: ramW },
        mode
      );

      // ---- Greedy fill leftover RAM (safe speed-up) ----
      const usedLocal = () => h * ramH + g * ramG + w * ramW;
      let remain = freeRam - usedLocal();

      const addIfFits = (op: "H" | "G" | "W") => {
        if (op === "H" && remain >= ramH) { h++; remain -= ramH; return true; }
        if (op === "G" && remain >= ramG) { g++; remain -= ramG; return true; }
        if (op === "W" && remain >= ramW) { w++; remain -= ramW; return true; }
        return false;
      };

      const primary: "H" | "G" | "W" =
        mode === "HACK" ? "H" :
        mode === "GROW" ? "G" : "W";

      while (
        addIfFits(primary) ||
        addIfFits("W") ||
        addIfFits("G") ||
        addIfFits("H")
      ) { }

      if (h <= 0 && g <= 0 && w <= 0) {
        skippedHosts++;
        if (freeRam >= minOpRam) strandedFitHosts++;
        continue;
      }

      // ---- IMPORTANT FIXES ----
      // 1) Use BUCKETED delays for worker args (bH/bW/bG)
      // 2) isRunning() must match exec() args EXACTLY (include delay)
      if (h > 0 && !ns.isRunning(bb.scripts.hack1, host, target, bH, mode, planKey)) {
        const pid = ns.exec(bb.scripts.hack1, host, h, target, bH, mode, planKey);
        if (pid !== 0) winLaunchH += h;
      }
      if (w > 0 && !ns.isRunning(bb.scripts.weaken1, host, target, bW, mode, planKey)) {
        const pid = ns.exec(bb.scripts.weaken1, host, w, target, bW, mode, planKey);
        if (pid !== 0) winLaunchW += w;
      }
      if (g > 0 && !ns.isRunning(bb.scripts.grow1, host, target, bG, mode, planKey)) {
        const pid = ns.exec(bb.scripts.grow1, host, g, target, bG, mode, planKey);
        if (pid !== 0) winLaunchG += g;
      }
    }

    // --- Heavy checks + printing (throttled) ---
    const now = Date.now();
    if (now - lastLog >= LOG_EVERY_MS) {
      lastLog = now;

      // Duplicate worker detection (potential collision symptom)
      dupWorkersHosts = 0;
      for (const c of bb.caps) {
        const host = c.host;
        let hackCount = 0, growCount = 0, weakenCount = 0;

        for (const p of ns.ps(host)) {
          if (p.filename === bb.scripts.hack1) hackCount++;
          else if (p.filename === bb.scripts.grow1) growCount++;
          else if (p.filename === bb.scripts.weaken1) weakenCount++;
        }
        if (hackCount > 1 || growCount > 1 || weakenCount > 1) dupWorkersHosts++;
      }

      const util = fleetMax > 0 ? fleetUsed / fleetMax : 0;
      const fragShare = totalFreeRam > 0 ? (unusableFreeRam / totalFreeRam) : 0;

      // Target health
      const secOverMin = ns.getServerSecurityLevel(target) - ns.getServerMinSecurityLevel(target);
      const moneyRatio =
        ns.getServerMaxMoney(target) > 0
          ? ns.getServerMoneyAvailable(target) / ns.getServerMaxMoney(target)
          : 0;

      // Collision / warning heuristics
      const warnLines: string[] = [];
      if (dupWorkersHosts > 0) warnLines.push(`dupWorkersHosts=${dupWorkersHosts}`);
      if (lateProxy > 0) warnLines.push(`lateProxy=${lateProxy}`);
      if (strandedFitHosts > 0) warnLines.push(`strandedFitHosts=${strandedFitHosts}`);

      ns.clearLog();
      ns.print(`=== CONTROLLER DATA ===`);
      ns.print(`Target=${target}  Mode=${mode} tick=${tick} Plan=${planKey}`);
      ns.print(`PlannedCap H/G/W: ${winPlannedH}/${winPlannedG}/${winPlannedW} | Launched(last ${LOG_EVERY_MS}ms) H/G/W: ${winLaunchH}/${winLaunchG}/${winLaunchW}`);
      ns.print(`Fleet RAM used/max: ${fleetUsed.toFixed(1)}/${fleetMax.toFixed(1)} (${pct(util)}) | Frag(unusable/free): ${pct(fragShare)}`);
      ns.print(`SkippedHosts=${skippedHosts}  StrandedFitHosts=${strandedFitHosts}`);
      ns.print(`Target health: secOverMin=${secOverMin.toFixed(2)}  moneyRatio=${moneyRatio.toFixed(3)}`);

      if (warnLines.length) {
        ns.print(`!!! WARN: ${warnLines.join(" | ")}`);
        ns.tprint(`[WARN] ${warnLines.join(" | ")}  (target=${target} mode=${mode} plan=${planKey})`);
      }

      // Reset window accumulators after printing
      winPlannedH = winPlannedG = winPlannedW = 0;
      winLaunchH = winLaunchG = winLaunchW = 0;
    }

    await ns.asleep(tick);
  }
}
