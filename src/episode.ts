/**
 * ファイル名の番号から前話・次話のファイルを探す。
 * vscode に依存しない純粋なロジックのみを置く（単体テスト可能にするため）。
 */

/** 既定: ファイル名（拡張子を除く）の最後の数字の並び（半角・全角） */
export const DEFAULT_EPISODE_PATTERN = '[0-9０-９]+(?=[^0-9０-９]*$)';

interface EpisodeName {
  /** 番号の値 */
  number: number;
  /** 番号より前の部分（同じシリーズかの判定に使う） */
  prefix: string;
}

export interface EpisodeNeighbors {
  prev?: string;
  next?: string;
}

function stripExtension(name: string): string {
  return name.replace(/\.[^.]*$/, '');
}

/**
 * ファイル名から番号を抜き出す。
 * 正規表現にキャプチャグループがあれば 1 番目のグループ、無ければマッチ全体を番号とみなす。
 */
export function parseEpisodeName(fileName: string, regex: RegExp): EpisodeName | undefined {
  const base = stripExtension(fileName);
  const m = regex.exec(base);
  if (!m) {
    return undefined;
  }
  const digits = m[1] ?? m[0];
  const offset = m[1] !== undefined ? m[0].indexOf(m[1]) : 0;
  const ascii = digits.replace(/[０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0));
  if (!/^[0-9]+$/.test(ascii)) {
    return undefined;
  }
  return { number: parseInt(ascii, 10), prefix: base.slice(0, m.index + offset) };
}

/**
 * current の前話・次話を candidates（同じフォルダーのファイル名）から探す。
 * 番号より前の部分が同じファイルのうち、番号がその方向で最も近いものを選ぶ（番号が飛んでいても辿れる）。
 */
export function findEpisodeNeighbors(current: string, candidates: string[], regex: RegExp): EpisodeNeighbors {
  const cur = parseEpisodeName(current, regex);
  if (!cur) {
    return {};
  }
  let prev: { name: string; number: number } | undefined;
  let next: { name: string; number: number } | undefined;
  for (const name of [...candidates].sort()) {
    if (name === current) {
      continue;
    }
    const ep = parseEpisodeName(name, regex);
    if (!ep || ep.prefix !== cur.prefix) {
      continue;
    }
    if (ep.number < cur.number && (!prev || ep.number > prev.number)) {
      prev = { name, number: ep.number };
    }
    if (ep.number > cur.number && (!next || ep.number < next.number)) {
      next = { name, number: ep.number };
    }
  }
  return { prev: prev?.name, next: next?.name };
}
