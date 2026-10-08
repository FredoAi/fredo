/**
 * lifeSimulation — the PURE Conway's Game of Life domain (Spec #2915, ST-2).
 *
 * B3/S23 over a double-buffered `Uint8Array` (two buffers, one byte per cell):
 * a dead cell is born with exactly 3 live neighbours, a live cell survives with
 * 2 or 3 and dies otherwise. Boundaries are dead (no wrap). `step()` allocates
 * NOTHING — it reads the front buffer, writes the back buffer, then swaps them.
 *
 * This module is headless: it imports NO DOM, canvas, or React. Seeding is
 * deterministic — `createLifeSimulation({cols, rows, seed})` places
 * `LIFE_RESEED_PATTERNS_MIN..MAX` (2–4) oriented patterns from the bounded Life
 * Lexicon catalogue at random positions plus `LIFE_FILL_DENSITY` bounded random
 * fill, then enforces the initial density band
 * [`LIFE_DENSITY_MIN`, `LIFE_DENSITY_MAX`] (never empty, never saturated).
 *
 * Re-seed policy (`shouldReseed`): the authored generation cap
 * (`LIFE_RESEED_GENERATIONS`) OR stagnation — the population unchanged for
 * `LIFE_STAGNATION_GENERATIONS` consecutive generations while at or below
 * `LIFE_STAGNATION_MIN_DENSITY`.
 */

import {
  LIFE_DENSITY_MAX,
  LIFE_DENSITY_MIN,
  LIFE_FILL_DENSITY,
  LIFE_RESEED_GENERATIONS,
  LIFE_RESEED_PATTERNS_MAX,
  LIFE_RESEED_PATTERNS_MIN,
  LIFE_STAGNATION_GENERATIONS,
  LIFE_STAGNATION_MIN_DENSITY,
} from './lifeConstants';
import { LIFE_PATTERNS, createLifeRng, orientPattern } from './lifePatterns';

/** A snapshot of a Life grid: `cells[row * cols + col] === 1` means alive. */
export interface LifeGrid {
  cols: number;
  rows: number;
  cells: Uint8Array;
}

/** The pure Life automaton contract (see the module header). */
export interface LifeSimulation {
  readonly cols: number;
  readonly rows: number;
  /** Generations advanced since the last populate/reseed. */
  readonly generation: number;
  /** Live cells in the current generation. */
  readonly population: number;
  /** Advance exactly one B3/S23 generation (zero allocation). */
  step(): void;
  /** Deterministically (re)seed the grid from `rngSeed` and reset the counter. */
  populate(rngSeed: number): void;
  /** True when the re-seed policy fires (generation cap OR stagnation). */
  shouldReseed(): boolean;
  /** Policy-driven re-randomisation on the SAME grid (aliases `populate`). */
  reseed(rngSeed: number): void;
  /** A COPY of the current cell buffer (`Uint8Array`, row-major). */
  snapshot(): Uint8Array;
}

/**
 * Pure B3/S23 transition over two caller-owned, equally-sized buffers. Reads
 * `front`, writes EVERY cell of `back`, and returns the new population. No
 * allocation, no bounds surprises: boundaries are dead.
 */
export function stepLifeGrid(
  cols: number,
  rows: number,
  front: Uint8Array,
  back: Uint8Array,
): number {
  let population = 0;
  for (let row = 0; row < rows; row++) {
    for (let col = 0; col < cols; col++) {
      let neighbours = 0;
      for (let dr = -1; dr <= 1; dr++) {
        const neighbourRow = row + dr;
        if (neighbourRow < 0 || neighbourRow >= rows) continue;
        const rowOffset = neighbourRow * cols;
        for (let dc = -1; dc <= 1; dc++) {
          if (dr === 0 && dc === 0) continue;
          const neighbourCol = col + dc;
          if (neighbourCol < 0 || neighbourCol >= cols) continue;
          if (front[rowOffset + neighbourCol] === 1) neighbours += 1;
        }
      }
      const index = row * cols + col;
      const alive = front[index] === 1;
      const next = alive ? (neighbours === 2 || neighbours === 3 ? 1 : 0) : neighbours === 3 ? 1 : 0;
      back[index] = next;
      population += next;
    }
  }
  return population;
}

/**
 * PURE re-seed policy (the `shouldReseed()` rule, exported so the cap and the
 * stagnation branch are exhaustively unit-testable). Fires on the generation cap
 * or when the population has been unchanged for `LIFE_STAGNATION_GENERATIONS`
 * consecutive generations at/below `LIFE_STAGNATION_MIN_DENSITY`.
 */
export function shouldReseedLife(input: {
  generation: number;
  unchangedGenerations: number;
  population: number;
  cols: number;
  rows: number;
}): boolean {
  if (input.generation >= LIFE_RESEED_GENERATIONS) return true;
  const total = input.cols * input.rows;
  const density = total > 0 ? input.population / total : 0;
  return (
    input.unchangedGenerations >= LIFE_STAGNATION_GENERATIONS &&
    density <= LIFE_STAGNATION_MIN_DENSITY
  );
}

/** Create a populated Life automaton over `cols × rows` cells. */
export function createLifeSimulation(input: {
  cols: number;
  rows: number;
  seed: number;
}): LifeSimulation {
  const cols = Math.max(1, Math.floor(input.cols));
  const rows = Math.max(1, Math.floor(input.rows));
  const total = cols * rows;

  let front = new Uint8Array(total);
  let back = new Uint8Array(total);
  let generation = 0;
  let population = 0;
  let unchangedGenerations = 0;

  function countAlive(): number {
    let alive = 0;
    for (let index = 0; index < total; index++) {
      if (front[index] === 1) alive += 1;
    }
    return alive;
  }

  /** Place a random 2–4 oriented catalogue patterns (clears the front buffer). */
  function placePatterns(rng: () => number): void {
    front.fill(0);
    const span = LIFE_RESEED_PATTERNS_MAX - LIFE_RESEED_PATTERNS_MIN + 1;
    const count = LIFE_RESEED_PATTERNS_MIN + Math.floor(rng() * span);
    for (let placed = 0; placed < count; placed++) {
      const pattern = LIFE_PATTERNS[Math.floor(rng() * LIFE_PATTERNS.length)];
      const cells = orientPattern(pattern, Math.floor(rng() * 8));

      let patternWidth = 0;
      let patternHeight = 0;
      for (const [col, row] of cells) {
        if (col + 1 > patternWidth) patternWidth = col + 1;
        if (row + 1 > patternHeight) patternHeight = row + 1;
      }
      const offsetCol = Math.floor(rng() * (Math.max(0, cols - patternWidth) + 1));
      const offsetRow = Math.floor(rng() * (Math.max(0, rows - patternHeight) + 1));
      for (const [col, row] of cells) {
        const cellCol = offsetCol + col;
        const cellRow = offsetRow + row;
        if (cellCol < cols && cellRow < rows) front[cellRow * cols + cellCol] = 1;
      }
    }
  }

  /** Bounded random fill on top of the placed patterns. */
  function applyFill(rng: () => number): void {
    for (let index = 0; index < total; index++) {
      if (rng() < LIFE_FILL_DENSITY) front[index] = 1;
    }
  }

  /**
   * Bring the live count onto `target` by toggling cells in a prime-strided
   * pseudo-random scan (bounded by `total` toggles — never an unbounded probe).
   * With the authored 10 % fill inside the 4–30 % band this is normally a no-op;
   * it exists so the density invariant holds for any grid/seed.
   */
  function adjustPopulation(rng: () => number, target: number, turnOn: boolean): number {
    let alive = countAlive();
    if (turnOn ? alive >= target : alive <= target) return alive;
    const stride = 7919;
    const start = Math.floor(rng() * total);
    for (let step = 0; step < total && (turnOn ? alive < target : alive > target); step++) {
      const index = (start + step * stride) % total;
      if (turnOn) {
        if (front[index] === 0) {
          front[index] = 1;
          alive += 1;
        }
      } else if (front[index] === 1) {
        front[index] = 0;
        alive -= 1;
      }
    }
    return alive;
  }

  function populate(rngSeed: number): void {
    const rng = createLifeRng(rngSeed);
    back.fill(0);
    placePatterns(rng);
    applyFill(rng);

    const minAlive = Math.min(total - 1, Math.max(1, Math.ceil(total * LIFE_DENSITY_MIN)));
    const maxAlive = Math.min(
      total - 1,
      Math.max(minAlive, Math.floor(total * LIFE_DENSITY_MAX)),
    );
    let alive = countAlive();
    if (alive < minAlive) alive = adjustPopulation(rng, minAlive, true);
    if (alive > maxAlive) alive = adjustPopulation(rng, maxAlive, false);

    generation = 0;
    unchangedGenerations = 0;
    population = alive;
  }

  function step(): void {
    const nextPopulation = stepLifeGrid(cols, rows, front, back);
    const previousFront = front;
    front = back;
    back = previousFront;
    generation += 1;
    unchangedGenerations = nextPopulation === population ? unchangedGenerations + 1 : 0;
    population = nextPopulation;
  }

  // The automaton is always in a valid, populated state on creation — the same
  // state `populate(seed)` produces.
  populate(input.seed >>> 0);

  return {
    cols,
    rows,
    get generation() {
      return generation;
    },
    get population() {
      return population;
    },
    step,
    populate,
    shouldReseed(): boolean {
      return shouldReseedLife({ generation, unchangedGenerations, population, cols, rows });
    },
    reseed(rngSeed: number): void {
      populate(rngSeed);
    },
    snapshot(): Uint8Array {
      return front.slice();
    },
  };
}
