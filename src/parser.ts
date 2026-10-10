/**
 * 「小説家になろう」形式のルビ解析と、色分け範囲の計算。
 * vscode に依存しない純粋なロジックのみを置く（単体テスト可能にするため）。
 */

/**
 * 表示単位。src 系の値は元の行内での位置（UTF-16 単位。vscode.Position.character と同じ）。
 * text の文字は元テキスト上で連続しているため、表示位置 k の元位置は src + k になる。
 */
export type Segment =
  | { kind: 'text'; text: string; src: number }
  | {
      kind: 'ruby';
      base: string;
      rt: string;
      /** ルビ記法全体（| を含む）の開始位置 */
      src: number;
      /** 親文字の開始位置（親文字も元テキスト上で連続している） */
      baseSrc: number;
      /** ルビ記法全体の終了位置（閉じ括弧の直後） */
      srcEnd: number;
    };

export interface LineModel {
  segments: Segment[];
  /** plain（ルビ記法を除去した表示テキスト）内での開始位置 */
  start: number;
  /** plain 内での長さ（改行を含まない） */
  length: number;
}

export interface DocumentModel {
  lines: LineModel[];
  /** 表示テキスト（ルビ記法を除去し、行を \n で連結したもの） */
  plain: string;
}

/** 親文字の最大文字数 */
const MAX_BASE = 20;
/** ルビの最大文字数 */
const MAX_RUBY = 10;

const BARS = new Set(['|', '｜']);
/** 《》のみをルビとする */
const RUBY_CLOSE_ANGLE: Record<string, string> = { '《': '》' };
/** 丸括弧もルビとする（「小説家になろう」と同じ） */
const RUBY_CLOSE_WITH_PARENS: Record<string, string> = { '《': '》', '（': '）', '(': ')' };
const KANJI = /^[\p{Script=Han}々〆〇ヶヵ]$/u;
const KANA_ONLY = /^[\p{Script=Hiragana}\p{Script=Katakana}ー－ｰ・･゛゜]+$/u;

export interface RubyOptions {
  /** 丸括弧 () （） もルビとして扱う（ルビがひらがな・カタカナのみの場合）。既定は false */
  parentheses?: boolean;
}

function isRubyOpen(c: string | undefined, closeMap: Record<string, string>): boolean {
  return c !== undefined && Object.prototype.hasOwnProperty.call(closeMap, c);
}

/** chars[openIdx] の開き括弧に対応するルビ文字列を探す。ルビとして不正なら undefined。 */
function findRuby(chars: string[], openIdx: number, closeMap: Record<string, string>): { rt: string; end: number } | undefined {
  const open = chars[openIdx];
  const close = closeMap[open];
  const limit = Math.min(chars.length, openIdx + MAX_RUBY + 2);
  for (let k = openIdx + 1; k < limit; k++) {
    const c = chars[k];
    if (c === close) {
      if (k === openIdx + 1) {
        return undefined;
      }
      const rt = chars.slice(openIdx + 1, k).join('');
      // 丸括弧の場合はひらがな・カタカナのみをルビとみなす（通常の括弧書きとの区別）
      if (open !== '《' && !KANA_ONLY.test(rt)) {
        return undefined;
      }
      return { rt, end: k };
    }
    if (isRubyOpen(c, closeMap) || BARS.has(c)) {
      return undefined;
    }
  }
  return undefined;
}

/**
 * 1行分のテキストをルビ記法に従って分割する。
 *
 * - `|親文字《ルビ》` / `｜親文字《ルビ》` : 任意の文字列にルビ（親文字20字・ルビ10字まで）
 * - `漢字《ルビ》` : 直前の連続する漢字にルビ
 * - `(ルビ)` `（ルビ）` : options.parentheses が true のときのみ《》と同様に扱う。ただしルビがひらがな・カタカナのみの場合に限る
 * - `|《` : ルビにせず《をそのまま表示
 */
export function parseRubyLine(line: string, options: RubyOptions = {}): Segment[] {
  const closeMap = options.parentheses ? RUBY_CLOSE_WITH_PARENS : RUBY_CLOSE_ANGLE;
  const chars = Array.from(line);
  // offs[k]: chars[k] の UTF-16 位置
  const offs: number[] = [];
  let acc = 0;
  for (const ch of chars) {
    offs.push(acc);
    acc += ch.length;
  }
  offs.push(acc);

  const out: Segment[] = [];
  // buf は元テキスト上で連続した文字だけを溜める（bufStart は buf[0] の chars 上の位置）
  let buf: string[] = [];
  let bufStart = 0;
  const flush = () => {
    if (buf.length > 0) {
      out.push({ kind: 'text', text: buf.join(''), src: offs[bufStart] });
      buf = [];
    }
  };
  const push = (ch: string, at: number) => {
    if (buf.length === 0) {
      bufStart = at;
    }
    buf.push(ch);
  };

  let i = 0;
  while (i < chars.length) {
    const c = chars[i];

    if (BARS.has(c)) {
      // エスケープ: |《 → 《 をそのまま表示（| を飛ばすので前後で区切る）
      if (chars[i + 1] === '《') {
        flush();
        push('《', i + 1);
        flush();
        i += 2;
        continue;
      }
      // 親文字の後ろのルビ開始括弧を探す
      let j = i + 1;
      const limit = Math.min(chars.length, i + 1 + MAX_BASE + 1);
      while (j < limit && !isRubyOpen(chars[j], closeMap) && !BARS.has(chars[j])) {
        j++;
      }
      if (j < limit && j > i + 1 && isRubyOpen(chars[j], closeMap)) {
        const ruby = findRuby(chars, j, closeMap);
        if (ruby) {
          flush();
          out.push({
            kind: 'ruby',
            base: chars.slice(i + 1, j).join(''),
            rt: ruby.rt,
            src: offs[i],
            baseSrc: offs[i + 1],
            srcEnd: offs[ruby.end + 1],
          });
          i = ruby.end + 1;
          continue;
        }
      }
      push(c, i);
      i++;
      continue;
    }

    if (isRubyOpen(c, closeMap)) {
      const ruby = findRuby(chars, i, closeMap);
      if (ruby) {
        let k = buf.length;
        while (k > 0 && KANJI.test(buf[k - 1])) {
          k--;
        }
        const baseLen = buf.length - k;
        if (baseLen > 0 && baseLen <= MAX_BASE) {
          const baseStart = offs[bufStart + k];
          const base = buf.splice(k).join('');
          flush();
          out.push({ kind: 'ruby', base, rt: ruby.rt, src: baseStart, baseSrc: baseStart, srcEnd: offs[ruby.end + 1] });
          i = ruby.end + 1;
          continue;
        }
      }
    }

    push(c, i);
    i++;
  }
  flush();
  return out;
}

/**
 * 文字数を数える。ルビ記法（| 《》 とルビの読み）を除いた、表示される文字だけを数える。
 * 改行と空白（半角・全角スペース、タブなど）は数えない。サロゲートペアの文字は 1 文字として数える。
 */
export function countChars(text: string, options: RubyOptions = {}): number {
  let count = 0;
  for (const line of text.split(/\r\n|\r|\n/)) {
    for (const seg of parseRubyLine(line, options)) {
      count += countVisible(seg.kind === 'text' ? seg.text : seg.base);
    }
  }
  return count;
}

const WHITESPACE = /\s/;

/** 空白以外の文字数（コードポイント単位） */
function countVisible(s: string): number {
  let n = 0;
  for (const ch of s) {
    if (!WHITESPACE.test(ch)) {
      n++;
    }
  }
  return n;
}

export function buildDocument(text: string, rubyEnabled: boolean, rubyOptions: RubyOptions = {}): DocumentModel {
  const rawLines = text.split(/\r\n|\r|\n/);
  const lines: LineModel[] = [];
  const plainParts: string[] = [];
  let pos = 0;
  for (const raw of rawLines) {
    const segments: Segment[] = rubyEnabled
      ? parseRubyLine(raw, rubyOptions)
      : raw.length > 0 ? [{ kind: 'text', text: raw, src: 0 }] : [];
    let length = 0;
    for (const seg of segments) {
      const s = seg.kind === 'text' ? seg.text : seg.base;
      plainParts.push(s);
      length += s.length;
    }
    plainParts.push('\n');
    lines.push({ segments, start: pos, length });
    pos += length + 1;
  }
  return { lines, plain: plainParts.join('') };
}

// ---------------------------------------------------------------------------
// 色分け
// ---------------------------------------------------------------------------

export interface BracketGroup {
  styleId: number;
  /** 開き括弧と閉じ括弧の組 */
  pairs: Array<[string, string]>;
}

export interface HighlightOptions {
  brackets: BracketGroup[];
  numberStyleId?: number;
  /**
   * 漢数字（一二三…十百千万 など）も数字として扱う。
   * 熟語の一部（「統一」「一緒」など）は除外し、数として使われているものだけを対象にする。
   */
  kanjiNumber?: {
    /** 直後に続いても数とみなす漢字（助数詞） */
    counters: string;
    /** 直前にあっても数とみなす漢字（「第」「約」など） */
    prefixes: string;
  };
  /** 後のものほど優先 */
  regexes: Array<{ styleId: number; regex: RegExp }>;
}

const NUMBER_RE = /[0-9０-９]+(?:[.,．，][0-9０-９]+)*/g;
/** 算用数字と漢数字の混在（「3万」「二十一」「1.5億」など）も1つの数字として扱う */
const NUMBER_WITH_KANJI_RE =
  /[0-9０-９〇零一二三四五六七八九十百千万億兆]+(?:[.,．，][0-9０-９〇零一二三四五六七八九十百千万億兆]+)*/g;
const KANJI_NUMERAL = /[〇零一二三四五六七八九十百千万億兆]/;
/** 熟語判定用の漢字（「一ヶ月」のヶ・ヵは助数詞の一部なので含めない） */
const HAN = /^[\p{Script=Han}々〆]$/u;

/** index の直前の1文字（サロゲートペア対応） */
function charBefore(s: string, index: number): string {
  if (index <= 0) {
    return '';
  }
  const cp = s.codePointAt(index - 2);
  return index >= 2 && cp !== undefined && cp > 0xffff ? s.slice(index - 2, index) : s[index - 1];
}

/** index の位置の1文字（サロゲートペア対応） */
function charAt(s: string, index: number): string {
  const cp = s.codePointAt(index);
  return cp === undefined ? '' : String.fromCodePoint(cp);
}

/**
 * 漢数字を含む数字が、熟語の一部ではなく数として使われているかを判定する。
 * - 直前が漢字なら熟語とみなす（接頭語 prefixes は除く）: 統一・唯一 ✕ / 第三・約五十 ○
 * - 直後が漢字なら熟語とみなす（助数詞 counters は除く）: 一緒・九州 ✕ / 三人・二十一歳 ○
 */
function isStandaloneKanjiNumber(plain: string, start: number, end: number, opt: { counters: string; prefixes: string }): boolean {
  const before = charBefore(plain, start);
  if (HAN.test(before) && !opt.prefixes.includes(before)) {
    return false;
  }
  const after = charAt(plain, end);
  if (HAN.test(after) && !opt.counters.includes(after)) {
    return false;
  }
  return true;
}

/**
 * plain の各文字（UTF-16 コード単位）に適用するスタイル ID を計算する。0 はスタイルなし。
 * 優先順位: 正規表現ルール > 数字 > 括弧（内側の括弧ほど優先）
 */
export function computeStyles(plain: string, opts: HighlightOptions): Uint16Array {
  const styles = new Uint16Array(plain.length);

  // --- 括弧 ---
  const openMap = new Map<string, { close: string; styleId: number }>();
  const closeChars = new Set<string>();
  for (const group of opts.brackets) {
    for (const [open, close] of group.pairs) {
      if (!openMap.has(open)) {
        openMap.set(open, { close, styleId: group.styleId });
        closeChars.add(close);
      }
    }
  }
  if (openMap.size > 0) {
    const stack: Array<{ start: number; close: string; styleId: number }> = [];
    const ranges: Array<{ start: number; end: number; styleId: number }> = [];
    for (let i = 0; i < plain.length; i++) {
      const c = plain[i];
      if (closeChars.has(c)) {
        let k = stack.length - 1;
        while (k >= 0 && stack[k].close !== c) {
          k--;
        }
        if (k >= 0) {
          const open = stack[k];
          stack.length = k; // 閉じられていない内側の括弧は破棄
          ranges.push({ start: open.start, end: i + 1, styleId: open.styleId });
          continue;
        }
      }
      const open = openMap.get(c);
      if (open) {
        stack.push({ start: i, close: open.close, styleId: open.styleId });
      }
    }
    // 外側から順に塗り、内側で上書きする
    ranges.sort((a, b) => a.start - b.start);
    for (const r of ranges) {
      styles.fill(r.styleId, r.start, r.end);
    }
  }

  // --- 数字 ---
  if (opts.numberStyleId !== undefined) {
    const kanji = opts.kanjiNumber;
    if (kanji) {
      applyRegex(plain, styles, NUMBER_WITH_KANJI_RE, opts.numberStyleId, (start, end, text) =>
        !KANJI_NUMERAL.test(text) || isStandaloneKanjiNumber(plain, start, end, kanji),
      );
    } else {
      applyRegex(plain, styles, NUMBER_RE, opts.numberStyleId);
    }
  }

  // --- 正規表現ルール ---
  for (const rule of opts.regexes) {
    applyRegex(plain, styles, rule.regex, rule.styleId);
  }

  return styles;
}

function applyRegex(
  plain: string,
  styles: Uint16Array,
  regex: RegExp,
  styleId: number,
  accept?: (start: number, end: number, text: string) => boolean,
): void {
  const re = regex.global ? regex : new RegExp(regex.source, regex.flags + 'g');
  re.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(plain)) !== null) {
    if (m[0].length === 0) {
      re.lastIndex++;
      continue;
    }
    const end = m.index + m[0].length;
    if (!accept || accept(m.index, end, m[0])) {
      styles.fill(styleId, m.index, end);
    }
  }
}
