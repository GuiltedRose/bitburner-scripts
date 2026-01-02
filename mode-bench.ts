import { babyBatcher } from "lib/math-utils";
import { RCB_TUNING } from "lib/rcb-tuning";

type Mode = "GROW" | "WEAKEN" | "HACK";

function fmtSec(sec: number) {
  if (!Number.isFinite(sec)) return "∞";
  if (sec < 60) return `${sec.toFixed(1)}s`;
  return `${(sec / 60).toFixed(2)}m`;
}
function avg(xs: number[]) { return xs.length ? xs.reduce((a,b)=>a+b,0)/xs.length : 0; }

function estimateNextModeETA(
  mode0: Mode,
  moneyRatio: number,
  secDelta: number,
  dMoneyRatio: number,
  dSecDelta: number,
  moneyFloor: number,
  slack: number,
  hardSlack: number
) {
  const wouldModeFrom = (mr: number, sd: number): Mode => {
    if (sd > hardSlack) return "WEAKEN";
    if (mr < moneyFloor) return "GROW";
    if (sd > slack) return "WEAKEN";
    return "HACK";
  };

  const timeToCross = (cur: number, slope: number, targetVal: number, dir: "up" | "down") => {
    if (dir === "up") {
      if (cur >= targetVal) return 0;
      if (slope <= 0) return Infinity;
      return (targetVal - cur) / slope;
    } else {
      if (cur <= targetVal) return 0;
      if (slope >= 0) return Infinity;
      return (targetVal - cur) / slope;
    }
  };

  let etaSec = Infinity;
  let nextMode: Mode = mode0;
  let reason = "unknown";

  if (mode0 === "GROW") {
    const tMoney = timeToCross(moneyRatio, dMoneyRatio, moneyFloor, "up");
    const sdAt = Number.isFinite(tMoney) ? (secDelta + dSecDelta * tMoney) : secDelta;
    nextMode = wouldModeFrom(moneyFloor, sdAt);
    etaSec = tMoney;
    reason = `moneyRatio -> ${moneyFloor.toFixed(2)} (secΔ@flip≈${sdAt.toFixed(2)})`;
  } else if (mode0 === "WEAKEN") {
    const tSec = timeToCross(secDelta, dSecDelta, slack, "down");
    const mrAt = Number.isFinite(tSec) ? (moneyRatio + dMoneyRatio * tSec) : moneyRatio;
    nextMode = wouldModeFrom(mrAt, slack);
    etaSec = tSec;
    reason = `secΔ -> ${slack.toFixed(2)} (moneyRatio@flip≈${mrAt.toFixed(3)})`;
  } else {
    const tMoneyDown = timeToCross(moneyRatio, dMoneyRatio, moneyFloor, "down");
    const tSecUp = timeToCross(secDelta, dSecDelta, slack, "up");
    const tHardUp = timeToCross(secDelta, dSecDelta, hardSlack, "up");

    etaSec = Math.min(tMoneyDown, tSecUp, tHardUp);

    const mrAt = Number.isFinite(etaSec) ? (moneyRatio + dMoneyRatio * etaSec) : moneyRatio;
    const sdAt = Number.isFinite(etaSec) ? (secDelta + dSecDelta * etaSec) : secDelta;
    nextMode = wouldModeFrom(mrAt, sdAt);

    if (etaSec === tMoneyDown) reason = `moneyRatio -> ${moneyFloor.toFixed(2)} (down)`;
    else if (etaSec === tHardUp) reason = `secΔ -> ${hardSlack.toFixed(2)} (up)`;
    else reason = `secΔ -> ${slack.toFixed(2)} (up)`;
  }

  return { etaSec, nextMode, reason };
}

export async function main(ns: NS) {
  ns.disableLog("ALL");

  // 0: etaEveryMs (how often to start a new measurement) default 5000
  // 1: windowMs (duration of measurement window) default 600000
  // 2: samples (number of samples inside window) default 11
  // 3: rollN (rolling points) default 60
  const etaEveryMs = Number(ns.args[0] ?? 5000);
  const windowMs = Number(ns.args[1] ?? 600000);
  const samplesReq = Math.max(2, Number(ns.args[2] ?? 11));
  const rollN = Math.max(10, Number(ns.args[3] ?? 60));

  const tick = RCB_TUNING.tick;

  // Keep aligned with babyBatcher (or move into RCB_TUNING later)
  const moneyFloor = 0.90;
  const slack = 3;
  const hardSlack = 5;

  // Clamp samples so we don't sample faster than tick
  const minStepMs = Math.max(1, tick);
  const maxSamples = Math.floor(windowMs / minStepMs) + 1;
  const samples = Math.min(samplesReq, maxSamples);

  // Rolling stats
  const dts: number[] = [];
  const etas: number[] = [];
  let noProgress = 0;
  let etaRuns = 0;

  // Latest computed ETA info (shown even while measuring next one)
  let lastEtaSec = Infinity;
  let lastNextMode: Mode = "GROW";
  let lastReason = "warming up";
  let lastSlope = { dMoney: 0, dSec: 0, dt: 0 };

  // Non-blocking sampler state
  let measuring = false;
  let measureStartAt = 0;
  let nextSampleAt = 0;
  let sampleIdx = 0;

  let anchorTarget = "";
  let anchorMode: Mode = "GROW";
  let first: ReturnType<typeof babyBatcher> | null = null;
  let last: ReturnType<typeof babyBatcher> | null = null;

  let lastKick = 0;

  while (true) {
    const loopStart = Date.now();

    const bbNow = babyBatcher(ns);

    // Kick off a new measurement window periodically (if not already measuring)
    const now = Date.now();
    if (!measuring && (now - lastKick >= etaEveryMs)) {
      lastKick = now;

      measuring = true;
      measureStartAt = now;
      sampleIdx = 0;

      anchorTarget = bbNow.target;
      anchorMode = bbNow.recommendedOp;

      first = bbNow;
      last = bbNow;

      nextSampleAt = now + Math.floor(windowMs / (samples - 1)); // schedule sample #1
      sampleIdx = 1;

      lastReason = `measuring (${0}/${samples})`;
    }

    // If measuring, take samples when their scheduled time arrives
    if (measuring && now >= nextSampleAt && first && last) {
      const bb = babyBatcher(ns);

      // Abort if target changed mid-window
      if (bb.target !== anchorTarget) {
        measuring = false;
        lastEtaSec = Infinity;
        lastReason = `aborted: target changed (${anchorTarget} -> ${bb.target})`;
      } else {
        last = bb;

        if (sampleIdx >= samples - 1) {
          // Finalize measurement
          const dt = Math.max(0.001, (now - measureStartAt) / 1000);
          const dMoney = (last.moneyRatio - first.moneyRatio) / dt;
          const dSec = (last.secDelta - first.secDelta) / dt;

          lastSlope = { dMoney, dSec, dt };

          const eps = 1e-12;
          const slopeDead = Math.abs(dMoney) < eps && Math.abs(dSec) < eps;
          if (slopeDead) noProgress++;

          const eta = estimateNextModeETA(
            anchorMode,
            last.moneyRatio,
            last.secDelta,
            dMoney,
            dSec,
            moneyFloor,
            slack,
            hardSlack
          );

          lastEtaSec = eta.etaSec;
          lastNextMode = eta.nextMode;
          lastReason = slopeDead ? `no measurable progress (dt=${dt.toFixed(0)}s)` : eta.reason;

          etaRuns++;
          if (Number.isFinite(lastEtaSec)) {
            etas.push(lastEtaSec);
            while (etas.length > rollN) etas.shift();
          }

          measuring = false;
        } else {
          // schedule next sample
          sampleIdx++;
          const stepMs = Math.floor(windowMs / (samples - 1));
          nextSampleAt = measureStartAt + stepMs * sampleIdx;
          lastReason = `measuring (${sampleIdx}/${samples})`;
        }
      }
    }

    // --- Panel print (ALWAYS prints immediately) ---
    const dtMs = Date.now() - loopStart;
    dts.push(dtMs);
    while (dts.length > rollN) dts.shift();

    const dtAvg = avg(dts);
    const dtMax = dts.length ? Math.max(...dts) : 0;
    const jitter = Math.max(0, dtMax - dtAvg);

    ns.clearLog();
    ns.print(`=== MODE ETA BENCH ===`);
    ns.print(`Target=${bbNow.target}  Mode=${bbNow.recommendedOp}  Tick=${tick}`);
    ns.print(`ETA config: window=${(windowMs/1000).toFixed(0)}s samples=${samples} refresh=${(etaEveryMs/1000).toFixed(1)}s`);
    ns.print(`Loop dt avg/max: ${dtAvg.toFixed(0)}ms / ${dtMax.toFixed(0)}ms (jitter ~${jitter.toFixed(0)}ms)`);

    if (etas.length) {
      ns.print(`ETA(avg/min/max last ${etas.length}): ${fmtSec(avg(etas))} / ${fmtSec(Math.min(...etas))} / ${fmtSec(Math.max(...etas))}`);
    } else {
      ns.print(`ETA(avg/min/max): (no finite samples yet)`);
    }

    ns.print(`No-progress windows: ${(etaRuns ? (noProgress/etaRuns*100) : 0).toFixed(1)}%  runs=${etaRuns}`);
    ns.print(`Target health: secOverMin=${bbNow.secDelta.toFixed(2)}  moneyRatio=${bbNow.moneyRatio.toFixed(3)}`);

    ns.print(`Last slope: dMoneyRatio=${lastSlope.dMoney.toExponential(3)}/s  dSecΔ=${lastSlope.dSec.toExponential(3)}/s  (dt=${lastSlope.dt.toFixed(1)}s)`);
    if (measuring) {
      ns.print(`ETA: warming up... ${lastReason}`);
    } else {
      ns.print(`ETA to next mode (${anchorMode} -> ${lastNextMode}): ${fmtSec(lastEtaSec)}  via ${lastReason}`);
    }

    await ns.asleep(tick);
  }
}
