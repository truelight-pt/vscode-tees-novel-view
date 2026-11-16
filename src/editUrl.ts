/**
 * 編集投稿 URL の抽出と、エピソードと物語ファイルの照合。
 * vscode に依存しない純粋なロジックのみを置く（単体テスト可能にするため）。
 */
import { parseEpisodeName } from './episode';

/** 「小説家になろう」の相対リンクの基準 */
const SITE_ORIGIN = 'https://syosetu.com/';

export interface EpisodeEditUrl {
  /** ep.N の番号 */
  number: number;
  url: string;
}

export interface EpisodeListPage {
  /** 作品名（見つからなければ undefined） */
  workTitle?: string;
  /** タブの「投稿済 N」の件数（見つからなければ undefined） */
  postedCount?: number;
  /** ページの順に、番号の重複なし */
  episodes: EpisodeEditUrl[];
}

export interface EpisodeMatch<T> {
  matched: { episode: EpisodeEditUrl; file: T }[];
  /** 対応するファイルが無かったエピソードの番号 */
  unmatchedEpisodes: number[];
  /** 同じ番号のファイルが複数あり、1 つに絞れなかったエピソードの番号 */
  ambiguousEpisodes: number[];
  /** どのエピソードにも対応しなかったファイルの数 */
  unmatchedFileCount: number;
}

function decodeEntities(text: string): string {
  return text
    .replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#0*39;|&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

/** 「小説家になろう」のページへの https の URL なら、絶対 URL にして返す */
function toSyosetuUrl(href: string): string | undefined {
  try {
    const url = new URL(decodeEntities(href.trim()), SITE_ORIGIN);
    const isSyosetu = url.hostname === 'syosetu.com' || url.hostname.endsWith('.syosetu.com');
    return url.protocol === 'https:' && isSyosetu ? url.href : undefined;
  } catch {
    return undefined;
  }
}

/** 投稿済のエピソード一覧のページの HTML ソースから、各エピソードの編集 URL を取り出す */
export function parseEpisodeListPage(html: string): EpisodeListPage {
  const episodes: EpisodeEditUrl[] = [];
  const seen = new Set<number>();
  // 編集リンクの直前の範囲（前の編集リンクの後ろから）に、そのエピソードの ep.N がある
  const linkRe = /<a\b[^>]*\bclass="[^"]*\bp-up-episode-item__edit\b[^"]*"[^>]*>/g;
  let blockStart = 0;
  for (let m = linkRe.exec(html); m; m = linkRe.exec(html)) {
    const block = html.slice(blockStart, m.index);
    blockStart = m.index + m[0].length;
    const no = /\bc-up-label--episode-no\b[^>]*>\s*ep\.\s*([0-9]+)/.exec(block);
    const href = /\bhref="([^"]*)"/.exec(m[0]);
    const url = href && toSyosetuUrl(href[1]);
    if (!no || !url) {
      continue;
    }
    const number = parseInt(no[1], 10);
    if (!seen.has(number)) {
      seen.add(number);
      episodes.push({ number, url });
    }
  }
  const title = /<a\b[^>]*\bhref="https:\/\/ncode\.syosetu\.com\/[^"]*"[^>]*>([^<]+)<\/a>/.exec(html);
  const posted = /投稿済\s*<span\b[^>]*\bc-up-tab__item-count\b[^>]*>\s*([0-9,]+)/.exec(html);
  return {
    workTitle: title ? decodeEntities(title[1]).trim() : undefined,
    postedCount: posted ? parseInt(posted[1].replace(/,/g, ''), 10) : undefined,
    episodes,
  };
}

/** ブラウザで開ける URL か（手入力の確認用） */
export function isWebUrl(text: string): boolean {
  try {
    const { protocol } = new URL(text);
    return protocol === 'http:' || protocol === 'https:';
  } catch {
    return false;
  }
}

/**
 * ep.N とファイル名の番号を照合する。
 * 同じ番号のファイルが複数あるとき（「メモ2.txt」と「第02話.txt」など）は、番号より前の部分が
 * 最も多いもの（本編とみなす）に絞る。それでも 1 つにならなければ、誤設定を避けて対応付けない。
 */
export function matchEpisodes<T>(
  episodes: EpisodeEditUrl[],
  files: T[],
  fileName: (file: T) => string,
  regex: RegExp,
): EpisodeMatch<T> {
  const byNumber = new Map<number, { file: T; prefix: string }[]>();
  const prefixCounts = new Map<string, number>();
  for (const file of files) {
    const parsed = parseEpisodeName(fileName(file), regex);
    if (parsed) {
      byNumber.set(parsed.number, [...(byNumber.get(parsed.number) ?? []), { file, prefix: parsed.prefix }]);
      prefixCounts.set(parsed.prefix, (prefixCounts.get(parsed.prefix) ?? 0) + 1);
    }
  }
  const topCount = Math.max(0, ...prefixCounts.values());

  const result: EpisodeMatch<T> = { matched: [], unmatchedEpisodes: [], ambiguousEpisodes: [], unmatchedFileCount: 0 };
  for (const episode of episodes) {
    const candidates = byNumber.get(episode.number) ?? [];
    const narrowed = candidates.length > 1 ? candidates.filter((c) => prefixCounts.get(c.prefix) === topCount) : candidates;
    if (candidates.length === 0) {
      result.unmatchedEpisodes.push(episode.number);
    } else if (narrowed.length === 1) {
      result.matched.push({ episode, file: narrowed[0].file });
    } else {
      result.ambiguousEpisodes.push(episode.number);
    }
  }
  result.unmatchedFileCount = files.length - result.matched.length;
  return result;
}
