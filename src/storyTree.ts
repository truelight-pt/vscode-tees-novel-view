import * as vscode from 'vscode';
import * as path from 'path';
import { PreviewManager } from './preview';
import { extractEpisodeTitle, globToRegExp, isExcluded, looksLikeStory, naturalCompare, selectStoryFiles } from './storyDetect';

export const STORY_VIEW_ID = 'teesNovelView.stories';
const CONFIG_SECTION = 'teesNovelView';

/** 走査の上限（巨大なフォルダーを指定された場合の保護） */
const MAX_DEPTH = 12;
const MAX_FILES = 5000;
/** 判定に使う先頭部分のバイト数 */
const SNIFF_BYTES = 16 * 1024;

type StoryNode =
  | { kind: 'folder'; uri: vscode.Uri; label: string; children: StoryNode[]; parent?: StoryNode }
  | {
      kind: 'file';
      uri: vscode.Uri;
      /** ファイル名（拡張子なし）。並び順にも使う */
      label: string;
      /** ファイル先頭の「第〇話　タイトル」のタイトル部分 */
      title?: string;
      parent?: StoryNode;
    };

/** ファイル先頭から読み取った情報 */
interface FileInfo {
  mtime: number;
  story: boolean;
  title?: string;
}

interface StoriesConfig {
  roots: vscode.Uri[];
  autoDetect: boolean;
  /** 物語ファイルのあるフォルダーの .txt をすべて物語ファイルとする */
  detectByFolder: boolean;
  exclude: RegExp[];
}

/** 物語ファイル一覧の探索先（設定 stories.roots。未設定ならワークスペースのフォルダー） */
export function storyRoots(): vscode.Uri[] {
  return readConfig().roots;
}

function readConfig(): StoriesConfig {
  const c = vscode.workspace.getConfiguration(CONFIG_SECTION);
  const folders = vscode.workspace.workspaceFolders ?? [];
  const rootSettings = c.get<string[]>('stories.roots', []).filter((r) => r.trim());
  let roots: vscode.Uri[];
  if (rootSettings.length > 0) {
    roots = rootSettings.map((r) => {
      const p = r.trim().replace(/^~(?=$|[\\/])/, process.env.USERPROFILE ?? process.env.HOME ?? '~');
      // 相対パスは最初のワークスペースフォルダーを基準にする
      return path.isAbsolute(p) || folders.length === 0 ? vscode.Uri.file(p) : vscode.Uri.joinPath(folders[0].uri, p);
    });
  } else {
    roots = folders.map((f) => f.uri);
  }
  return {
    roots,
    autoDetect: c.get<boolean>('stories.autoDetect', true),
    detectByFolder: c.get<boolean>('stories.detectByFolder', true),
    exclude: c
      .get<string[]>('stories.exclude', [])
      .filter((g) => g.trim())
      .map((g) => globToRegExp(g.trim())),
  };
}

/** 物語ファイルの相対パスからツリーを組み立てる（フォルダーが先、番号順） */
function buildTree(stories: string[], toUri: (rel: string) => vscode.Uri, titles: Map<string, string>): StoryNode[] {
  const top: StoryNode[] = [];
  const folders = new Map<string, StoryNode & { kind: 'folder' }>();
  const split = (rel: string) => {
    const slash = rel.lastIndexOf('/');
    return { dir: slash < 0 ? '' : rel.slice(0, slash), name: rel.slice(slash + 1) };
  };
  /** フォルダーのノードを（無ければ祖先も含めて）作成して返す。ルートは undefined */
  const folderNode = (dirRel: string): (StoryNode & { kind: 'folder' }) | undefined => {
    if (dirRel === '') {
      return undefined;
    }
    let node = folders.get(dirRel);
    if (!node) {
      const { dir, name } = split(dirRel);
      const parent = folderNode(dir);
      node = { kind: 'folder', uri: toUri(dirRel), label: name, children: [], parent };
      (parent ? parent.children : top).push(node);
      folders.set(dirRel, node);
    }
    return node;
  };
  for (const rel of stories) {
    const { dir, name } = split(rel);
    const parent = folderNode(dir);
    (parent ? parent.children : top).push({
      kind: 'file',
      uri: toUri(rel),
      label: name.replace(/\.txt$/i, ''),
      title: titles.get(rel),
      parent,
    });
  }
  const sort = (nodes: StoryNode[]) => {
    nodes.sort((a, b) => (a.kind === b.kind ? naturalCompare(a.label, b.label) : a.kind === 'folder' ? -1 : 1));
    nodes.forEach((n) => n.kind === 'folder' && sort(n.children));
  };
  sort(top);
  return top;
}

/** バイト列の先頭を文字列にする。UTF-8 として不正なら Shift_JIS とみなす */
function decodeHead(bytes: Uint8Array): string {
  const head = bytes.subarray(0, SNIFF_BYTES);
  try {
    // stream: true で、途中で切れたマルチバイト文字をエラーにしない
    return new TextDecoder('utf-8', { fatal: true }).decode(head, { stream: true });
  } catch {
    try {
      return new TextDecoder('shift_jis').decode(head);
    } catch {
      return '';
    }
  }
}

export class StoryTreeProvider implements vscode.TreeDataProvider<StoryNode>, vscode.Disposable {
  private readonly changeEmitter = new vscode.EventEmitter<StoryNode | undefined>();
  readonly onDidChangeTreeData = this.changeEmitter.event;
  private readonly storiesEmitter = new vscode.EventEmitter<void>();
  /** 一覧の内容（物語ファイルとその並び）が変わったとき */
  readonly onDidChangeStories = this.storiesEmitter.event;

  private readonly treeView: vscode.TreeView<StoryNode>;
  private readonly disposables: vscode.Disposable[] = [];
  private watchers: vscode.Disposable[] = [];
  private roots: StoryNode[] = [];
  private readonly fileNodes = new Map<string, StoryNode>();
  /** 物語判定の結果キャッシュ（更新日時が変わるまで再判定しない） */
  private readonly infoCache = new Map<string, FileInfo>();
  private scanTimer: NodeJS.Timeout | undefined;
  private scanning: Promise<void> | undefined;

  constructor(private readonly manager: PreviewManager) {
    this.treeView = vscode.window.createTreeView(STORY_VIEW_ID, { treeDataProvider: this, showCollapseAll: true });
    this.disposables.push(
      this.treeView,
      this.changeEmitter,
      this.storiesEmitter,
      vscode.commands.registerCommand('teesNovelView.refreshStories', () => this.scheduleScan(0)),
      vscode.commands.registerCommand('teesNovelView.openStoriesSettings', () =>
        vscode.commands.executeCommand('workbench.action.openSettings', 'teesNovelView.stories'),
      ),
      vscode.commands.registerCommand('teesNovelView.openStory', (uri: vscode.Uri) => this.openStory(uri)),
      vscode.commands.registerCommand('teesNovelView.openStoriesAsText', () => this.setOpenInNovelView(false)),
      vscode.commands.registerCommand('teesNovelView.openStoriesInNovelView', () => this.setOpenInNovelView(true)),
      vscode.workspace.onDidChangeConfiguration((e) => {
        // 一覧の内容に関わる設定だけで再走査する（開き方の切り替えでは再走査しない）
        const scanKeys = ['roots', 'autoDetect', 'detectByFolder', 'exclude'];
        if (scanKeys.some((k) => e.affectsConfiguration(`${CONFIG_SECTION}.stories.${k}`))) {
          this.resetWatchers();
          this.scheduleScan(0);
        }
      }),
      // 元のテキストファイルで開いた場合も、一覧で選択状態にする
      vscode.window.onDidChangeActiveTextEditor(() => this.revealActive()),
      vscode.workspace.onDidChangeWorkspaceFolders(() => {
        this.resetWatchers();
        this.scheduleScan(0);
      }),
      // 保存時に内容が変わると物語判定が変わることがある
      vscode.workspace.onDidSaveTextDocument((doc) => {
        if (path.extname(doc.uri.path).toLowerCase() === '.txt') {
          this.scheduleScan();
        }
      }),
      // 表示中の小説ビューに対応する項目を選択状態にする
      manager.onDidChangeState(() => this.revealActive()),
      this.treeView.onDidChangeVisibility((e) => {
        if (e.visible) {
          this.revealActive();
        }
      }),
    );
    this.resetWatchers();
    this.scheduleScan(0);
  }

  // --- TreeDataProvider ---------------------------------------------------

  getTreeItem(node: StoryNode): vscode.TreeItem {
    if (node.kind === 'folder') {
      const item = new vscode.TreeItem(node.label, vscode.TreeItemCollapsibleState.Expanded);
      item.iconPath = vscode.ThemeIcon.Folder;
      item.resourceUri = node.uri;
      item.tooltip = node.uri.fsPath;
      item.id = `folder:${node.uri.toString()}`;
      return item;
    }
    // ファイル名の右に、半角スペースで区切ってタイトルを表示する
    const item = new vscode.TreeItem(node.title ? `${node.label} ${node.title}` : node.label, vscode.TreeItemCollapsibleState.None);
    item.iconPath = new vscode.ThemeIcon('book');
    // ファイルの場所を設定すると、Git の変更状態などの色と記号（M・U など）が付く
    item.resourceUri = node.uri;
    item.tooltip = node.uri.fsPath;
    item.id = `file:${node.uri.toString()}`;
    item.contextValue = 'story';
    item.command = { command: 'teesNovelView.openStory', title: '開く', arguments: [node.uri] };
    return item;
  }

  getChildren(node?: StoryNode): StoryNode[] {
    if (!node) {
      return this.roots;
    }
    return node.kind === 'folder' ? node.children : [];
  }

  getParent(node: StoryNode): StoryNode | undefined {
    return node.parent;
  }

  /** 一覧に表示されている順（上から下）の物語ファイル */
  orderedStories(): vscode.Uri[] {
    const result: vscode.Uri[] = [];
    const walk = (nodes: StoryNode[]) => {
      for (const n of nodes) {
        if (n.kind === 'folder') {
          walk(n.children);
        } else {
          result.push(n.uri);
        }
      }
    };
    walk(this.roots);
    return result;
  }

  // --- 走査 ---------------------------------------------------------------

  private resetWatchers(): void {
    this.watchers.forEach((w) => w.dispose());
    this.watchers = [];
    for (const root of readConfig().roots) {
      const watcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(root, '**/*.txt'));
      const onChange = () => this.scheduleScan();
      watcher.onDidCreate(onChange);
      watcher.onDidDelete(onChange);
      watcher.onDidChange(onChange);
      this.watchers.push(watcher);
    }
  }

  private scheduleScan(delay = 500): void {
    if (this.scanTimer) {
      clearTimeout(this.scanTimer);
    }
    this.scanTimer = setTimeout(() => {
      this.scanTimer = undefined;
      void this.scan();
    }, delay);
  }

  private async scan(): Promise<void> {
    if (this.scanning) {
      // 走査中に呼ばれたら、終わってからもう一度走査する
      await this.scanning;
      this.scheduleScan(0);
      return;
    }
    this.scanning = this.doScan().finally(() => (this.scanning = undefined));
    await this.scanning;
  }

  private async doScan(): Promise<void> {
    const config = readConfig();
    const multiRoot = config.roots.length > 1;
    const counter = { files: 0 };
    const roots: StoryNode[] = [];
    this.fileNodes.clear();

    for (const rootUri of config.roots) {
      // 1. 探索範囲のファイルを集める（フォルダー単位の判定のため .txt 以外も集める）
      const files: string[] = [];
      await this.collect(rootUri, '', 0, config, files, counter);
      const txtFiles = files.filter((f) => /\.txt$/i.test(f));
      const toUri = (rel: string) => vscode.Uri.joinPath(rootUri, ...rel.split('/'));

      // 2. 物語ファイルを選ぶ
      let stories: string[];
      if (!config.autoDetect) {
        stories = txtFiles;
      } else {
        const detected: string[] = [];
        for (const rel of txtFiles) {
          if ((await this.readInfo(toUri(rel))).story) {
            detected.push(rel);
          }
        }
        stories = config.detectByFolder ? selectStoryFiles(files, detected) : detected;
      }

      // 3. 先頭の「第〇話　タイトル」からタイトルを取り出す
      const titles = new Map<string, string>();
      for (const rel of stories) {
        const title = (await this.readInfo(toUri(rel))).title;
        if (title) {
          titles.set(rel, title);
        }
      }

      // 4. ツリーを組み立てる
      const children = buildTree(stories, toUri, titles);
      if (multiRoot) {
        if (children.length > 0) {
          const node: StoryNode = { kind: 'folder', uri: rootUri, label: path.posix.basename(rootUri.path) || rootUri.fsPath, children };
          children.forEach((c) => (c.parent = node));
          roots.push(node);
        }
      } else {
        roots.push(...children);
      }
    }

    this.roots = roots;
    const walk = (nodes: StoryNode[]) =>
      nodes.forEach((n) => (n.kind === 'folder' ? walk(n.children) : this.fileNodes.set(n.uri.toString(), n)));
    walk(roots);
    void vscode.commands.executeCommand('setContext', 'teesNovelView.storiesEmpty', roots.length === 0);
    this.changeEmitter.fire(undefined);
    this.storiesEmitter.fire();
    this.revealActive();
  }

  /** フォルダーを再帰的にたどり、除外対象でないファイルの相対パスを files に集める */
  private async collect(
    dir: vscode.Uri,
    rel: string,
    depth: number,
    config: StoriesConfig,
    files: string[],
    counter: { files: number },
  ): Promise<void> {
    if (depth > MAX_DEPTH || counter.files >= MAX_FILES) {
      return;
    }
    let entries: [string, vscode.FileType][];
    try {
      entries = await vscode.workspace.fs.readDirectory(dir);
    } catch {
      return;
    }
    for (const [name, type] of entries) {
      const childRel = rel ? `${rel}/${name}` : name;
      if (type & vscode.FileType.Directory) {
        if (!isExcluded(`${childRel}/`, config.exclude)) {
          await this.collect(vscode.Uri.joinPath(dir, name), childRel, depth + 1, config, files, counter);
        }
      } else if (type & vscode.FileType.File && !isExcluded(childRel, config.exclude)) {
        if (counter.files >= MAX_FILES) {
          return;
        }
        counter.files++;
        files.push(childRel);
      }
    }
  }

  /** ファイル先頭を読んで、物語らしいかとタイトルを返す（更新日時が変わるまでキャッシュ） */
  private async readInfo(uri: vscode.Uri): Promise<FileInfo> {
    const key = uri.toString();
    try {
      const stat = await vscode.workspace.fs.stat(uri);
      const cached = this.infoCache.get(key);
      if (cached && cached.mtime === stat.mtime) {
        return cached;
      }
      const head = decodeHead(await vscode.workspace.fs.readFile(uri));
      const info = { mtime: stat.mtime, story: looksLikeStory(head), title: extractEpisodeTitle(head) };
      this.infoCache.set(key, info);
      return info;
    } catch {
      return { mtime: 0, story: false };
    }
  }

  /**
   * 一覧で選んだファイルを開く。
   * 設定 stories.openInNovelView が ON なら小説ビューで、OFF なら元のテキストファイルをエディターで開く。
   */
  private async openStory(uri: vscode.Uri): Promise<void> {
    if (vscode.workspace.getConfiguration(CONFIG_SECTION).get<boolean>('stories.openInNovelView', true)) {
      await this.manager.openStory(uri);
      return;
    }
    // エクスプローラーのクリックと同じくプレビュータブで開き、一覧のキーボード操作を続けられるようフォーカスは残す
    await vscode.window.showTextDocument(uri, { preserveFocus: true, preview: true });
  }

  private async setOpenInNovelView(value: boolean): Promise<void> {
    await vscode.workspace.getConfiguration(CONFIG_SECTION).update('stories.openInNovelView', value, vscode.ConfigurationTarget.Global);
    vscode.window.setStatusBarMessage(`物語ファイル一覧: ${value ? '小説ビュー' : 'テキストファイル'}で開きます`, 3000);
  }

  /** 表示中の小説ビュー（またはテキストエディター）のファイルを一覧で選択状態にする */
  private revealActive(): void {
    if (!this.treeView.visible) {
      return;
    }
    const key = this.manager.editorPreview?.key ?? vscode.window.activeTextEditor?.document.uri.toString();
    const node = key && this.fileNodes.get(key);
    if (node) {
      void this.treeView.reveal(node, { select: true, focus: false, expand: true }).then(undefined, () => undefined);
    }
  }

  dispose(): void {
    if (this.scanTimer) {
      clearTimeout(this.scanTimer);
    }
    this.watchers.forEach((w) => w.dispose());
    this.disposables.forEach((d) => d.dispose());
  }
}
