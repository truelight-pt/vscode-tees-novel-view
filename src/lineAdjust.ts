/**
 * 編集に合わせた行番号の補正（ブックマーク用）。
 * vscode に依存しない純粋なロジックのみを置く（単体テスト可能にするため）。
 */

/** 1 回の編集の情報 */
export interface LineEdit {
  startLine: number;
  startCharacter: number;
  endLine: number;
  /** 置き換え範囲が空（純粋な挿入）か */
  isEmpty: boolean;
  /** 挿入されたテキストに含まれる改行の数 */
  newlines: number;
}

/**
 * 編集に合わせて行番号を補正する。
 * - 編集範囲より後ろの行: 増減した行数だけずらす
 * - 編集範囲内の行: 置き換え後の範囲に収める
 * - 行頭への挿入（改行を含む）: その行の文章が下に移動するので、行番号も下へ
 */
export function adjustLine(line: number, edit: LineEdit): number {
  const delta = edit.newlines - (edit.endLine - edit.startLine);
  if (line > edit.endLine) {
    return line + delta;
  }
  if (line === edit.startLine && edit.isEmpty && edit.startCharacter === 0) {
    return line + edit.newlines;
  }
  if (line > edit.startLine) {
    return Math.min(line, edit.startLine + edit.newlines);
  }
  return line;
}
