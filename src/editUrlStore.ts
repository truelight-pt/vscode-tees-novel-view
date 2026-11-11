import * as vscode from 'vscode';
import * as path from 'path';
import { EpisodeListPage, isWebUrl, matchEpisodes, parseEpisodeListPage } from './editUrl';
import { DEFAULT_EPISODE_PATTERN } from './episode';
import { StoryFolder, StoryTreeProvider } from './storyTree';

const STORAGE_KEY = 'teesNovelView.editUrls';

/**
 * 物語ファイルごとの編集投稿 URL の保存場所。ブックマークと同じく、
 * VS Code がワークスペースごとに用意する保存領域（workspaceState）に保存する。
 */
export class EditUrlStore implements vscode.Disposable {
  private urls: Record<string, string>;
  private readonly changeEmitter = new vscode.EventEmitter<void>();
  readonly onDidChange = this.changeEmitter.event;
  private readonly disposables: vscode.Disposable[] = [];

  constructor(private readonly memento: vscode.Memento) {
    this.urls = { ...memento.get<Record<string, string>>(STORAGE_KEY, {}) };
    this.disposables.push(
      this.changeEmitter,
      vscode.workspace.onDidRenameFiles((e) => {
        let changed = false;
        for (const { oldUri, newUri } of e.files) {
          const oldKey = oldUri.toString();
          for (const key of Object.keys(this.urls)) {
            // ファイル自体、またはフォルダーの名前変更
            if (key === oldKey || key.startsWith(`${oldKey}/`)) {
              this.urls[newUri.toString() + key.slice(oldKey.length)] = this.urls[key];
              delete this.urls[key];
              changed = true;
            }
          }
        }
        if (changed) {
          this.commit();
        }
      }),
      vscode.workspace.onDidDeleteFiles((e) => {
        const deleted = e.files.map((u) => u.toString());
        const keys = Object.keys(this.urls).filter((key) => deleted.some((d) => key === d || key.startsWith(`${d}/`)));
        if (keys.length > 0) {
          keys.forEach((key) => delete this.urls[key]);
          this.commit();
        }
      }),
    );
  }

  get(uri: vscode.Uri): string | undefined {
    return this.urls[uri.toString()];
  }

  /** URL を設定する。空なら削除する */
  set(uri: vscode.Uri, url: string): void {
    if (url) {
      this.urls[uri.toString()] = url;
    } else {
      delete this.urls[uri.toString()];
    }
    this.commit();
  }

  setMany(entries: { uri: vscode.Uri; url: string }[]): void {
    for (const { uri, url } of entries) {
      this.urls[uri.toString()] = url;
    }
    this.commit();
  }

  private commit(): void {
    void this.memento.update(STORAGE_KEY, this.urls);
    this.changeEmitter.fire();
  }

  dispose(): void {
    this.disposables.forEach((d) => d.dispose());
  }
}

/** 編集投稿 URL に関するコマンドを登録する */
export function registerEditUrlCommands(store: EditUrlStore, storyTree: StoryTreeProvider): vscode.Disposable {
  return vscode.Disposable.from(
    // 物語ファイル一覧の項目から（引数はその項目のファイル）
    vscode.commands.registerCommand('teesNovelView.openEditUrl', (node?: { uri?: vscode.Uri }) => {
      const url = node?.uri && store.get(node.uri);
      if (url) {
        void vscode.env.openExternal(vscode.Uri.parse(url, true));
      }
    }),
    vscode.commands.registerCommand('teesNovelView.setEditUrl', (node?: { uri?: vscode.Uri }) => {
      if (node?.uri) {
        void setEditUrl(store, node.uri);
      }
    }),
    vscode.commands.registerCommand('teesNovelView.importEditUrls', () => importEditUrls(store, storyTree)),
  );
}

async function setEditUrl(store: EditUrlStore, uri: vscode.Uri): Promise<void> {
  const input = await vscode.window.showInputBox({
    title: `編集投稿URL設定: ${path.posix.basename(uri.path)}`,
    prompt: '編集投稿ページの URL を入力してください（空にすると削除します）',
    value: store.get(uri) ?? '',
    ignoreFocusOut: true,
    validateInput: (text) => (!text.trim() || isWebUrl(text.trim()) ? undefined : 'http:// または https:// で始まる URL を入力してください'),
  });
  if (input !== undefined) {
    store.set(uri, input.trim());
  }
}

/** クリップボードの HTML ソースから各エピソードの編集 URL を取り出し、物語ファイルに一括で設定する */
async function importEditUrls(store: EditUrlStore, storyTree: StoryTreeProvider): Promise<void> {
  const page = parseEpisodeListPage(await vscode.env.clipboard.readText());
  if (page.episodes.length === 0) {
    void vscode.window.showErrorMessage(
      'クリップボードから編集投稿 URL が見つかりませんでした。「小説家になろう」の投稿済のエピソード一覧で「ページのソースを表示」を開き、全体をコピーしてから実行してください。',
    );
    return;
  }

  const pattern = vscode.workspace.getConfiguration('teesNovelView').get<string>('episode.numberPattern') || DEFAULT_EPISODE_PATTERN;
  let regex: RegExp;
  try {
    regex = new RegExp(pattern);
  } catch (e) {
    void vscode.window.showErrorMessage(`前話・次話の正規表現が不正です: ${pattern} (${(e as Error).message})`);
    return;
  }

  // 照合できる件数が多いフォルダーを先にして、対象を選んでもらう（候補が 1 つなら選ばない）
  const candidates = storyTree
    .storyFolders()
    .map((folder) => ({
      folder,
      match: matchEpisodes(page.episodes, folder.files, (uri) => path.posix.basename(uri.path), regex),
    }))
    .filter((c) => c.match.matched.length > 0)
    .sort((a, b) => b.match.matched.length - a.match.matched.length);
  if (candidates.length === 0) {
    void vscode.window.showErrorMessage(
      `物語ファイル一覧に、エピソードの番号と一致するファイル名が見つかりませんでした（エピソード ${page.episodes.length} 件）。`,
    );
    return;
  }
  const target =
    candidates.length === 1
      ? candidates[0]
      : (
          await vscode.window.showQuickPick(
            candidates.map((c) => ({ label: c.folder.label, description: `${c.match.matched.length} 件が一致`, candidate: c })),
            { title: '編集投稿URL一括設定', placeHolder: `${page.workTitle ?? '作品'} を設定するフォルダーを選んでください`, ignoreFocusOut: true },
          )
        )?.candidate;
  if (!target) {
    return;
  }

  const { match } = target;
  const entries = match.matched.map(({ episode, file }) => ({ uri: file, url: episode.url }));
  const changed = entries.filter((e) => store.get(e.uri) !== e.url);
  const overwritten = changed.filter((e) => store.get(e.uri) !== undefined).length;
  const answer = await vscode.window.showInformationMessage(
    `${page.workTitle ?? '作品'} の編集投稿 URL を「${target.folder.label}」に設定します`,
    { modal: true, detail: importSummary(page, target.folder, match.matched.length, overwritten, match) },
    '設定する',
  );
  if (answer !== '設定する') {
    return;
  }
  store.setMany(entries);
  vscode.window.setStatusBarMessage(`編集投稿 URL を ${entries.length} 件設定しました`, 3000);
}

/** 一括設定の確認画面に出す内訳 */
function importSummary(
  page: EpisodeListPage,
  folder: StoryFolder,
  count: number,
  overwritten: number,
  match: { unmatchedEpisodes: number[]; ambiguousEpisodes: number[]; unmatchedFileCount: number },
): string {
  const numbers = (list: number[]) => (list.length > 10 ? `${list.slice(0, 10).join(', ')} ほか` : list.join(', '));
  const lines = [`設定: ${count} 件（うち上書き ${overwritten} 件）`];
  if (match.unmatchedEpisodes.length > 0) {
    lines.push(`ファイルが見つからないエピソード: ${match.unmatchedEpisodes.length} 件（ep. ${numbers(match.unmatchedEpisodes)}）`);
  }
  if (match.ambiguousEpisodes.length > 0) {
    lines.push(`同じ番号のファイルが複数あり設定しないエピソード: ${match.ambiguousEpisodes.length} 件（ep. ${numbers(match.ambiguousEpisodes)}）`);
  }
  if (match.unmatchedFileCount > 0) {
    lines.push(`エピソードが見つからないファイル: ${match.unmatchedFileCount} 件（全 ${folder.files.length} 件中）`);
  }
  if (page.postedCount !== undefined && page.postedCount !== page.episodes.length) {
    lines.push(
      `注意: 投稿済は ${page.postedCount} 件ですが、このソースには ${page.episodes.length} 件しかありません。一覧が複数ページに分かれている場合は、残りのページでも実行してください（設定済みの URL はそのまま残ります）`,
    );
  }
  return lines.join('\n');
}
