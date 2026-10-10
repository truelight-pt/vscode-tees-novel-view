import * as vscode from 'vscode';
import { PreviewManager } from './preview';

/**
 * VS Code の Git 拡張機能（vscode.git）が公開している API のうち、ここで使う部分だけの型。
 * 正式な型定義（git.d.ts）は VS Code のリポジトリにあるが、依存を増やさないよう必要な分だけ書く。
 */
interface GitChange {
  readonly uri: vscode.Uri;
}

interface GitRepositoryState {
  readonly workingTreeChanges: GitChange[];
  readonly indexChanges: GitChange[];
  readonly mergeChanges: GitChange[];
  /** 設定 git.untrackedChanges が separate のときだけ使われる */
  readonly untrackedChanges?: GitChange[];
  readonly onDidChange: vscode.Event<void>;
}

interface GitRepository {
  readonly state: GitRepositoryState;
}

interface GitAPI {
  readonly repositories: GitRepository[];
  getRepository(uri: vscode.Uri): GitRepository | null;
  readonly onDidOpenRepository: vscode.Event<GitRepository>;
}

interface GitExtension {
  getAPI(version: 1): GitAPI;
}

/** 表示中のファイルに Git の変更があるときに true になるコンテキストキー（「変更を開く」ボタンの表示に使う） */
const CONTEXT_KEY = 'teesNovelView.hasGitChanges';

/**
 * 小説ビューで表示中のファイルに Git の変更があるかを調べ、「変更を開く」ボタンの表示を切り替える。
 * テキストエディターの右上に Git 拡張機能が出すボタンと同じく、変更のあるファイルでだけ表示する。
 */
export class GitChangesWatcher implements vscode.Disposable {
  private api: GitAPI | undefined;
  private readonly disposables: vscode.Disposable[] = [];
  private readonly watchedRepos = new Set<GitRepository>();

  constructor(private readonly manager: PreviewManager) {
    this.disposables.push(
      vscode.commands.registerCommand('teesNovelView.openChanges', () => this.openChanges()),
      manager.onDidChangeState(() => this.update()),
    );
    void this.init();
  }

  private async init(): Promise<void> {
    const extension = vscode.extensions.getExtension<GitExtension>('vscode.git');
    if (!extension) {
      return;
    }
    try {
      const exports = extension.isActive ? extension.exports : await extension.activate();
      this.api = exports.getAPI(1);
    } catch {
      // Git 拡張機能が無効などで使えない場合は、ボタンを出さないだけにする
      return;
    }
    this.api.repositories.forEach((repo) => this.watch(repo));
    this.disposables.push(this.api.onDidOpenRepository((repo) => this.watch(repo)));
    this.update();
  }

  private watch(repo: GitRepository): void {
    if (this.watchedRepos.has(repo)) {
      return;
    }
    this.watchedRepos.add(repo);
    this.disposables.push(repo.state.onDidChange(() => this.update()));
  }

  /** ファイルに Git の変更（未ステージ・ステージ済み・競合・未追跡）があるか */
  private hasChanges(uri: vscode.Uri): boolean {
    const repo = this.api?.getRepository(uri);
    if (!repo) {
      return false;
    }
    const key = uri.toString();
    const { workingTreeChanges, indexChanges, mergeChanges, untrackedChanges = [] } = repo.state;
    return [workingTreeChanges, indexChanges, mergeChanges, untrackedChanges].some((changes) =>
      changes.some((c) => c.uri.toString() === key),
    );
  }

  private update(): void {
    const preview = this.manager.editorPreview ?? this.manager.activePreview;
    const changed = !!preview && this.hasChanges(preview.uri);
    void vscode.commands.executeCommand('setContext', CONTEXT_KEY, changed);
  }

  /** 表示中のファイルの変更を、Git 拡張機能の比較画面で開く */
  private async openChanges(): Promise<void> {
    const preview = this.manager.editorPreview ?? this.manager.activePreview;
    if (!preview) {
      return;
    }
    await vscode.commands.executeCommand('git.openChange', preview.uri);
  }

  dispose(): void {
    this.disposables.forEach((d) => d.dispose());
  }
}
