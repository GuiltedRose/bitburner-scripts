# bitburner-scripts
JavaScript scripts for a game called BitBurner (I am bad with javascript so I am using this for practice)

# How to Use:
**This code project expects one thing; you use the library folder as intended.**

## Using Legacy Code:
The legacy scripts contained in the legacy folder are very basic, and will run most of the game. You can 100% the game like this, but it'll be super slow. To counteract this I created a batching system that I find to be extrememly efficent, and can run on a fresh game. Alongside the legacy code I highly recommend the hacknet automation script named `buy-hn.ts`. This script is probably not the most efficent hacknet scrpit out there, but it's way better than buying everything manually. I also made one to purchase servers for you, and both deploy scripts work with it. The main difference is, to use the legacy deployment script with it you need to add the folder name before the file, this is the only modification you need to do for any of my code this far.

## Using Batching Sequence:
**NOTE: This section is going to be very technical to explain why everything works, you can skip most of this if your goal is to just beat the game with a good script.**

**ALSO NOTE: This probably isn't covered by the discord. I am pretty sure this is a unique batching script, it's a Ractive Continuous Batching script.**

**FINAL NOTE: This section also expects you to have batching knowledge before reading further. [https://darktechnomancer.github.io/#timing-functions] use this link to understand the basics before moving further.**

### How the Math Works:
For finding our target server, all I ended up doing was copying over the code from our `legacy/payload.ts` script. This is important for the rest of our batching program to function.
```ts
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
```
Above is the code in question, the only difference between the payload and this utility fucntion are that this one affects all servers, but the payload only does this for servers that don't have any money in them such as personal servers you buy.

The next important section is how we deal with system memory for each server. This makes sure our batches are done in a way where we don't fail to execute due to RAM overload. It is also delt with automatically by the `controller.ts` program. The code is below this section, and it could probably be a tad more efficent, but for now it works.
```ts
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
```
All this does is get the exact ram needed to run each worker per batch, and calulates how many times a server can execute each script. It then returns that value for the `controller.ts` program to execute.

The next function relies on a custom type that is heavily commented, I did this so you can just look at it and understand what's going on behind the scenes. I also named it `Baby Batch` just because I thought it was funny, no other reason. This is the gigantic monster of a function that is the brain of our codebase:

```ts
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
```
Most of this is setting up our variables to other scripts, and stuff so that `controller.ts` doesn't need to touch them directly. Actually 90% of the code is completely done in this utility file which is why we can save most of our RAM and make this executable on the basic 8GB home system. There is one more important function that I don't think is worth explaining so I will meantion it briefly here. It's only job is to setup delays for the controller to use to insure nothing overlaps and wastes RAM usage. Just because we calculate RAM doesn't mean we don't utilize the entire RAM we have available per server, we definately do.
