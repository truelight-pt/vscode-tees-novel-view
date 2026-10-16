/**
 * 行単位の差分。エディターの左端に出る変更の印（追加・変更・削除）と同じ考え方で、変更のあった行を求める。
 * vscode に依存しないので、テストから直接呼べる。
 */

export type LineChangeType = 'added' | 'modified' | 'deleted';

/** 変更のあった行の範囲（行番号は変更後のテキストの 0 始まり） */
export interface LineChange {
  type: LineChangeType;
  /** added / modified: 範囲の最初の行。deleted: この行の直前で行が削除された（末尾で削除された場合は行数） */
  start: number;
  /** added / modified: 範囲の最後の行の次。deleted: start と同じ */
  end: number;
}

export function splitLines(text: string): string[] {
  return text.split(/\r\n|\r|\n/);
}

/** これより差分が大きいときは、計算を打ち切って前後の一致部分を除いた全体を変更とみなす */
const MAX_EDIT_COST = 2000;

/**
 * 変更前（original）と変更後（modified）の行を比べ、変更のあった行の範囲を返す。
 * 削除と追加が隣り合う部分は「変更」としてまとめる。
 */
export function diffLines(original: string[], modified: string[], maxCost = MAX_EDIT_COST): LineChange[] {
  // 前後の一致部分を除く（ほとんどの編集はこれだけで範囲が絞られる）
  let prefix = 0;
  const minLength = Math.min(original.length, modified.length);
  while (prefix < minLength && original[prefix] === modified[prefix]) {
    prefix++;
  }
  let suffix = 0;
  while (
    suffix < minLength - prefix &&
    original[original.length - 1 - suffix] === modified[modified.length - 1 - suffix]
  ) {
    suffix++;
  }
  const a = original.slice(prefix, original.length - suffix);
  const b = modified.slice(prefix, modified.length - suffix);

  const hunks = (a.length > 0 && b.length > 0 && myersHunks(a, b, maxCost)) || [[0, a.length, 0, b.length]];
  const changes: LineChange[] = [];
  for (const [aStart, aEnd, bStart, bEnd] of hunks) {
    const start = prefix + bStart;
    const end = prefix + bEnd;
    if (aStart === aEnd && bStart === bEnd) {
      continue;
    }
    if (aStart === aEnd) {
      changes.push({ type: 'added', start, end });
    } else if (bStart === bEnd) {
      changes.push({ type: 'deleted', start, end: start });
    } else {
      changes.push({ type: 'modified', start, end });
    }
  }
  return changes;
}

/**
 * Myers の差分アルゴリズムで、一致しない部分（a の範囲と b の範囲の組）を求める。
 * 編集の量が maxCost を超えたら undefined を返す。
 */
function myersHunks(a: string[], b: string[], maxCost: number): Array<[number, number, number, number]> | undefined {
  const n = a.length;
  const m = b.length;
  const max = n + m;
  const offset = max + 1;
  const v = new Int32Array(2 * max + 3);
  /** 各段階の終わりの v（対角線 k = -d..d の分だけ） */
  const trace: Int32Array[] = [];
  let found = false;
  for (let d = 0; d <= max && !found; d++) {
    if (d > maxCost) {
      return undefined;
    }
    for (let k = -d; k <= d; k += 2) {
      let x = k === -d || (k !== d && v[offset + k - 1] < v[offset + k + 1]) ? v[offset + k + 1] : v[offset + k - 1] + 1;
      let y = x - k;
      while (x < n && y < m && a[x] === b[y]) {
        x++;
        y++;
      }
      v[offset + k] = x;
      if (x >= n && y >= m) {
        found = true;
        break;
      }
    }
    trace.push(v.slice(offset - d, offset + d + 1));
  }

  // 終点からたどって、一致した行の組を集める
  const matches: Array<[number, number]> = [];
  let x = n;
  let y = m;
  for (let d = trace.length - 1; d > 0; d--) {
    const prev = trace[d - 1];
    const get = (k: number) => prev[k + d - 1];
    const k = x - y;
    const prevK = k === -d || (k !== d && get(k - 1) < get(k + 1)) ? k + 1 : k - 1;
    const prevX = get(prevK);
    const prevY = prevX - prevK;
    while (x > prevX && y > prevY) {
      x--;
      y--;
      matches.push([x, y]);
    }
    x = prevX;
    y = prevY;
  }
  while (x > 0 && y > 0) {
    x--;
    y--;
    matches.push([x, y]);
  }
  matches.reverse();

  // 一致した行の間を、変更のあった部分とする
  const hunks: Array<[number, number, number, number]> = [];
  let ai = 0;
  let bi = 0;
  for (const [mx, my] of matches) {
    if (mx > ai || my > bi) {
      hunks.push([ai, mx, bi, my]);
    }
    ai = mx + 1;
    bi = my + 1;
  }
  if (ai < n || bi < m) {
    hunks.push([ai, n, bi, m]);
  }
  return hunks;
}
