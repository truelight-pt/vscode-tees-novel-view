import { buildDocument, computeStyles, HighlightOptions, Segment } from './parser';

export interface ColorGroupConfig {
  enabled: boolean;
  color: string;
}

export interface BracketGroupConfig extends ColorGroupConfig {
  brackets: string[];
}

export interface CustomRuleConfig {
  pattern: string;
  flags?: string;
  color: string;
  enabled?: boolean;
  name?: string;
}

export interface PreviewConfig {
  charsPerLine: number;
  fontFamily: string;
  fontSize: number;
  lineHeight: number;
  lineNumbers: boolean;
  rubyEnabled: boolean;
  /** 丸括弧もルビとして扱う */
  rubyParentheses: boolean;
  highlightEnabled: boolean;
  dialogue: BracketGroupConfig;
  thought: BracketGroupConfig;
  quote: BracketGroupConfig;
  number: ColorGroupConfig & { includeKanji: boolean; kanjiCounters: string; kanjiPrefixes: string };
  customRules: CustomRuleConfig[];
}

export interface RenderResult {
  html: string;
  css: string;
  /** 無効な正規表現などの警告 */
  warnings: string[];
}

const STYLE_DIALOGUE = 1;
const STYLE_THOUGHT = 2;
const STYLE_QUOTE = 3;
const STYLE_NUMBER = 4;
const STYLE_CUSTOM_BASE = 5;

export function render(text: string, config: PreviewConfig): RenderResult {
  const warnings: string[] = [];
  const colors = new Map<number, string>();
  const opts: HighlightOptions = { brackets: [], regexes: [] };

  if (config.highlightEnabled) {
    const groups: Array<[number, BracketGroupConfig]> = [
      [STYLE_DIALOGUE, config.dialogue],
      [STYLE_THOUGHT, config.thought],
      [STYLE_QUOTE, config.quote],
    ];
    for (const [styleId, group] of groups) {
      if (!group.enabled) {
        continue;
      }
      const pairs = group.brackets
        .map((b) => Array.from(b))
        .filter((b) => b.length === 2)
        .map((b) => [b[0], b[1]] as [string, string]);
      if (pairs.length > 0) {
        opts.brackets.push({ styleId, pairs });
        colors.set(styleId, group.color);
      }
    }
    if (config.number.enabled) {
      opts.numberStyleId = STYLE_NUMBER;
      if (config.number.includeKanji) {
        opts.kanjiNumber = { counters: config.number.kanjiCounters, prefixes: config.number.kanjiPrefixes };
      }
      colors.set(STYLE_NUMBER, config.number.color);
    }
    config.customRules.forEach((rule, index) => {
      if (rule.enabled === false || !rule.pattern) {
        return;
      }
      const styleId = STYLE_CUSTOM_BASE + index;
      try {
        const flags = (rule.flags ?? '').replace(/[^imsu]/g, '');
        opts.regexes.push({ styleId, regex: new RegExp(rule.pattern, flags + 'g') });
        colors.set(styleId, rule.color);
      } catch (e) {
        warnings.push(`正規表現が不正です: ${rule.pattern} (${(e as Error).message})`);
      }
    });
  }

  const doc = buildDocument(text, config.rubyEnabled, { parentheses: config.rubyParentheses });
  const styles = colors.size > 0 ? computeStyles(doc.plain, opts) : undefined;

  const out: string[] = [];
  doc.lines.forEach((line, lineNo) => {
    // data-n: 表示用の行番号（1始まり）
    if (line.segments.length === 0) {
      out.push(`<p class="line empty" data-line="${lineNo}" data-n="${lineNo + 1}"></p>`);
      return;
    }
    out.push(`<p class="line" data-line="${lineNo}" data-n="${lineNo + 1}">`);
    let pos = line.start;
    for (const seg of line.segments) {
      pos = renderSegment(seg, pos, styles, out);
    }
    out.push('</p>');
  });

  return { html: out.join(''), css: buildCss(config, colors), warnings };
}

/**
 * 元テキストとの位置対応のため、文字列はすべて data-c（元の行内での開始位置）付きの span で出力する。
 * ルビは data-s / data-e にルビ記法全体の範囲を持たせる。
 */
function renderSegment(seg: Segment, pos: number, styles: Uint16Array | undefined, out: string[]): number {
  if (seg.kind === 'text') {
    out.push(styledText(seg.text, pos, seg.src, styles));
    return pos + seg.text.length;
  }
  const wrapStyle = styles ? styles[pos] : 0;
  if (wrapStyle) {
    out.push(`<span class="s${wrapStyle}">`);
  }
  out.push(
    `<ruby data-s="${seg.src}" data-e="${seg.srcEnd}">`,
    styledText(seg.base, pos, seg.baseSrc, styles, wrapStyle),
    '<rp>《</rp><rt>',
    escapeHtml(seg.rt),
    '</rt><rp>》</rp></ruby>',
  );
  if (wrapStyle) {
    out.push('</span>');
  }
  return pos + seg.base.length;
}

/** inherited と同じスタイルの部分はクラスを付けない（親要素から色を継承する） */
function styledText(text: string, pos: number, src: number, styles: Uint16Array | undefined, inherited = 0): string {
  const parts: string[] = [];
  let runStart = 0;
  for (let i = 1; i <= text.length; i++) {
    if (i === text.length || (styles && styles[pos + i] !== styles[pos + runStart])) {
      const chunk = escapeHtml(text.slice(runStart, i));
      const style = styles ? styles[pos + runStart] : 0;
      const cls = style !== inherited ? ` class="s${style}"` : '';
      parts.push(`<span data-c="${src + runStart}"${cls}>${chunk}</span>`);
      runStart = i;
    }
  }
  return parts.join('');
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

/** CSS に埋め込む値から、宣言を壊し得る文字を除去する */
function cssValue(s: string): string {
  return s.replace(/[;{}<>\\]/g, '').trim();
}

function buildCss(config: PreviewConfig, colors: Map<number, string>): string {
  const vars: string[] = [];
  const fontFamily = cssValue(config.fontFamily);
  vars.push(`--tnv-font-family: ${fontFamily || 'var(--vscode-editor-font-family)'};`);
  vars.push(`--tnv-font-size: ${config.fontSize > 0 ? `${config.fontSize}px` : 'var(--vscode-editor-font-size)'};`);
  vars.push(`--tnv-line-height: ${Math.max(1, config.lineHeight)};`);
  const width = config.charsPerLine > 0 ? `calc(${Math.floor(config.charsPerLine)}em + 1px)` : 'auto';
  vars.push(`--tnv-content-width: ${width};`);

  const rules = [`:root { ${vars.join(' ')} }`];
  for (const [id, color] of colors) {
    const c = cssValue(color);
    if (c) {
      rules.push(`.s${id} { color: ${c}; }`);
    }
  }
  return rules.join('\n');
}
