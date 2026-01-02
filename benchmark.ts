import { babyBatcher, computeDelays } from "lib/math-utils";
import { RCB_TUNING } from "lib/rcb-tuning";

type Mode = "GROW" | "WEAKEN" | "HACK";

function bucket(ms: number, stepMs: number) {
  return Math.round(ms / stepMs) * stepMs;
}

export async function main(ns: NS) {
  ns.disableLog("sleep");
  ns.disableLog("asleep");
  ns.disableLog("getServerUsedRam");
  ns.disableLog("getServerMaxRam");
  ns.disableLog("ps");
  ns.disableLog("scan");

  const SAMPLE_MS = Number(ns.args[0] ?? 1000);   // sample interval
  const WINDOW = Number(ns.args[1] ?? 60);        // rolling window samples
  const delayBucketMs = Number(ns.args[2] ?? RCB_TUNING.delayBucketMs);
  const spacer = Number(ns.args[3] ?? RCB_TUNING.spacer);
  const controllerTick = Number(ns.args[4] ?? RCB_TUNING.tick);


  const loopDt: number[] = [];
  const churn: number[] = [];
  const util: number[] = [];
  const frag: number[] = [];
  const lateLaunch: number[] = [];
  const planChanges: number[] = [];

  let lastSampleT = Date.now();
  let lastPlanKey = "";
  let lastTarget = "";
  let lastMode: Mode | "" = "";
  let lastProcSig = ""; // process signature for churn detection

  function push(arr: number[], v: number) {
    arr.push(v);
    if (arr.length > WINDOW) arr.shift();
  }
  function avg(arr: number[]) {
    return arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : 0;
  }
  function max(arr: number[]) {
    return arr.length ? Math.max(...arr) : 0;
  }
  function pct(n: number) {
    return `${(n * 100).toFixed(1)}%`;
  }

  // cheap-ish scan of running worker scripts on a single host: "home"
  // You can expand to all pservs if you want, but this is “perf-only” so we keep it light.
  function procSignature(): string {
    const procs = ns.ps("home");
    // Only care about your batch workers + controller
    const keep = procs
      .filter(p => /workers\/(hack|grow|weaken)\.ts$/.test(p.filename) || /controller\.ts$/.test(p.filename))
      .map(p => `${p.filename}(${p.args.join(",")})@${p.threads}`)
      .sort();
    return keep.join("|");
  }

  function fleetStats(hosts: string[]) {
    let totalMax = 0;
    let totalUsed = 0;

    // fragmentation proxy: sum of per-host free RAM that is < min(scriptRAM)
    // (free exists but cannot fit any worker thread)
    let unusable = 0;
    let totalFree = 0;

    // Estimate “min op ram” from your library snapshot
    const bb = babyBatcher(ns);
    const minOpRam = Math.min(bb.scriptRam.hack1, bb.scriptRam.grow1, bb.scriptRam.weaken1);

    for (const h of hosts) {
      const mx = ns.getServerMaxRam(h);
      const us = ns.getServerUsedRam(h);
      const fr = Math.max(0, mx - us);

      totalMax += mx;
      totalUsed += us;
      totalFree += fr;

      if (fr > 0 && fr < minOpRam) unusable += fr;
    }

    const util = totalMax > 0 ? totalUsed / totalMax : 0;
    const frag = totalFree > 0 ? unusable / totalFree : 0;

    return { util, frag, totalMax, totalUsed, totalFree };
  }

  while (true) {
    const now = Date.now();
    const dt = now - lastSampleT;
    lastSampleT = now;

    // controller timing health: how far off from ideal SAMPLE_MS were we?
    push(loopDt, dt);

    // Current batch plan snapshot
    const bb = babyBatcher(ns);
    const target = bb.target;
    const mode: Mode = bb.recommendedOp;

    const { dH, dW, dG } = computeDelays(ns, target, spacer);
    const bH = bucket(dH, delayBucketMs);
    const bW = bucket(dW, delayBucketMs);
    const bG = bucket(dG, delayBucketMs);
    const planKey = `H${bH}|W${bW}|G${bG}|S${spacer}`;

    // plan change rate (should be low when stable)
    const changed = planKey !== lastPlanKey || target !== lastTarget || mode !== lastMode;
    push(planChanges, changed ? 1 : 0);
    lastPlanKey = planKey;
    lastTarget = target;
    lastMode = mode;

    // churn proxy: process signature changes on home between samples
    const sig = procSignature();
    push(churn, sig === lastProcSig ? 0 : 1);
    lastProcSig = sig;

    // fleet utilization + fragmentation proxy
    const hosts = bb.caps.map(c => c.host);
    const fs = fleetStats(hosts);
    push(util, fs.util);
    push(frag, fs.frag);

    // “late launch” proxy:
    // if your controller tick is 250ms and your delay buckets are 25ms,
    // you should rarely see bucketed delays wobble more than one bucket when stable.
    // We score “late” as (abs(raw-bucket) > controllerTick).
    const late =
      (Math.abs(dH - bH) > controllerTick ? 1 : 0) +
      (Math.abs(dW - bW) > controllerTick ? 1 : 0) +
      (Math.abs(dG - bG) > controllerTick ? 1 : 0);
    push(lateLaunch, late);

    // target prep health (not money, just whether you’re sitting in a bad state)
    const secOverMin = ns.getServerSecurityLevel(target) - ns.getServerMinSecurityLevel(target);
    const moneyRatio =
      ns.getServerMaxMoney(target) > 0
        ? ns.getServerMoneyAvailable(target) / ns.getServerMaxMoney(target)
        : 0;

    // print a compact perf dashboard
    ns.clearLog();

    const dtAvg = avg(loopDt);
    const dtMax = max(loopDt);
    const jitter = dtAvg > 0 ? (dtMax - dtAvg) : 0;

    ns.print(`=== I WAS OVER ON THE BENCH ===`);
    ns.print(`Target=${target}  Mode=${mode} Tick=${controllerTick} Plan=${planKey}`);
    ns.print(
      `Loop dt avg/max: ${dtAvg.toFixed(0)}ms / ${dtMax.toFixed(0)}ms  (jitter ~${jitter.toFixed(0)}ms)`
    );
    ns.print(
      `Plan changes (last ${WINDOW}): ${(avg(planChanges) * 100).toFixed(1)}% of samples`
    );
    ns.print(
      `Process churn (home) (last ${WINDOW}): ${(avg(churn) * 100).toFixed(1)}% of samples`
    );
    ns.print(
      `Fleet util avg: ${pct(avg(util))} | Frag avg: ${pct(avg(frag))} (free<minOpRam share)`
    );
    ns.print(
      `Late-launch proxy avg: ${avg(lateLaunch).toFixed(2)} (0 is best)`
    );
    ns.print(
      `Target health: secOverMin=${secOverMin.toFixed(2)}  moneyRatio=${moneyRatio.toFixed(3)}`
    );

    await ns.sleep(SAMPLE_MS);
  }
}
