export async function main(ns: NS) {
  const target = ns.args[0] as string;
  const delay = Number(ns.args[1] ?? 0);
  if (delay > 0) await ns.asleep(delay);
  await ns.hack(target);
}