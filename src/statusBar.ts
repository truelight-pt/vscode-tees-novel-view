import * as vscode from 'vscode';
import { countChars } from './parser';
import { isTxt, PreviewManager } from './preview';

const formatNumber = (n: number) => n.toLocaleString('en-US');

/**
 * ステータスバーの表示。
 * - 左: ファイルの文字数（ルビ・改行・空白を除く）。小説ビューまたは .txt のエディターがアクティブなとき
 * - 左（文字数の右）: 物語ファイル一覧で複数選択した物語の合計文字数
 * - 右: 小説ビューのカーソルがある行（元テキストの行番号）。小説ビューがアクティブなとき
 */
export class NovelStatusBar implements vscode.Disposable {
  private readonly charItem = vscode.window.createStatusBarItem('teesNovelView.charCount', vscode.StatusBarAlignment.Left, 100);
  // 左寄せの項目は優先度が低いほど右に並ぶので、文字数のすぐ右になる
  private readonly totalItem = vscode.window.createStatusBarItem('teesNovelView.selectionCharCount', vscode.StatusBarAlignment.Left, 99);
  private readonly lineItem = vscode.window.createStatusBarItem('teesNovelView.caretLine', vscode.StatusBarAlignment.Right, 100);
  private readonly disposables: vscode.Disposable[] = [];
  /** 文字数のキャッシュ（ドキュメントのバージョンが変わるまで再計算しない） */
  private readonly counts = new Map<string, { version: number; count: number }>();
  private timer: NodeJS.Timeout | undefined;

  constructor(private readonly manager: PreviewManager) {
    this.charItem.name = 'Novel View: 文字数';
    this.charItem.tooltip = 'ルビ・改行・空白を除いた文字数';
    this.totalItem.name = 'Novel View: 選択した物語の合計文字数';
    this.totalItem.tooltip = '物語ファイル一覧で選択したファイルの、ルビ・改行・空白を除いた文字数の合計（保存済みの内容）';
    this.lineItem.name = 'Novel View: カーソル行';
    this.lineItem.tooltip = '小説ビューのカーソルがある行';

    const refresh = () => this.scheduleRefresh();
    this.disposables.push(
      this.charItem,
      this.totalItem,
      this.lineItem,
      manager.onDidChangeState(refresh),
      vscode.window.onDidChangeActiveTextEditor(refresh),
      vscode.workspace.onDidChangeTextDocument((e) => {
        if (isTxt(e.document.uri)) {
          refresh();
        }
      }),
      vscode.workspace.onDidCloseTextDocument((doc) => this.counts.delete(doc.uri.toString())),
      vscode.workspace.onDidChangeConfiguration((e) => {
        if (e.affectsConfiguration('teesNovelView.ruby.parentheses')) {
          this.counts.clear();
          refresh();
        }
      }),
    );
    this.scheduleRefresh();
  }

  /** 物語ファイル一覧の選択の合計を表示する。onDidChange が来るたびに表示を更新する */
  setSelectionTotal(total: () => { files: number; chars: number } | undefined, onDidChange: vscode.Event<void>): void {
    const update = () => {
      const t = total();
      if (t) {
        this.totalItem.text = `合計: ${formatNumber(t.chars)}（${formatNumber(t.files)} ファイル）`;
        this.totalItem.show();
      } else {
        this.totalItem.hide();
      }
    };
    this.disposables.push(onDidChange(update));
    update();
  }

  private scheduleRefresh(): void {
    if (this.timer) {
      clearTimeout(this.timer);
    }
    this.timer = setTimeout(() => {
      this.timer = undefined;
      void this.refresh();
    }, 150);
  }

  private async refresh(): Promise<void> {
    const preview = this.manager.activePreview;
    let doc: vscode.TextDocument | undefined;
    if (preview) {
      try {
        doc = await vscode.workspace.openTextDocument(preview.uri);
      } catch {
        doc = undefined;
      }
    } else {
      const editor = vscode.window.activeTextEditor;
      doc = editor && isTxt(editor.document.uri) ? editor.document : undefined;
    }

    if (doc) {
      this.charItem.text = `文字数: ${formatNumber(this.count(doc))}`;
      this.charItem.show();
    } else {
      this.charItem.hide();
    }

    const line = preview?.selection?.active.line;
    if (preview && line !== undefined) {
      this.lineItem.text = `行: ${formatNumber(line + 1)}`;
      this.lineItem.show();
    } else {
      this.lineItem.hide();
    }
  }

  private count(doc: vscode.TextDocument): number {
    const key = doc.uri.toString();
    const cached = this.counts.get(key);
    if (cached && cached.version === doc.version) {
      return cached.count;
    }
    const parentheses = vscode.workspace.getConfiguration('teesNovelView').get<boolean>('ruby.parentheses', false);
    const count = countChars(doc.getText(), { parentheses });
    this.counts.set(key, { version: doc.version, count });
    return count;
  }

  dispose(): void {
    if (this.timer) {
      clearTimeout(this.timer);
    }
    this.disposables.forEach((d) => d.dispose());
  }
}
