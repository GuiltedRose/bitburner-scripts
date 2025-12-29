type Board = string[][];
type ValidMoves = boolean[][];

export async function main(ns: NS) {
  const FACTION = "Netburners";
  const BOARD_SIZE = 13;
  const SLEEP_MS = 50;

  const ME = "X"; // always black
  const EN = "O";

  ns.disableLog("sleep");

  while (true) {
    ns.go.resetBoardState(FACTION, BOARD_SIZE);

    let result: any = null;
    let turn = 0;

    let lastEnemy: { x: number; y: number } | null = null;

    while (true) {
      turn++;
      const raw = ns.go.getBoardState() as unknown; // makes sure getBoardState can map to Board Type
      const board = raw as Board;
      const valid = ns.go.analysis.getValidMoves() as ValidMoves;

      // If opponent passed last turn, we end immediately by passing once.
      // (This matches your old script’s winning pattern.)
      // We detect this AFTER reading opponentNextTurn below, so we need a flag:
      // -> handled at bottom of loop.

      // ---- choose move ----
      const move = pickMoveSmart(board, valid, BOARD_SIZE, ME, EN, turn, lastEnemy);

      // If no move: pass (forced)
      if (!move) {
        result = await ns.go.passTurn();
        if (result?.type === "gameOver") break;

        // Now get opponent response (old rhythm)
        const opp = await ns.go.opponentNextTurn();
        if (opp?.type === "gameOver") break;

        const mv = extractMoveXY(opp);
        if (mv) lastEnemy = mv;

        // If opponent passed, pass to end
        if (isPassResponse(opp)) {
          const end = await ns.go.passTurn();
          if (end?.type === "gameOver") break;
        }

        await ns.sleep(SLEEP_MS);
        continue;
      }

      // Play our move
      result = await ns.go.makeMove(move[0], move[1]);
      if (result?.type === "gameOver") break;

      // Opponent response
      const opp = await ns.go.opponentNextTurn();
      if (opp?.type === "gameOver") break;

      const mv = extractMoveXY(opp);
      if (mv) lastEnemy = mv;

      // If opponent passed, we pass immediately to end.
      if (isPassResponse(opp)) {
        const end = await ns.go.passTurn();
        if (end?.type === "gameOver") break;

        // Some builds may return gameOver on the *next* loop tick; we keep going safely.
      }

      await ns.sleep(SLEEP_MS);
    }
  }
}

// ---------------- Move selection ----------------

function pickMoveSmart(
  board: Board,
  valid: ValidMoves,
  size: number,
  ME: string,
  EN: string,
  turn: number,
  lastEnemy: { x: number; y: number } | null
): [number, number] | null {
  const moves: [number, number][] = [];
  for (let x = 0; x < size; x++) for (let y = 0; y < size; y++) if (valid[x]?.[y]) moves.push([x, y]);
  if (moves.length === 0) return null;

  // Opening: prefer center-ish
  if (turn === 1) {
    moves.sort((a, b) => dist2(a[0], a[1], size) - dist2(b[0], b[1], size));
    const bucket = Math.max(1, Math.floor(moves.length * 0.10));
    return moves[Math.floor(Math.random() * bucket)];
  }

  // 0) If we have a group in atari, try to save it (unless we can capture big).
  const defense = pickDefense(board, valid, size, ME, EN, lastEnemy);
  if (defense) return defense;

  // 1) Force captures (no lingering)
  const cap = pickBestCapture(board, moves, size, ME, EN, lastEnemy);
  if (cap) return cap;

  // 2) Otherwise safe pressure/chase
  return pickBestPressure(board, moves, size, ME, EN, lastEnemy);
}

function pickDefense(
  board: Board,
  valid: ValidMoves,
  size: number,
  ME: string,
  EN: string,
  lastEnemy: { x: number; y: number } | null
): [number, number] | null {
  if (hasCaptureAtLeast(board, valid, size, ME, EN, 2)) return null;

  const libs = findMyAtariLiberties(board, size, ME);
  if (libs.length === 0) return null;

  let best: [number, number] | null = null;
  let bestScore = -Infinity;

  for (const [x, y] of libs) {
    if (!valid[x]?.[y]) continue;

    const sim = simulateMove(board, x, y, size, ME, EN);
    if (sim.captured === 0 && sim.myLibs <= 1) continue;
    if (sim.captured === 0 && enemyCanCaptureOurNewChain(sim, size, ME, EN)) continue;

    const sc = scoreMove(x, y, size, ME, EN, lastEnemy, sim) + 2500;
    if (sc > bestScore) {
      bestScore = sc;
      best = [x, y];
    }
  }

  return best;
}

function pickBestCapture(
  board: Board,
  moves: [number, number][],
  size: number,
  ME: string,
  EN: string,
  lastEnemy: { x: number; y: number } | null
): [number, number] | null {
  let best: [number, number] | null = null;
  let bestCap = 0;
  let bestScore = -Infinity;

  for (const [x, y] of moves) {
    const sim = simulateMove(board, x, y, size, ME, EN);
    if (sim.captured <= 0) continue;
    if (sim.myLibs <= 0) continue;

    const sc = scoreMove(x, y, size, ME, EN, lastEnemy, sim);

    if (sim.captured > bestCap || (sim.captured === bestCap && sc > bestScore)) {
      bestCap = sim.captured;
      bestScore = sc;
      best = [x, y];
    }
  }

  return best;
}

function pickBestPressure(
  board: Board,
  moves: [number, number][],
  size: number,
  ME: string,
  EN: string,
  lastEnemy: { x: number; y: number } | null
): [number, number] | null {
  let best: [number, number] | null = null;
  let bestScore = -Infinity;

  for (const [x, y] of moves) {
    const sim = simulateMove(board, x, y, size, ME, EN);

    // refuse self-atari unless capturing
    if (sim.captured === 0 && sim.myLibs <= 1) continue;

    // refuse immediate death next move unless capturing
    if (sim.captured === 0 && enemyCanCaptureOurNewChain(sim, size, ME, EN)) continue;

    const sc = scoreMove(x, y, size, ME, EN, lastEnemy, sim);
    if (sc > bestScore) {
      bestScore = sc;
      best = [x, y];
    }
  }

  return best;
}

// ---------------- Simulation & scoring ----------------

type SimResult = {
  after: Board;
  captured: number;
  myLibs: number;
  myLibPoints: [number, number][];
  mx: number;
  my: number;
};

function simulateMove(board: Board, mx: number, my: number, size: number, ME: string, EN: string): SimResult {
  const after: Board = Array.from({ length: size }, (_, x) =>
    Array.from({ length: size }, (_, y) => board[x][y])
  );

  after[mx][my] = ME;

  const cell = (x: number, y: number): string => {
    if (x < 0 || y < 0 || x >= size || y >= size) return "#";
    return after[x][y];
  };

  const N4: [number, number][] = [
    [mx - 1, my],
    [mx + 1, my],
    [mx, my - 1],
    [mx, my + 1],
  ];

  let captured = 0;
  const seenEnemy = new Set<string>();

  for (const [ax, ay] of N4) {
    if (cell(ax, ay) !== EN) continue;

    const k0 = `${ax},${ay}`;
    if (seenEnemy.has(k0)) continue;

    const g = groupLiberties(cell, size, ax, ay, EN);
    for (const [sx, sy] of g.stones) seenEnemy.add(`${sx},${sy}`);

    if (g.liberties === 0) {
      captured += g.stones.length;
      for (const [sx, sy] of g.stones) after[sx][sy] = ".";
    }
  }

  const myInfo = groupLibertiesWithPoints(
    (x, y) => {
      if (x < 0 || y < 0 || x >= size || y >= size) return "#";
      return after[x][y];
    },
    size,
    mx,
    my,
    ME
  );

  return {
    after,
    captured,
    myLibs: myInfo.liberties,
    myLibPoints: myInfo.libPoints,
    mx,
    my,
  };
}

// 1-ply trap: can EN capture our new chain by playing one of its liberties?
function enemyCanCaptureOurNewChain(sim: SimResult, size: number, ME: string, EN: string): boolean {
  if (sim.myLibPoints.length === 0) return true;

  for (const [lx, ly] of sim.myLibPoints) {
    if (sim.after[lx][ly] !== ".") continue;

    const after2: Board = Array.from({ length: size }, (_, x) =>
      Array.from({ length: size }, (_, y) => sim.after[x][y])
    );
    after2[lx][ly] = EN;

    const cell2 = (x: number, y: number): string => {
      if (x < 0 || y < 0 || x >= size || y >= size) return "#";
      return after2[x][y];
    };

    const g = groupLiberties(cell2, size, sim.mx, sim.my, ME);
    if (g.liberties === 0) return true;
  }

  return false;
}

function scoreMove(
  mx: number,
  my: number,
  size: number,
  ME: string,
  EN: string,
  lastEnemy: { x: number; y: number } | null,
  sim: SimResult
): number {
  const cell = (x: number, y: number): string => {
    if (x < 0 || y < 0 || x >= size || y >= size) return "#";
    return sim.after[x][y];
  };

  const N4: [number, number][] = [
    [mx - 1, my],
    [mx + 1, my],
    [mx, my - 1],
    [mx, my + 1],
  ];

  let adjacentEnemy = 0;
  for (const [ax, ay] of N4) if (cell(ax, ay) === EN) adjacentEnemy++;

  let libertyPressure = 0;
  let atariCount = 0;

  const seen = new Set<string>();
  for (const [ax, ay] of N4) {
    if (cell(ax, ay) !== EN) continue;

    const k0 = `${ax},${ay}`;
    if (seen.has(k0)) continue;

    const { liberties, stones } = groupLiberties(cell, size, ax, ay, EN);
    for (const [sx, sy] of stones) seen.add(`${sx},${sy}`);

    if (liberties === 1) atariCount++;
    libertyPressure += Math.max(0, 8 - liberties);
  }

  let chaseScore = 0;
  if (lastEnemy) {
    const d = Math.abs(mx - lastEnemy.x) + Math.abs(my - lastEnemy.y);
    chaseScore = 30 / (1 + d);
  }

  return (
    sim.captured * 25000 +
    atariCount * 1000 +
    libertyPressure * 80 +
    adjacentEnemy * 160 +
    chaseScore +
    sim.myLibs * 20
  );
}

// ---------------- Board analysis helpers ----------------

function hasCaptureAtLeast(board: Board, valid: ValidMoves, size: number, ME: string, EN: string, minCaptured: number): boolean {
  for (let x = 0; x < size; x++) {
    for (let y = 0; y < size; y++) {
      if (!valid[x]?.[y]) continue;
      const sim = simulateMove(board, x, y, size, ME, EN);
      if (sim.captured >= minCaptured) return true;
    }
  }
  return false;
}

function findMyAtariLiberties(board: Board, size: number, ME: string): [number, number][] {
  const libsOut = new Set<string>();
  const seen = new Set<string>();

  const cell0 = (x: number, y: number): string => {
    if (x < 0 || y < 0 || x >= size || y >= size) return "#";
    return board[x][y];
  };

  for (let x = 0; x < size; x++) {
    for (let y = 0; y < size; y++) {
      if (board[x][y] !== ME) continue;
      const key = `${x},${y}`;
      if (seen.has(key)) continue;

      const info = groupLibertiesWithPoints(cell0, size, x, y, ME);
      for (const [sx, sy] of info.stones) seen.add(`${sx},${sy}`);

      if (info.liberties === 1 && info.libPoints.length === 1) {
        const [lx, ly] = info.libPoints[0];
        libsOut.add(`${lx},${ly}`);
      }
    }
  }

  const out: [number, number][] = [];
  for (const s of libsOut) {
    const [x, y] = s.split(",").map(Number);
    out.push([x, y]);
  }
  return out;
}

function isPassResponse(opp: any): boolean {
  if (!opp) return false;
  if (opp.type === "pass") return true;
  if (opp.move === "pass") return true;
  if (opp.action === "pass") return true;
  return false;
}

// ---------------- Go group helpers ----------------

function groupLiberties(
  cell: (x: number, y: number) => string,
  size: number,
  sx: number,
  sy: number,
  color: string
): { liberties: number; stones: [number, number][] } {
  const q: [number, number][] = [[sx, sy]];
  const seen = new Set<string>([`${sx},${sy}`]);
  const stones: [number, number][] = [];
  const libs = new Set<string>();

  while (q.length) {
    const [x, y] = q.pop()!;
    stones.push([x, y]);

    const neigh: [number, number][] = [
      [x - 1, y],
      [x + 1, y],
      [x, y - 1],
      [x, y + 1],
    ];

    for (const [nx, ny] of neigh) {
      if (nx < 0 || ny < 0 || nx >= size || ny >= size) continue;
      const c = cell(nx, ny);
      if (c === ".") libs.add(`${nx},${ny}`);
      else if (c === color) {
        const k = `${nx},${ny}`;
        if (!seen.has(k)) {
          seen.add(k);
          q.push([nx, ny]);
        }
      }
    }
  }

  return { liberties: libs.size, stones };
}

function groupLibertiesWithPoints(
  cell: (x: number, y: number) => string,
  size: number,
  sx: number,
  sy: number,
  color: string
): { liberties: number; stones: [number, number][]; libPoints: [number, number][] } {
  const q: [number, number][] = [[sx, sy]];
  const seen = new Set<string>([`${sx},${sy}`]);
  const stones: [number, number][] = [];
  const libs = new Set<string>();

  while (q.length) {
    const [x, y] = q.pop()!;
    stones.push([x, y]);

    const neigh: [number, number][] = [
      [x - 1, y],
      [x + 1, y],
      [x, y - 1],
      [x, y + 1],
    ];

    for (const [nx, ny] of neigh) {
      if (nx < 0 || ny < 0 || nx >= size || ny >= size) continue;
      const c = cell(nx, ny);
      if (c === ".") libs.add(`${nx},${ny}`);
      else if (c === color) {
        const k = `${nx},${ny}`;
        if (!seen.has(k)) {
          seen.add(k);
          q.push([nx, ny]);
        }
      }
    }
  }

  const libPoints: [number, number][] = [];
  for (const s of libs) {
    const [x, y] = s.split(",").map(Number);
    libPoints.push([x, y]);
  }

  return { liberties: libs.size, stones, libPoints };
}

function dist2(x: number, y: number, size: number): number {
  const cx = (size - 1) / 2;
  const cy = (size - 1) / 2;
  const dx = x - cx;
  const dy = y - cy;
  return dx * dx + dy * dy;
}

function extractMoveXY(opp: any): { x: number; y: number } | null {
  if (!opp) return null;
  if (typeof opp.x === "number" && typeof opp.y === "number") return { x: opp.x, y: opp.y };
  if (opp.move && typeof opp.move.x === "number" && typeof opp.move.y === "number") {
    return { x: opp.move.x, y: opp.move.y };
  }
  if (Array.isArray(opp.lastMove) && opp.lastMove.length >= 2) {
    const [x, y] = opp.lastMove;
    if (typeof x === "number" && typeof y === "number") return { x, y };
  }
  return null;
}
