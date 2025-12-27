export function allHosts(ns: NS, start = "home"): string[] {
  const seen = new Set<string>([start]);
  const q: string[] = [start];

  while (q.length) {
    const cur = q.shift()!;
    for (const nxt of ns.scan(cur)) {
      if (seen.has(nxt)) continue;
      seen.add(nxt);
      q.push(nxt);
    }
  }
  return [...seen];
}