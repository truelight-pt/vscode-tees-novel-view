import * as assert from 'assert';
import { computeStyles, countChars, parseRubyLine, Segment } from '../parser';
import { render } from '../renderer';
import { DEFAULT_EPISODE_PATTERN, findEpisodeNeighbors } from '../episode';
import { adjustLine } from '../lineAdjust';
import { diffLines, LineChange, splitLines } from '../lineDiff';
import { extractEpisodeTitle, globToRegExp, isExcluded, looksLikeStory, naturalCompare, selectStoryFiles } from '../storyDetect';

type Plain = { kind: 'text'; text: string } | { kind: 'ruby'; base: string; rt: string };
const t = (text: string): Plain => ({ kind: 'text', text });
const r = (base: string, rt: string): Plain => ({ kind: 'ruby', base, rt });
/** 元位置の情報を除いた解析結果 */
const parse = (line: string, parentheses = false): Plain[] =>
  parseRubyLine(line, { parentheses }).map((s: Segment) => (s.kind === 'text' ? t(s.text) : r(s.base, s.rt)));

let failed = 0;
function test(name: string, fn: () => void): void {
  try {
    fn();
    console.log(`  ok  ${name}`);
  } catch (e) {
    failed++;
    console.error(`  NG  ${name}\n${(e as Error).message}`);
  }
}

console.log('ルビ解析');
test('縦棒(半角)+《》', () => assert.deepStrictEqual(parse('|東京《とうきょう》'), [r('東京', 'とうきょう')]));
test('縦棒(全角)+《》 前後に文字', () =>
  assert.deepStrictEqual(parse('僕は｜魔法使い《ウィザード》だ'), [t('僕は'), r('魔法使い', 'ウィザード'), t('だ')]));
test('縦棒でかな・英字にもルビ', () => assert.deepStrictEqual(parse('|あいつ《ヤツ》'), [r('あいつ', 'ヤツ')]));
test('縦棒省略: 直前の連続漢字', () =>
  assert.deepStrictEqual(parse('彼は漢字《かんじ》を書く'), [t('彼は'), r('漢字', 'かんじ'), t('を書く')]));
test('縦棒省略: 々を含む', () => assert.deepStrictEqual(parse('時々《ときどき》'), [r('時々', 'ときどき')]));
test('丸括弧: 既定ではルビにしない', () =>
  assert.deepStrictEqual(parse('漢字(かんじ)と漢字（カンジ）'), [t('漢字(かんじ)と漢字（カンジ）')]));
test('丸括弧: 既定では縦棒付きでもルビにしない', () => assert.deepStrictEqual(parse('|漢字（かんじ）'), [t('|漢字（かんじ）')]));
test('丸括弧: 既定でも《》はルビ', () =>
  assert.deepStrictEqual(parse('彼（かれ）は漢字《かんじ》'), [t('彼（かれ）は'), r('漢字', 'かんじ')]));
test('丸括弧(設定ON): かなのみならルビ', () =>
  assert.deepStrictEqual(parse('漢字(かんじ)と漢字（カンジ）', true), [r('漢字', 'かんじ'), t('と'), r('漢字', 'カンジ')]));
test('丸括弧(設定ON): かな以外は括弧書きのまま', () => assert.deepStrictEqual(parse('武器（剣）', true), [t('武器（剣）')]));
test('丸括弧(設定ON): 直前が漢字でなければそのまま', () => assert.deepStrictEqual(parse('そう（うん）', true), [t('そう（うん）')]));
test('《》: 漢字以外にはルビを振らない', () => assert.deepStrictEqual(parse('ひらがな《かな》'), [t('ひらがな《かな》')]));
test('エスケープ |《', () => assert.deepStrictEqual(parse('漢字|《かんじ》'), [t('漢字'), t('《'), t('かんじ》')]));
test('ルビ11文字以上はルビにしない', () =>
  assert.deepStrictEqual(parse('漢字《あいうえおかきくけこさ》'), [t('漢字《あいうえおかきくけこさ》')]));
test('ルビ10文字はルビ', () => assert.deepStrictEqual(parse('漢字《あいうえおかきくけこ》'), [r('漢字', 'あいうえおかきくけこ')]));
test('親文字21文字以上は縦棒ルビにしない', () => {
  const base = 'あ'.repeat(21);
  assert.deepStrictEqual(parse(`|${base}《る》`), [t(`|${base}《る》`)]);
});
test('空ルビはそのまま', () => assert.deepStrictEqual(parse('漢字《》'), [t('漢字《》')]));
test('閉じていない《', () => assert.deepStrictEqual(parse('漢字《かんじ'), [t('漢字《かんじ')]));
test('単独の縦棒はそのまま', () => assert.deepStrictEqual(parse('A|B'), [t('A|B')]));
test('サロゲートペアの漢字', () => assert.deepStrictEqual(parse('𠮷野《よしの》'), [r('𠮷野', 'よしの')]));
test('連続ルビ', () =>
  assert.deepStrictEqual(parse('|一《いち》二《に》'), [r('一', 'いち'), r('二', 'に')]));

test('元位置: 縦棒ルビ', () =>
  assert.deepStrictEqual(parseRubyLine('僕は|魔法《まほう》だ'), [
    { kind: 'text', text: '僕は', src: 0 },
    { kind: 'ruby', base: '魔法', rt: 'まほう', src: 2, baseSrc: 3, srcEnd: 10 },
    { kind: 'text', text: 'だ', src: 10 },
  ]));
test('元位置: 縦棒省略ルビ', () =>
  assert.deepStrictEqual(parseRubyLine('彼は漢字《かんじ》'), [
    { kind: 'text', text: '彼は', src: 0 },
    { kind: 'ruby', base: '漢字', rt: 'かんじ', src: 2, baseSrc: 2, srcEnd: 9 },
  ]));
test('元位置: エスケープ後', () =>
  assert.deepStrictEqual(parseRubyLine('a|《b'), [
    { kind: 'text', text: 'a', src: 0 },
    { kind: 'text', text: '《', src: 2 },
    { kind: 'text', text: 'b', src: 3 },
  ]));
test('元位置: サロゲートペアは UTF-16 単位', () =>
  assert.deepStrictEqual(parseRubyLine('𠮷野《よしの》だ')[1], { kind: 'text', text: 'だ', src: 8 }));

console.log('色分け');
const opts = {
  brackets: [
    { styleId: 1, pairs: [['「', '」']] as Array<[string, string]> },
    { styleId: 2, pairs: [['（', '）']] as Array<[string, string]> },
    { styleId: 3, pairs: [['『', '』']] as Array<[string, string]> },
  ],
  numberStyleId: 4,
  regexes: [],
};
const kanjiNumber = { counters: '人歳年月日時段円話', prefixes: '第約' };
const styleStr = (s: string) => Array.from(computeStyles(s, opts)).join('');
test('会話', () => assert.strictEqual(styleStr('a「bc」d'), '011110'));
test('入れ子は内側優先', () => assert.strictEqual(styleStr('「a『b』c」'), '1133311'));
test('数字は括弧より優先', () => assert.strictEqual(styleStr('「12個」'), '14411'));
test('漢数字(既定では対象外)', () => assert.strictEqual(styleStr('二十一'), '000'));
test('漢数字を含める', () =>
  assert.strictEqual(
    Array.from(computeStyles('二十一歳と3万円、〇時', { ...opts, kanjiNumber })).join(''),
    '44400440040',
  ));
const kanjiStr = (s: string) => Array.from(computeStyles(s, { ...opts, kanjiNumber })).join('');
test('漢数字: 熟語の一部は除外', () => {
  assert.strictEqual(kanjiStr('統一'), '00');
  assert.strictEqual(kanjiStr('一緒に'), '000');
  assert.strictEqual(kanjiStr('九州'), '00');
  assert.strictEqual(kanjiStr('八百屋'), '000');
  assert.strictEqual(kanjiStr('唯一の'), '000');
});
test('漢数字: 数として使われるもの', () => {
  assert.strictEqual(kanjiStr('三人'), '40');
  assert.strictEqual(kanjiStr('一つ'), '40');
  assert.strictEqual(kanjiStr('第三話'), '040');
  assert.strictEqual(kanjiStr('約五十人'), '0440');
  assert.strictEqual(kanjiStr('は三百。'), '0440');
  assert.strictEqual(kanjiStr('一ヶ月'), '400');
});
test('漢数字: 算用数字は前後に関係なく色付け', () => assert.strictEqual(kanjiStr('統3緒'), '040'));
test('漢数字: サロゲートペアの漢字の直後', () => assert.strictEqual(kanjiStr('𠮷一'), '000'));
test('閉じていない括弧は塗らない', () => assert.strictEqual(styleStr('「abc'), '0000'));
test('複数行にまたがる会話', () => assert.strictEqual(styleStr('「a\nb」'), '11111'));
test('正規表現ルールが最優先', () =>
  assert.strictEqual(
    Array.from(computeStyles('「魔王だ」', { ...opts, regexes: [{ styleId: 5, regex: /魔王/g }] })).join(''),
    '15511',
  ));

console.log('レンダリング');
const baseConfig = {
  charsPerLine: 40,
  fontFamily: '',
  fontSize: 16,
  lineHeight: 1.8,
  lineNumbers: true,
  rubyEnabled: true,
  rubyParentheses: false,
  highlightEnabled: true,
  dialogue: { enabled: true, color: 'green', brackets: ['「」'] },
  thought: { enabled: true, color: 'skyblue', brackets: ['（）', '()'] },
  quote: { enabled: true, color: 'yellow', brackets: ['『』'] },
  number: { enabled: true, color: 'orange', includeKanji: true, kanjiCounters: '人', kanjiPrefixes: '第' },
  customRules: [],
};
test('ルビ付き会話', () => {
  const { html } = render('「|東京《とうきょう》へ」', baseConfig);
  assert.strictEqual(
    html,
    '<p class="line" data-line="0" data-n="1"><span data-c="0" class="s1">「</span><span class="s1"><ruby data-s="1" data-e="11"><span data-c="2">東京</span><rp>《</rp><rt>とうきょう</rt><rp>》</rp></ruby></span><span data-c="11" class="s1">へ」</span></p>',
  );
});
test('HTML エスケープ', () => {
  const { html } = render('<b>&', { ...baseConfig, highlightEnabled: false });
  assert.strictEqual(html, '<p class="line" data-line="0" data-n="1"><span data-c="0">&#60;b&#62;&#38;</span></p>');
});
test('丸括弧は既定では内心の色', () => {
  const { html } = render('彼（かれ）', baseConfig);
  assert.ok(html.includes('class="s2">（かれ）'), html);
});
test('丸括弧(設定ON)のルビは内心の色にならない', () => {
  const { html } = render('彼（かれ）', { ...baseConfig, rubyParentheses: true });
  assert.ok(!html.includes('s2') && html.includes('<rt>かれ</rt>'), html);
});
test('不正な正規表現は警告', () => {
  const { warnings } = render('abc', { ...baseConfig, customRules: [{ pattern: '(', color: 'red' }] });
  assert.strictEqual(warnings.length, 1);
});
test('無効化したグループは色を付けない', () => {
  const { html, css } = render('「a」', { ...baseConfig, dialogue: { ...baseConfig.dialogue, enabled: false } });
  assert.ok(!html.includes('s1') && !css.includes('.s1'), html);
});
test('CSS インジェクション対策', () => {
  const { css } = render('1', { ...baseConfig, number: { enabled: true, color: 'red; } body { display:none', includeKanji: false, kanjiCounters: '', kanjiPrefixes: '' } });
  assert.ok(!/body\s*\{/.test(css), css);
});

console.log('文字数');
test('ルビを除く', () => assert.strictEqual(countChars('|東京《とうきょう》へ行く'), 5));
test('縦棒省略のルビも除く', () => assert.strictEqual(countChars('漢字《かんじ》と'), 3));
test('丸括弧は既定では括弧書きとして数える', () => assert.strictEqual(countChars('漢字(かんじ)'), 7));
test('丸括弧(設定ON)はルビとして除く', () => assert.strictEqual(countChars('漢字(かんじ)', { parentheses: true }), 2));
test('ルビでない括弧は数える', () => assert.strictEqual(countChars('武器（剣）'), 5));
test('エスケープの | は数えない', () => assert.strictEqual(countChars('|《あ》'), 3));
test('改行（CRLF・LF・CR）は数えない', () => assert.strictEqual(countChars('あ\r\nい\nう\rえ\r\n'), 4));
test('サロゲートペアは 1 文字', () => assert.strictEqual(countChars('𠮷野家'), 3));
test('空白（全角・半角・タブ）は数えない', () => assert.strictEqual(countChars('　あ い\tう'), 3));
test('空白だけの行', () => assert.strictEqual(countChars('　　\n\n'), 0));
test('ルビ内の空白も数えない', () => assert.strictEqual(countChars('|A B《エービー》'), 2));
test('空', () => assert.strictEqual(countChars(''), 0));

console.log('前話・次話');
const epRe = new RegExp(DEFAULT_EPISODE_PATTERN);
test('連番（ゼロ埋め・タイトル違い）', () =>
  assert.deepStrictEqual(
    findEpisodeNeighbors('002_旅立ち.txt', ['001_出会い.txt', '002_旅立ち.txt', '003_決戦.txt', 'memo.txt'], epRe),
    { prev: '001_出会い.txt', next: '003_決戦.txt' },
  ));
test('番号が飛んでいる場合は最も近い番号', () =>
  assert.deepStrictEqual(findEpisodeNeighbors('第5話.txt', ['第1話.txt', '第3話.txt', '第5話.txt', '第9話.txt', '第10話.txt'], epRe), {
    prev: '第3話.txt',
    next: '第9話.txt',
  }));
test('全角数字', () =>
  assert.deepStrictEqual(findEpisodeNeighbors('第２話.txt', ['第１話.txt', '第２話.txt', '第３話.txt'], epRe), {
    prev: '第１話.txt',
    next: '第３話.txt',
  }));
test('番号より前が違うファイルは対象外', () =>
  assert.deepStrictEqual(findEpisodeNeighbors('本編2.txt', ['本編1.txt', '外伝1.txt', '外伝3.txt', '本編2.txt'], epRe), {
    prev: '本編1.txt',
    next: undefined,
  }));
test('最初・最後の話', () =>
  assert.deepStrictEqual(findEpisodeNeighbors('ep1.txt', ['ep1.txt', 'ep2.txt'], epRe), { prev: undefined, next: 'ep2.txt' }));
test('番号の無いファイル', () => assert.deepStrictEqual(findEpisodeNeighbors('あとがき.txt', ['ep1.txt'], epRe), {}));
test('キャプチャグループ指定（最後の数字以外を番号にする）', () =>
  assert.deepStrictEqual(
    findEpisodeNeighbors('第2話_その1.txt', ['第1話_その1.txt', '第2話_その1.txt', '第2話_その2.txt', '第3話_その1.txt'], /第([0-9]+)話/),
    { prev: '第1話_その1.txt', next: '第3話_その1.txt' },
  ));

console.log('物語ファイル');
test('ルビがあれば物語', () => assert.ok(looksLikeStory('王都《おうと》')));
test('会話文 2 つで物語', () => assert.ok(looksLikeStory('「はい」\n「いいえ」')));
test('字下げ 3 行で物語', () => assert.ok(looksLikeStory('　あ\n　い\n　う')));
test('会話文と字下げ 1 つずつで物語', () => assert.ok(looksLikeStory('　彼は言った。\n「やあ」')));
test('心の声と字下げで物語', () => assert.ok(looksLikeStory('　第２話\n\n（道に迷ったかな……）\n　森は深い。')));
test('文中の丸括弧だけでは物語にならない', () => assert.ok(!looksLikeStory('価格（税込）\n送料（別途）')));
test('英文・設定ファイルは物語でない', () => {
  assert.ok(!looksLikeStory('This is a README.\nInstall with npm.'));
  assert.ok(!looksLikeStory('requests==2.0\nnumpy>=1.0'));
  assert.ok(!looksLikeStory('メモ：「牛乳」を買う'));
});
test('フォルダー単位: コードのプロジェクト内のサンプルフォルダー', () =>
  assert.deepStrictEqual(
    selectStoryFiles(
      ['package.json', 'notes.txt', 'src/a.ts', 'sample/sample.txt', 'sample/episodes/第01話.txt', 'sample/episodes/第02話.txt'],
      ['sample/sample.txt'],
    ),
    ['sample/sample.txt', 'sample/episodes/第01話.txt', 'sample/episodes/第02話.txt'],
  ));
test('フォルダー単位: 章ごとの階層は親まで広げる', () =>
  assert.deepStrictEqual(
    selectStoryFiles(['README.md', 'novel/ch1/01.txt', 'novel/ch2/02.txt', 'novel/ch2/03.txt', 'tools/log.txt', 'tools/x.js'], [
      'novel/ch1/01.txt',
    ]),
    ['novel/ch1/01.txt', 'novel/ch2/02.txt', 'novel/ch2/03.txt'],
  ));
test('フォルダー単位: 検知先に他の種類のファイルがあっても直下の .txt は対象、混在したサブフォルダーは対象外', () =>
  assert.deepStrictEqual(
    selectStoryFiles(
      ['novel/設定.md', 'novel/01.txt', 'novel/02.txt', 'novel/ch/03.txt', 'novel/資料/年表.txt', 'novel/資料/図.png'],
      ['novel/01.txt'],
    ),
    ['novel/01.txt', 'novel/02.txt', 'novel/ch/03.txt'],
  ));
test('フォルダー単位: 小説だけのワークスペースは全体', () =>
  assert.deepStrictEqual(selectStoryFiles(['a.txt', 'b/c.txt', 'b/.DS_Store', 'desktop.ini'], ['b/c.txt']), ['a.txt', 'b/c.txt']));
test('フォルダー単位: 検知が無ければ何も選ばない', () => assert.deepStrictEqual(selectStoryFiles(['a.txt', 'b.ts'], []), []));
test('glob: **/node_modules/**', () => {
  const re = globToRegExp('**/node_modules/**');
  assert.ok(re.test('node_modules/'));
  assert.ok(re.test('a/node_modules/b/c.txt'));
  assert.ok(!re.test('a/node_modulesx/c.txt'));
});
test('glob: * と ?', () => {
  assert.ok(globToRegExp('**/memo*.txt').test('a/memo01.txt'));
  assert.ok(globToRegExp('*.txt').test('readme.txt'));
  assert.ok(!globToRegExp('*.txt').test('a/readme.txt'));
  assert.ok(globToRegExp('ep?.txt').test('ep1.txt'));
  assert.ok(!globToRegExp('ep?.txt').test('ep10.txt'));
});
test('glob: 記号のエスケープ', () => assert.ok(globToRegExp('(下書き)/**').test('(下書き)/a.txt')));
test('除外判定', () => assert.ok(isExcluded('a/.git/', [globToRegExp('**/.git/**')])));
test('タイトル: 全角スペース区切り', () => assert.strictEqual(extractEpisodeTitle('　第１話　旅立ち\n\n本文'), '旅立ち'));
test('タイトル: 半角数字・半角スペース', () => assert.strictEqual(extractEpisodeTitle('第12話 森の中で\r\n本文'), '森の中で'));
test('タイトル: 漢数字・コロン区切り', () => assert.strictEqual(extractEpisodeTitle('第二十三話：決戦'), '決戦'));
test('タイトル: 先頭の空行・BOM を飛ばす', () => assert.strictEqual(extractEpisodeTitle('﻿\n\n第3話　再会'), '再会'));
test('タイトル: ルビ記法はそのまま残す', () =>
  assert.strictEqual(extractEpisodeTitle('第1話　|魔法使い《ウィザード》の弟子'), '|魔法使い《ウィザード》の弟子'));
test('タイトル: 第〇話で始まらなければ無し', () => {
  assert.strictEqual(extractEpisodeTitle('「行ってきます」\n本文'), undefined);
  assert.strictEqual(extractEpisodeTitle('プロローグ'), undefined);
});
test('タイトル: 話数だけなら無し', () => assert.strictEqual(extractEpisodeTitle('第4話\n本文'), undefined));
test('番号順の並び', () =>
  assert.deepStrictEqual(['第10話.txt', '第2話.txt', '第１話.txt'].sort(naturalCompare), ['第１話.txt', '第2話.txt', '第10話.txt']));

console.log('ブックマークの行補正');
const edit = (startLine: number, startCharacter: number, endLine: number, isEmpty: boolean, newlines: number) => ({
  startLine,
  startCharacter,
  endLine,
  isEmpty,
  newlines,
});
test('前の行に改行を挿入すると下へずれる', () => assert.strictEqual(adjustLine(10, edit(3, 5, 3, true, 2)), 12));
test('前の行を削除すると上へずれる', () => assert.strictEqual(adjustLine(10, edit(3, 0, 5, false, 0)), 8));
test('後ろの行の編集では変わらない', () => assert.strictEqual(adjustLine(10, edit(12, 0, 15, false, 0)), 10));
test('同じ行の途中の編集では変わらない', () => assert.strictEqual(adjustLine(10, edit(10, 4, 10, false, 0)), 10));
test('行頭に改行を挿入すると文章と一緒に下へ', () => assert.strictEqual(adjustLine(10, edit(10, 0, 10, true, 1)), 11));
test('行末に改行を挿入しても変わらない', () => assert.strictEqual(adjustLine(10, edit(10, 20, 10, true, 1)), 10));
test('ブックマーク行を含む範囲の削除は範囲の先頭へ', () => assert.strictEqual(adjustLine(10, edit(8, 3, 12, false, 0)), 8));

console.log('\n変更行（Git の差分）');
const diff = (before: string, after: string): LineChange[] => diffLines(splitLines(before), splitLines(after));
test('変更なし', () => assert.deepStrictEqual(diff('a\nb\nc', 'a\nb\nc'), []));
test('行の変更', () => assert.deepStrictEqual(diff('a\nb\nc', 'a\nB\nc'), [{ type: 'modified', start: 1, end: 2 }]));
test('行の追加', () => assert.deepStrictEqual(diff('a\nc', 'a\nb1\nb2\nc'), [{ type: 'added', start: 1, end: 3 }]));
test('行の削除', () => assert.deepStrictEqual(diff('a\nb\nc', 'a\nc'), [{ type: 'deleted', start: 1, end: 1 }]));
test('末尾の行の削除', () => assert.deepStrictEqual(diff('a\nb\nc', 'a\nb'), [{ type: 'deleted', start: 2, end: 2 }]));
test('先頭への追加', () => assert.deepStrictEqual(diff('a\nb', 'x\na\nb'), [{ type: 'added', start: 0, end: 1 }]));
test('改行コードの違いは無視', () => assert.deepStrictEqual(diff('a\r\nb\r\n', 'a\nb\n'), []));
test('離れた複数の変更', () =>
  assert.deepStrictEqual(diff('1\n2\n3\n4\n5\n6\n7', '1\nX\n3\n4\n5\n7\n8'), [
    { type: 'modified', start: 1, end: 2 },
    { type: 'deleted', start: 5, end: 5 },
    { type: 'added', start: 6, end: 7 },
  ]));
test('削除と追加が隣り合うと変更', () =>
  assert.deepStrictEqual(diff('a\nb\nc\nd', 'a\nX\nY\nZ\nd'), [{ type: 'modified', start: 1, end: 4 }]));
test('一致行を挟んだ変更は別々', () =>
  assert.deepStrictEqual(diff('a\nb\nc\nd\ne', 'a\nB\nc\nD\ne'), [
    { type: 'modified', start: 1, end: 2 },
    { type: 'modified', start: 3, end: 4 },
  ]));
test('差分が大きすぎるときは全体を変更とみなす', () =>
  assert.deepStrictEqual(diffLines(['a', 'b', 'c', 'd'], ['a', 'x', 'c', 'y'], 1), [{ type: 'modified', start: 1, end: 4 }]));

if (failed > 0) {
  console.error(`\n${failed} 件失敗`);
  process.exit(1);
}
console.log('\nすべて成功');
