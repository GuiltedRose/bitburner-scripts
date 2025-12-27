/*   ---   ===   Hacking Contracts   ===  ---  */
export function largestPrimeFactor(n: number): number {
  let x = Math.floor(n);
  let largest = 1;

  // factor out 2s
  while (x % 2 === 0) {
    largest = 2;
    x = Math.floor(x / 2);
  }

  // odd factors
  for (let f = 3; f * f <= x; f += 2) {
    while (x % f === 0) {
      largest = f;
      x = Math.floor(x / f);
    }
  }

  // whatever is left is prime (if > 1)
  if (x > 1) largest = x;

  return largest;
}


export function uniquePathsGridII(grid: number[][]): number {
  const m = grid.length;
  const n = grid[0].length;

  // dp[j] = ways to reach current cell in column j for current row
  const dp = Array(n).fill(0);
  dp[0] = grid[0][0] === 0 ? 1 : 0;

  for (let i = 0; i < m; i++) {
    for (let j = 0; j < n; j++) {
      if (grid[i][j] === 1) {
        dp[j] = 0; // obstacle blocks all paths through this cell
      } else if (j > 0) {
        dp[j] += dp[j - 1]; // from left + from above (already in dp[j])
      }
    }
  }
  return dp[n - 1];
}

export function mergeOverlappingIntervals(intervals: number[][]): number[][] {
  if (intervals.length === 0) return [];

  // sort by start, then end
  intervals = intervals
    .map(x => [x[0], x[1]]) // copy
    .sort((a, b) => (a[0] - b[0]) || (a[1] - b[1]));

  const merged: number[][] = [];
  let [curS, curE] = intervals[0];

  for (let i = 1; i < intervals.length; i++) {
    const [s, e] = intervals[i];
    if (s <= curE) {
      if (e > curE) curE = e;
    } else {
      merged.push([curS, curE]);
      curS = s; curE = e;
    }
  }

  merged.push([curS, curE]);
  return merged;
}

export function minJumpsGameII(arr: number[]): number {
  const n = arr.length;
  if (n <= 1) return 0;

  // If you can't move at all from the start
  if (arr[0] === 0) return 0;

  let jumps = 0;
  let curEnd = 0;
  let farthest = 0;

  for (let i = 0; i < n - 1; i++) {
    farthest = Math.max(farthest, i + arr[i]);

    // If we're stuck (can't progress beyond i)
    if (farthest <= i) return 0;

    // end of current jump range -> take a jump
    if (i === curEnd) {
      jumps++;
      curEnd = farthest;

      if (curEnd >= n - 1) return jumps;
    }
  }

  return curEnd >= n - 1 ? jumps : 0;
}

export function generateIPAddresses(s: string): string[] {
  const res: string[] = [];
  const n = s.length;

  function okOctet(str: string): boolean {
    if (str.length === 0 || str.length > 3) return false;
    if (str.length > 1 && str[0] === "0") return false;
    const v = Number(str);
    return v >= 0 && v <= 255;
  }

  // Try all split positions i,j,k for 4 parts:
  // [0:i), [i:j), [j:k), [k:n)
  for (let i = 1; i <= 3 && i < n; i++) {
    for (let j = i + 1; j <= i + 3 && j < n; j++) {
      for (let k = j + 1; k <= j + 3 && k < n; k++) {
        const a = s.slice(0, i);
        const b = s.slice(i, j);
        const c = s.slice(j, k);
        const d = s.slice(k);

        if (okOctet(a) && okOctet(b) && okOctet(c) && okOctet(d)) {
          res.push(`${a}.${b}.${c}.${d}`);
        }
      }
    }
  }

  return res;
}

export function uniquePathsGridI(rows: number, cols: number): number {
  const down = rows - 1;
  const right = cols - 1;
  const n = down + right;

  // compute C(n, k) with k = min(down, right)
  let k = Math.min(down, right);
  let result = 1;

  for (let i = 1; i <= k; i++) {
    result = (result * (n - k + i)) / i;
  }

  return Math.round(result);
}

export function rleCompressionI(s: string): string {
  let out = "";
  let i = 0;

  while (i < s.length) {
    const ch = s[i];
    let j = i;
    while (j < s.length && s[j] === ch) j++;

    let run = j - i;
    while (run > 9) {
      out += "9" + ch;
      run -= 9;
    }
    out += String(run) + ch;

    i = j;
  }

  return out;
}

export function hammingEncodedBinaryToInteger(code: string): number {
  // code length is typically 64 for this contract
  const b = code.split("").map(c => (c === "1" ? 1 : 0));
  const n = b.length - 1; // positions 1..n are the standard Hamming positions
  const parityPos = [1, 2, 4, 8, 16, 32];

  // Compute syndrome using standard Hamming parity checks over positions 1..n
  let syndrome = 0;
  for (const p of parityPos) {
    let parity = 0;
    for (let pos = 1; pos <= n; pos++) {
      if (pos & p) parity ^= b[pos];
    }
    if (parity === 1) syndrome |= p;
  }

  // Overall parity (position 0 checks ALL bits including parity bits)
  const overall = b.reduce((acc: number, x: number) => acc + x, 0) & 1;

  // Correct a single-bit error if indicated
  if (syndrome !== 0) {
    // In extended Hamming, syndrome!=0 and overall==1 => single-bit error at syndrome
    // If overall==0 with syndrome!=0 would imply multi-bit error, but contracts generally want "best effort"
    if (syndrome >= 0 && syndrome < b.length) b[syndrome] ^= 1;
  } else if (overall === 1) {
    // syndrome==0 but overall parity wrong => error is in overall parity bit
    b[0] ^= 1;
  }

  // Extract data bits: positions 1..n excluding parity positions
  let data = "";
  for (let pos = 1; pos <= n; pos++) {
    if (parityPos.includes(pos)) continue;
    data += b[pos] ? "1" : "0";
  }

  return parseInt(data, 2);
}

export function stockTraderI(prices: number[]): number {
  let minSoFar = Infinity;
  let best = 0;

  for (const p of prices) {
    if (p < minSoFar) minSoFar = p;
    const profit = p - minSoFar;
    if (profit > best) best = profit;
  }

  return best;
}

export function totalWaysToSum(n: number): number {
  // dp[s] = number of ways to make sum s using integers 1..(current i)
  const dp = Array(n + 1).fill(0);
  dp[0] = 1;

  for (let i = 1; i <= n; i++) {
    for (let s = i; s <= n; s++) {
      dp[s] += dp[s - i];
    }
  }

  // exclude the single-term partition "n"
  return dp[n] - 1;
}
