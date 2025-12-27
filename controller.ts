import { babyBatcher, computeDelays } from "lib/math-utils";

type Mode = "GROW" | "WEAKEN" | "HACK";
type Threads = { h: number; g: number; w: number };

function allocCombined(
  freeRam: number,
  ram: { h: number; g: number; w: number },
  mode: Mode
): Threads {
  // Tune weights any time. These just decide RAM split per host.
  const weights =
    mode === "WEAKEN" ? { h: 0.00, g: 0.10, w: 0.90 } :
      mode === "GROW" ? { h: 0.05, g: 0.70, w: 0.25 } :
        { h: 0.60, g: 0.20, w: 0.20 };

  // Proportional allocation by RAM share
  let h = weights.h > 0 ? Math.floor((freeRam * weights.h) / ram.h) : 0;
  let g = weights.g > 0 ? Math.floor((freeRam * weights.g) / ram.g) : 0;
  let w = weights.w > 0 ? Math.floor((freeRam * weights.w) / ram.w) : 0;

  const used = () => h * ram.h + g * ram.g + w * ram.w;

  // Ensure at least 1 thread for any op with non-zero weight if we can afford it
  const ensureOne = (cur: number, opRam: number) => (cur > 0 ? cur : (freeRam >= opRam ? 1 : 0));
  if (weights.h > 0) h = ensureOne(h, ram.h);
  if (weights.g > 0) g = ensureOne(g, ram.g);
  if (weights.w > 0) w = ensureOne(w, ram.w);

  // Trim until it fits
  while (used() > freeRam) {
    // drop from the op that currently consumes the most RAM per thread (simple + stable)
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

export async function main(ns: NS) {
  ns.disableLog("sleep");
  ns.disableLog("asleep");
  ns.disableLog("exec");
  ns.disableLog("scan");
  ns.disableLog("getServerMaxRam");
  ns.disableLog("getServerUsedRam");

  const spacer = 200; // passed into computeDelays()
  const tick = 250;   // controller loop frequency

  while (true) {

    // math layer: pick target, compute caps, recommend op, etc.
    const bb = babyBatcher(ns);
    const target = bb.target;

    // delay math function
    const { dH, dW, dG } = computeDelays(ns, target, spacer);

    /* 
    (Optional) sanity: ensure bb.caps aligns with runners list
     If you don’t care, delete this block.
     const runnerSet = new Set(runners);
     for (const c of bb.caps) if (!runnerSet.has(c.host)) ns.tprint(`WARN: cap host not in runners: ${c.host}`);
    For each runner host: allocate combined H/G/W threads that fit ON THAT HOST */
    for (const c of bb.caps) {
      const host = c.host;
      const freeRam = c.freeRam;

      const { h, g, w } = allocCombined(
        freeRam,
        { h: bb.scriptRam.hack, g: bb.scriptRam.grow, w: bb.scriptRam.weaken },
        bb.recommendedOp
      );

      // If nothing fits, skip
      if (h <= 0 && g <= 0 && w <= 0) continue;

      // Start the three operations on the SAME host, but delayed so they align
      // NOTE: this requires workers to accept (target, delay)
      if (h > 0 && !ns.isRunning(bb.scripts.hack, host, target, dH)) {
        ns.exec(bb.scripts.hack, host, h, target, dH);
      }
      if (w > 0 && !ns.isRunning(bb.scripts.weaken, host, target, dW)) {
        ns.exec(bb.scripts.weaken, host, w, target, dW);
      }
      if (g > 0 && !ns.isRunning(bb.scripts.grow, host, target, dG)) {
        ns.exec(bb.scripts.grow, host, g, target, dG);
      }
    }

    await ns.asleep(tick);
  }
}