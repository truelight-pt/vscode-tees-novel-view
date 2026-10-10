/**
 * 物語ファイルの判定と一覧表示用のユーティリティ。
 * vscode に依存しない純粋なロジックのみを置く（単体テスト可能にするため）。
 */

/**
 * テキストが小説らしいかを判定する（先頭の一部だけを渡せばよい）。
 * - ルビ《》がある
 * - 会話文「」『』・心の声（行頭の（…））が 2 つ以上ある
 * - 全角スペースで字下げした行が 3 行以上ある
 * - 会話文・心の声と字下げがそれぞれ 1 つ以上ある
 */
export function looksLikeStory(text: string): boolean {
  if (/《[^《》\r\n]{1,10}》/.test(text)) {
    return true;
  }
  const dialogue =
    (text.match(/「[^「」\r\n]*」|『[^『』\r\n]*』/g) ?? []).length + (text.match(/^（[^（）\r\n]*）\s*$/gm) ?? []).length;
  const indented = (text.match(/^　/gm) ?? []).length;
  return dialogue >= 2 || indented >= 3 || (dialogue >= 1 && indented >= 1);
}

/** フォルダーの「純粋さ」の判定で無視するファイル（OS やツールが自動で作るもの） */
function isIgnorableFile(name: string): boolean {
  return name.startsWith('.') || /^(desktop\.ini|thumbs\.db)$/i.test(name);
}

const dirOf = (rel: string) => (rel.includes('/') ? rel.slice(0, rel.lastIndexOf('/')) : '');
const isTxtName = (rel: string) => /\.txt$/i.test(rel);
const isUnder = (dir: string, folder: string) => folder === '' || dir === folder || dir.startsWith(`${folder}/`);

/**
 * 「物語ファイルは他のファイルと分けて 1 か所にまとめられている」前提で、物語ファイルを選ぶ。
 *
 * 1. 物語と判定されたファイルのフォルダーを検知先とする
 * 2. 親フォルダーの中身（サブフォルダーを含む）が .txt だけなら、親も検知先に含める（階層化への対応）
 * 3. 検知先に直接ある .txt と、検知先の下の「.txt だけのフォルダー」にある .txt をすべて物語ファイルとする
 *
 * @param allFiles 探索範囲のすべてのファイル（ルートからの相対パス。.txt 以外も含む）
 * @param detected 内容から物語と判定された .txt
 * @returns 物語ファイルとして扱う .txt
 */
export function selectStoryFiles(allFiles: string[], detected: string[]): string[] {
  // .txt 以外のファイルを含むフォルダー（祖先も含む）
  const impure = new Set<string>();
  for (const file of allFiles) {
    const name = file.slice(file.lastIndexOf('/') + 1);
    if (isTxtName(file) || isIgnorableFile(name)) {
      continue;
    }
    let dir = dirOf(file);
    for (;;) {
      impure.add(dir);
      if (dir === '') {
        break;
      }
      dir = dirOf(dir);
    }
  }

  const folders = new Set<string>();
  for (const file of detected) {
    let dir = dirOf(file);
    while (dir !== '' && !impure.has(dirOf(dir))) {
      dir = dirOf(dir);
    }
    folders.add(dir);
  }

  const result = new Set(detected);
  for (const file of allFiles) {
    if (!isTxtName(file)) {
      continue;
    }
    const dir = dirOf(file);
    for (const folder of folders) {
      // 検知先の直下、または検知先の下にある .txt だけのフォルダー
      if (dir === folder || (isUnder(dir, folder) && !impure.has(dir))) {
        result.add(file);
        break;
      }
    }
  }
  return allFiles.filter((f) => result.has(f));
}

/** 「第〇話」と、その後の区切り（空白・コロンなど） */
const EPISODE_HEADING = /^第[0-9０-９〇零一二三四五六七八九十百千万]+話[\s　:：・\-－―]*/;

/**
 * ファイルの先頭の「第〇話　タイトル」から、話数を除いたタイトルを取り出す。
 * 最初の空でない行が「第〇話」で始まらない場合は undefined（本文の 1 行目を誤ってタイトルにしないため）。
 * 一覧でルビも含めてタイトルを確認できるよう、ルビ記法はそのまま残す。
 */
export function extractEpisodeTitle(text: string): string | undefined {
  const first = text
    .replace(/^﻿/, '')
    .split(/\r\n|\r|\n/)
    .map((l) => l.replace(/^[\s　]+|[\s　]+$/g, ''))
    .find((l) => l.length > 0);
  if (!first || !EPISODE_HEADING.test(first)) {
    return undefined;
  }
  return first.replace(EPISODE_HEADING, '') || undefined;
}

/**
 * 簡易 glob を正規表現に変換する。対象はルートからの相対パス（区切りは /）。
 * - `**` 任意の階層（`**\/` は 0 階層以上のフォルダー）
 * - `*` 区切りを含まない任意の文字列
 * - `?` 区切り以外の 1 文字
 */
export function globToRegExp(glob: string): RegExp {
  let re = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === '*') {
      if (glob[i + 1] === '*') {
        if (glob[i + 2] === '/') {
          re += '(?:.*/)?';
          i += 2;
        } else {
          re += '.*';
          i += 1;
        }
      } else {
        re += '[^/]*';
      }
    } else if (c === '?') {
      re += '[^/]';
    } else {
      re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
    }
  }
  return new RegExp(`^${re}$`, 'i');
}

/** 除外パターンのいずれかに一致するか。フォルダーは末尾に / を付けて渡す */
export function isExcluded(relativePath: string, patterns: RegExp[]): boolean {
  return patterns.some((p) => p.test(relativePath));
}

/** 番号を数値として比較する並び順（第2話 < 第10話）。全角数字も数値として扱う */
export function naturalCompare(a: string, b: string): number {
  const norm = (s: string) => s.replace(/[０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0));
  return norm(a).localeCompare(norm(b), 'ja', { numeric: true, sensitivity: 'base' });
}
