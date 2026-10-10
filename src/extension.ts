import * as vscode from 'vscode';
import { BookmarkStore } from './bookmarks';
import { BookmarkTreeProvider } from './bookmarkTree';
import { isTxt, PreviewManager } from './preview';
import { NovelStatusBar } from './statusBar';
import { storyRoots, StoryTreeProvider } from './storyTree';

export function activate(context: vscode.ExtensionContext): void {
  // ブックマークはワークスペースごとに保存する。以前の版で PC 全体に保存していたものは、
  // このワークスペースのフォルダーと物語ファイルの探索先にあるファイルの分だけ移し替える
  const workspaceRoots = [...(vscode.workspace.workspaceFolders ?? []).map((f) => f.uri), ...storyRoots()];
  const bookmarks = new BookmarkStore(context.workspaceState, context.globalState, workspaceRoots);
  const manager = new PreviewManager(context.extensionUri, bookmarks);
  const storyTree = new StoryTreeProvider(manager);
  context.subscriptions.push(bookmarks, manager, new NovelStatusBar(manager), storyTree, new BookmarkTreeProvider(bookmarks, manager));

  // 前話・次話を物語ファイル一覧の並び順で探せるようにする
  manager.setStoryOrder(() => storyTree.orderedStories());
  const setFollowStoryList = async (value: boolean) => {
    await vscode.workspace.getConfiguration('teesNovelView').update('episode.followStoryList', value, vscode.ConfigurationTarget.Global);
    vscode.window.setStatusBarMessage(`前話・次話: ${value ? '物語ファイル一覧の順に移動' : '同じフォルダー内で移動'}`, 3000);
  };
  context.subscriptions.push(
    storyTree.onDidChangeStories(() => manager.refreshEpisodeContext()),
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('teesNovelView.episode')) {
        manager.refreshEpisodeContext();
      }
    }),
    vscode.commands.registerCommand('teesNovelView.enableFollowStoryList', () => setFollowStoryList(true)),
    vscode.commands.registerCommand('teesNovelView.disableFollowStoryList', () => setFollowStoryList(false)),
  );

  const showPreview = (toSide: boolean) => async (uri?: vscode.Uri) => {
    const target = uri instanceof vscode.Uri ? uri : vscode.window.activeTextEditor?.document.uri;
    if (!target) {
      void vscode.window.showInformationMessage('小説ビューで表示するテキストファイルを開いてください。');
      return;
    }
    if (!isTxt(target)) {
      void vscode.window.showInformationMessage('小説ビューは .txt ファイルのみ対応しています。');
      return;
    }
    await manager.show(target, toSide);
  };

  const toggle = (key: string, label: string) => async () => {
    const config = vscode.workspace.getConfiguration('teesNovelView');
    const next = !config.get<boolean>(key);
    await config.update(key, next, vscode.ConfigurationTarget.Global);
    vscode.window.setStatusBarMessage(`Novel View: ${label}を${next ? 'ON' : 'OFF'}にしました`, 3000);
  };

  context.subscriptions.push(
    vscode.commands.registerCommand('teesNovelView.showPreview', showPreview(false)),
    vscode.commands.registerCommand('teesNovelView.showPreviewToSide', showPreview(true)),
    vscode.commands.registerCommand('teesNovelView.showSource', async () => {
      const preview = manager.activePreview;
      if (preview) {
        await manager.showSource(preview);
      }
    }),
    vscode.commands.registerCommand('teesNovelView.previousEpisode', async () => {
      const preview = manager.activePreview;
      if (preview) {
        await manager.openEpisode(preview, -1);
      }
    }),
    vscode.commands.registerCommand('teesNovelView.nextEpisode', async () => {
      const preview = manager.activePreview;
      if (preview) {
        await manager.openEpisode(preview, 1);
      }
    }),
    vscode.commands.registerCommand('teesNovelView.copyBody', async () => {
      const preview = manager.activePreview ?? manager.editorPreview;
      if (!preview) {
        return;
      }
      // 元のテキスト（ルビ記法を含む）の先頭の数行（タイトルなど）を除いた全文
      const skip = Math.max(0, vscode.workspace.getConfiguration('teesNovelView').get<number>('copyBody.skipLines', 2));
      const doc = await vscode.workspace.openTextDocument(preview.uri);
      if (doc.lineCount <= skip) {
        vscode.window.setStatusBarMessage('コピーする本文がありません', 3000);
        return;
      }
      const body = doc.getText(new vscode.Range(new vscode.Position(skip, 0), doc.lineAt(doc.lineCount - 1).range.end));
      await vscode.env.clipboard.writeText(body);
      const lines = doc.lineCount - skip;
      vscode.window.setStatusBarMessage(`本文をコピーしました（${lines.toLocaleString('en-US')} 行）`, 3000);
    }),
    vscode.commands.registerCommand('teesNovelView.toggleHighlight', toggle('highlight.enabled', 'カラーリング')),
    vscode.commands.registerCommand('teesNovelView.toggleLineNumbers', toggle('lineNumbers', '行番号')),
    vscode.commands.registerCommand('teesNovelView.toggleRuby', toggle('ruby.enabled', 'ルビ表示')),
  );
}

export function deactivate(): void {
  // 後始末は context.subscriptions で行われる
}
