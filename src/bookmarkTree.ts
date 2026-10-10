import * as vscode from 'vscode';
import * as path from 'path';
import { Bookmark, BookmarkStore } from './bookmarks';
import { parseRubyLine } from './parser';
import { PreviewManager } from './preview';
import { naturalCompare } from './storyDetect';

export const BOOKMARK_VIEW_ID = 'teesNovelView.bookmarks';

const formatNumber = (n: number) => n.toLocaleString('en-US');
/** 名前の初期値に使う行の冒頭の文字数 */
const DEFAULT_NAME_LENGTH = 20;

type BookmarkNode = { kind: 'file'; uri: string; bookmarks: Bookmark[] } | { kind: 'bookmark'; bookmark: Bookmark };

/** 一覧でのファイルの並び順（パスの番号順） */
function compareUri(a: string, b: string): number {
  return a === b ? 0 : naturalCompare(decodeURIComponent(a), decodeURIComponent(b));
}

/** 一覧と同じ並び順（ファイル順 → 行順） */
function sortBookmarks(list: Bookmark[]): Bookmark[] {
  return [...list].sort((a, b) => compareUri(a.uri, b.uri) || a.line - b.line);
}

/**
 * 行の文章（ルビを除く）の冒頭を、ブックマーク名の初期値にする。
 * 行番号は編集でずれるため名前には含めず、一覧の表示で名前の前に付ける。
 */
function defaultName(lineText: string): string {
  const text = parseRubyLine(lineText)
    .map((s) => (s.kind === 'text' ? s.text : s.base))
    .join('')
    .replace(/^[\s　]+|[\s　]+$/g, '');
  const chars = Array.from(text);
  return !text ? '（空行）' : chars.length > DEFAULT_NAME_LENGTH ? `${chars.slice(0, DEFAULT_NAME_LENGTH).join('')}…` : text;
}

export class BookmarkTreeProvider implements vscode.TreeDataProvider<BookmarkNode>, vscode.Disposable {
  private readonly changeEmitter = new vscode.EventEmitter<BookmarkNode | undefined>();
  readonly onDidChangeTreeData = this.changeEmitter.event;
  private readonly disposables: vscode.Disposable[] = [];

  constructor(
    private readonly store: BookmarkStore,
    private readonly manager: PreviewManager,
  ) {
    const treeView = vscode.window.createTreeView(BOOKMARK_VIEW_ID, { treeDataProvider: this, showCollapseAll: true });
    this.disposables.push(
      treeView,
      this.changeEmitter,
      store.onDidChange(() => this.changeEmitter.fire(undefined)),
      vscode.commands.registerCommand('teesNovelView.toggleBookmark', () => this.toggleBookmark()),
      vscode.commands.registerCommand('teesNovelView.openBookmark', (id: string) => this.openBookmark(id)),
      vscode.commands.registerCommand('teesNovelView.renameBookmark', (node?: BookmarkNode) => this.renameBookmark(node)),
      vscode.commands.registerCommand('teesNovelView.removeBookmark', (node?: BookmarkNode) => this.removeBookmark(node)),
      vscode.commands.registerCommand('teesNovelView.clearBookmarks', () => this.clearBookmarks()),
      vscode.commands.registerCommand('teesNovelView.enableCrossFileBookmarks', () => this.setCrossFile(true)),
      vscode.commands.registerCommand('teesNovelView.disableCrossFileBookmarks', () => this.setCrossFile(false)),
      vscode.commands.registerCommand('teesNovelView.nextBookmark', () => this.jumpBookmark(1)),
      vscode.commands.registerCommand('teesNovelView.previousBookmark', () => this.jumpBookmark(-1)),
    );
    this.updateContext();
    this.disposables.push(store.onDidChange(() => this.updateContext()));
  }

  private updateContext(): void {
    void vscode.commands.executeCommand('setContext', 'teesNovelView.hasBookmarks', this.store.all().length > 0);
  }

  // --- TreeDataProvider ---------------------------------------------------

  getTreeItem(node: BookmarkNode): vscode.TreeItem {
    if (node.kind === 'file') {
      const uri = vscode.Uri.parse(node.uri);
      const item = new vscode.TreeItem(path.posix.basename(uri.path).replace(/\.txt$/i, ''), vscode.TreeItemCollapsibleState.Expanded);
      item.iconPath = new vscode.ThemeIcon('book');
      // Git の変更状態などの色と記号を付ける
      item.resourceUri = uri;
      // 同名ファイルを見分けられるよう、フォルダーを表示する
      item.description = vscode.workspace.asRelativePath(uri.with({ path: path.posix.dirname(uri.path) }), false);
      item.tooltip = uri.fsPath;
      item.id = `file:${node.uri}`;
      return item;
    }
    const b = node.bookmark;
    // 行番号（編集に合わせて常に最新）を名前の前に表示する
    const item = new vscode.TreeItem(`${formatNumber(b.line + 1)}: ${b.name}`, vscode.TreeItemCollapsibleState.None);
    item.iconPath = new vscode.ThemeIcon('bookmark', new vscode.ThemeColor('charts.blue'));
    item.tooltip = `${b.name}（${formatNumber(b.line + 1)} 行目）`;
    item.id = `bookmark:${b.id}`;
    item.contextValue = 'bookmark';
    item.command = { command: 'teesNovelView.openBookmark', title: 'ブックマークへ移動', arguments: [b.id] };
    return item;
  }

  getChildren(node?: BookmarkNode): BookmarkNode[] {
    if (!node) {
      const byFile = new Map<string, Bookmark[]>();
      for (const b of this.store.all()) {
        byFile.set(b.uri, [...(byFile.get(b.uri) ?? []), b]);
      }
      return [...byFile.entries()]
        .sort(([a], [b]) => compareUri(a, b))
        .map(([uri, bookmarks]) => ({ kind: 'file', uri, bookmarks: bookmarks.sort((x, y) => x.line - y.line) }));
    }
    return node.kind === 'file' ? node.bookmarks.map((bookmark) => ({ kind: 'bookmark', bookmark })) : [];
  }

  // --- コマンド -----------------------------------------------------------

  /** 小説ビューのカーソル行のブックマークを追加・削除する */
  private async toggleBookmark(): Promise<void> {
    const preview = this.manager.activePreview ?? this.manager.editorPreview;
    if (!preview) {
      void vscode.window.showInformationMessage('ブックマークは小説ビューで追加できます。');
      return;
    }
    const line = preview.selection?.active.line ?? preview.topLine;
    const existing = this.store.findAt(preview.uri, line);
    if (existing) {
      this.store.remove(existing.id);
      vscode.window.setStatusBarMessage(`ブックマーク「${existing.name}」を削除しました`, 3000);
      return;
    }
    // 名前は入力させず初期値で登録する（変更は一覧の「名前を変更」から）
    const doc = await vscode.workspace.openTextDocument(preview.uri);
    const lineText = line < doc.lineCount ? doc.lineAt(line).text : '';
    const added = this.store.add(preview.uri, line, defaultName(lineText));
    vscode.window.setStatusBarMessage(`ブックマーク「${added.name}」を追加しました`, 3000);
  }

  /**
   * カーソル行の次（direction = 1）・前（-1）のブックマークへ移動する。端まで来たら反対側の端に戻る。
   * 設定 bookmarks.crossFile が ON なら、一覧の並び順でファイルをまたいで移動する。
   */
  private async jumpBookmark(direction: 1 | -1): Promise<void> {
    const preview = this.manager.activePreview ?? this.manager.editorPreview;
    if (!preview) {
      return;
    }
    const crossFile = vscode.workspace.getConfiguration('teesNovelView').get<boolean>('bookmarks.crossFile', false);
    const list = crossFile ? sortBookmarks(this.store.all()) : this.store.forFile(preview.uri);
    if (list.length === 0) {
      vscode.window.setStatusBarMessage(crossFile ? 'ブックマークがありません' : 'このファイルにはブックマークがありません', 3000);
      return;
    }
    // 現在位置（ファイル + カーソル行）と各ブックマークの前後を、一覧と同じ並び順で比べる
    const here = { uri: preview.key, line: preview.selection?.active.line ?? preview.topLine };
    const compare = (b: Bookmark) => compareUri(b.uri, here.uri) || b.line - here.line;
    const target =
      direction > 0
        ? (list.find((b) => compare(b) > 0) ?? list[0])
        : ([...list].reverse().find((b) => compare(b) < 0) ?? list[list.length - 1]);

    const caret = { anchor: { line: target.line, col: 0 }, active: { line: target.line, col: 0 } };
    if (target.uri === preview.key) {
      preview.setInitialPosition(target.line, caret);
    } else {
      await this.manager.openStory(vscode.Uri.parse(target.uri), target.line);
    }
    const file = target.uri === preview.key ? '' : `${path.posix.basename(vscode.Uri.parse(target.uri).path)} `;
    vscode.window.setStatusBarMessage(`ブックマーク: ${target.name}（${file}${formatNumber(target.line + 1)} 行目）`, 3000);
  }

  private async setCrossFile(value: boolean): Promise<void> {
    await vscode.workspace.getConfiguration('teesNovelView').update('bookmarks.crossFile', value, vscode.ConfigurationTarget.Global);
    vscode.window.setStatusBarMessage(`ブックマークの移動: ファイルをまたぐ ${value ? 'ON' : 'OFF'}`, 3000);
  }

  private async openBookmark(id: string): Promise<void> {
    const b = this.store.find(id);
    if (b) {
      await this.manager.openStory(vscode.Uri.parse(b.uri), b.line);
    }
  }

  private async renameBookmark(node?: BookmarkNode): Promise<void> {
    if (node?.kind !== 'bookmark') {
      return;
    }
    const name = await vscode.window.showInputBox({
      title: 'ブックマークの名前を変更',
      value: node.bookmark.name,
      valueSelection: [0, Number.MAX_SAFE_INTEGER],
    });
    if (name !== undefined && name.trim()) {
      this.store.rename(node.bookmark.id, name.trim());
    }
  }

  private removeBookmark(node?: BookmarkNode): void {
    if (node?.kind === 'bookmark') {
      this.store.remove(node.bookmark.id);
    } else if (node?.kind === 'file') {
      node.bookmarks.forEach((b) => this.store.remove(b.id));
    }
  }

  private async clearBookmarks(): Promise<void> {
    const count = this.store.all().length;
    if (count === 0) {
      return;
    }
    const answer = await vscode.window.showWarningMessage(
      `${formatNumber(count)} 件のブックマークをすべて削除しますか？`,
      { modal: true },
      'すべて削除',
    );
    if (answer === 'すべて削除') {
      this.store.clear();
    }
  }

  dispose(): void {
    this.disposables.forEach((d) => d.dispose());
  }
}
