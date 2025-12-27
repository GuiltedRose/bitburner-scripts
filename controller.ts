import { babyBatcher, computeDelays } from "lib/math-utils";

type Mode = "GROW" | "WEAKEN" | "HACK";
type Threads = { h: number; g: number; w: number };

function allocCombined(
  freeRam: number,
  ram: { h: number; g: number; w: number },
  mode: Mode
): Threads {
  const weights =
    mode === "WEAKEN" ? { h: 0.00, g: 0.10, w: 0.90 } :
      mode === "GROW" ? { h: 0.05, g: 0.70, w: 0.25 } :
        { h: 0.60, g: 0.20, w: 0.20 };

  let h = weights.h > 0 ? Math.floor((freeRam * weights.h) / ram.h) : 0;
  let g = weights.g > 0 ? Math.floor((freeRam * weights.g) / ram.g) : 0;
  let w = weights.w > 0 ? Math.floor((freeRam * weights.w) / ram.w) : 0;

  const used = () => h * ram.h + g * ram.g + w * ram.w;

  const ensureOne = (cur: number, opRam: number) => (cur > 0 ? cur : (freeRam >= opRam ? 1 : 0));
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

export async function main(ns: NS) {
  ns.disableLog("sleep");
  ns.disableLog("asleep");
  ns.disableLog("exec");
  ns.disableLog("scan");
  ns.disableLog("getServerMaxRam");
  ns.disableLog("getServerUsedRam");

  const spacer = 200;
  const tick = 250;

  // --- JIT abort state (per host) ---
  const lastTargetByHost = new Map<string, string>();
  const lastModeByHost = new Map<string, Mode>();

  while (true) {
    const bb = babyBatcher(ns);
    const target = bb.target;
    const mode: Mode = bb.recommendedOp;

    const { dH, dW, dG } = computeDelays(ns, target, spacer);

    for (const c of bb.caps) {
      const host = c.host;
      const freeRam = c.freeRam;

      // --- Abort/reschedule if assumptions changed on this host ---
      const prevTarget = lastTargetByHost.get(host);
      const prevMode = lastModeByHost.get(host);

      const changed = (prevTarget !== undefined && prevTarget !== target) ||
        (prevMode !== undefined && prevMode !== mode);

      if (changed) {
        // Kill scheduled/queued work so the new plan can take over
        ns.scriptKill(bb.scripts.hack, host);
        ns.scriptKill(bb.scripts.grow, host);
        ns.scriptKill(bb.scripts.weaken, host);
      }

      // Update state AFTER the optional kill
      lastTargetByHost.set(host, target);
      lastModeByHost.set(host, mode);

      const { h, g, w } = allocCombined(
        freeRam,
        { h: bb.scriptRam.hack, g: bb.scriptRam.grow, w: bb.scriptRam.weaken },
        mode
      );

      if (h <= 0 && g <= 0 && w <= 0) continue;

      // Use (target, delay, mode) as the identity so mode changes force reschedule
      // Workers ignore args[2]; it's just an id/tag.
      if (h > 0 && !ns.isRunning(bb.scripts.hack, host, target, dH, mode)) {
        ns.exec(bb.scripts.hack, host, h, target, dH, mode);
      }
      if (w > 0 && !ns.isRunning(bb.scripts.weaken, host, target, dW, mode)) {
        ns.exec(bb.scripts.weaken, host, w, target, dW, mode);
      }
      if (g > 0 && !ns.isRunning(bb.scripts.grow, host, target, dG, mode)) {
        ns.exec(bb.scripts.grow, host, g, target, dG, mode);
      }
    }

    await ns.asleep(tick);
  }
}