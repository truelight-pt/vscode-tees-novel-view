import * as vscode from 'vscode';
import * as path from 'path';
import { BookmarkStore } from './bookmarks';
import { DEFAULT_EPISODE_PATTERN, findEpisodeNeighbors } from './episode';
import { diffLines, LineChange, splitLines } from './lineDiff';
import { PreviewConfig, render } from './renderer';

export const VIEW_TYPE = 'teesNovelView.preview';
const CONFIG_SECTION = 'teesNovelView';

/** 元テキスト上の位置（col は UTF-16 単位） */
interface SourcePos {
  line: number;
  col: number;
}

interface SourceSelection {
  anchor: SourcePos;
  active: SourcePos;
}

function toSourceSelection(sel: vscode.Selection): SourceSelection {
  return {
    anchor: { line: sel.anchor.line, col: sel.anchor.character },
    active: { line: sel.active.line, col: sel.active.character },
  };
}

function toVsSelection(sel: SourceSelection, doc: vscode.TextDocument): vscode.Selection {
  const pos = (p: SourcePos) => doc.validatePosition(new vscode.Position(p.line, p.col));
  return new vscode.Selection(pos(sel.anchor), pos(sel.active));
}

export function isTxt(uri: vscode.Uri): boolean {
  return path.extname(uri.path).toLowerCase() === '.txt';
}

function readConfig(): PreviewConfig {
  const c = vscode.workspace.getConfiguration(CONFIG_SECTION);
  const group = (name: string) => ({
    enabled: c.get<boolean>(`highlight.${name}.enabled`, true),
    color: c.get<string>(`highlight.${name}.color`, ''),
  });
  return {
    charsPerLine: c.get<number>('charsPerLine', 40),
    fontFamily: c.get<string>('fontFamily', ''),
    fontSize: c.get<number>('fontSize', 16),
    lineHeight: c.get<number>('lineHeight', 1.9),
    lineNumbers: c.get<boolean>('lineNumbers', false),
    rubyEnabled: c.get<boolean>('ruby.enabled', true),
    rubyParentheses: c.get<boolean>('ruby.parentheses', false),
    highlightEnabled: c.get<boolean>('highlight.enabled', true),
    dialogue: { ...group('dialogue'), brackets: c.get<string[]>('highlight.dialogue.brackets', []) },
    thought: { ...group('thought'), brackets: c.get<string[]>('highlight.thought.brackets', []) },
    quote: { ...group('quote'), brackets: c.get<string[]>('highlight.quote.brackets', []) },
    number: {
      ...group('number'),
      includeKanji: c.get<boolean>('highlight.number.includeKanji', true),
      kanjiCounters: c.get<string>('highlight.number.kanjiCounters', ''),
      kanjiPrefixes: c.get<string>('highlight.number.kanjiPrefixes', ''),
    },
    customRules: c.get('highlight.customRules', []),
  };
}

class NovelPreview {
  private readonly disposables: vscode.Disposable[] = [];
  private ready = false;
  private renderTimer: NodeJS.Timeout | undefined;
  private lastScrollLine = -1;
  /** 次の描画後にスクロールする行 */
  private pendingLine: number | undefined;
  /** 次の描画後に設定する選択範囲 */
  private pendingSelection: SourceSelection | undefined;
  /** プレビュー上端に表示されている行 */
  topLine = 0;
  /** 小説ビュー上のカーソル・選択範囲（元テキストの位置） */
  selection: SourceSelection | undefined;
  /** 次の描画で表示位置・カーソルをリセットする（別の話に切り替えたとき） */
  private resetView = false;
  /** 表示中のファイルの監視（外部での変更を検知する） */
  private fileWatcher: vscode.Disposable | undefined;
  /** 最後に描画したテキスト（外部の変更で内容が変わったかの判定に使う） */
  private renderedText: string | undefined;

  /**
   * @param uri 表示中のファイル（前話・次話への移動で変わる）
   * @param switched ソースと置き換える形で開いたか（true ならソースに戻すときプレビューを閉じる）
   */
  constructor(
    readonly panel: vscode.WebviewPanel,
    public uri: vscode.Uri,
    private readonly manager: PreviewManager,
    readonly switched: boolean,
    initialLine?: number,
    initialSelection?: SourceSelection,
  ) {
    this.pendingLine = initialLine;
    this.pendingSelection = initialSelection;
    this.selection = initialSelection;
    const webview = panel.webview;
    webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(manager.extensionUri, 'media')],
    };
    panel.title = `小説ビュー ${path.basename(uri.path)}`;
    panel.iconPath = new vscode.ThemeIcon('book');
    webview.html = this.buildShell();

    this.disposables.push(
      webview.onDidReceiveMessage((msg) => this.onMessage(msg)),
      panel.onDidChangeViewState(() => {
        if (panel.visible) {
          this.scheduleRender(0);
        }
        if (panel.active) {
          void manager.updateEpisodeContext(this);
        }
        manager.notifyStateChange();
      }),
      panel.onDidDispose(() => this.dispose()),
    );
    this.watchFile();
  }

  /**
   * 表示中のファイルを監視し、外部（別のアプリや git の操作など）で変更されたら描き直す。
   * ソースのタブを閉じていると onDidChangeTextDocument が来ないため、ファイルそのものを監視する。
   */
  private watchFile(): void {
    this.fileWatcher?.dispose();
    const dir = this.uri.with({ path: path.posix.dirname(this.uri.path) });
    const watcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(dir, path.posix.basename(this.uri.path)));
    const onChange = () => this.scheduleRender();
    watcher.onDidChange(onChange);
    watcher.onDidCreate(onChange);
    watcher.onDidDelete(onChange);
    this.fileWatcher = watcher;
  }

  /** 内容が最後に描画したものと違っていれば描き直す（監視で取りこぼした変更の救済） */
  async refreshIfChanged(): Promise<void> {
    if (!this.ready || !this.panel.visible || this.renderTimer) {
      return;
    }
    try {
      const doc = await vscode.workspace.openTextDocument(this.uri);
      if (doc.getText() !== this.renderedText) {
        this.scheduleRender(0);
      }
    } catch {
      // 読めない場合は次の描画に任せる
    }
  }

  get key(): string {
    return this.uri.toString();
  }

  /** 表示するファイルを切り替える（前話・次話）。表示位置は先頭に戻す。 */
  retarget(uri: vscode.Uri): void {
    this.uri = uri;
    this.panel.title = `小説ビュー ${path.basename(uri.path)}`;
    this.selection = undefined;
    this.pendingSelection = undefined;
    this.pendingLine = undefined;
    this.topLine = 0;
    this.lastScrollLine = -1;
    this.resetView = true;
    this.watchFile();
    this.scheduleRender(0);
    this.manager.notifyStateChange();
  }

  /** 表示位置とカーソルを指定する（次の描画後に反映） */
  setInitialPosition(line: number | undefined, selection: SourceSelection | undefined): void {
    this.pendingLine = line;
    this.pendingSelection = selection;
    if (selection) {
      this.selection = selection;
    }
    this.scheduleRender(0);
  }

  private onMessage(msg: { type: string; line?: number; selection?: SourceSelection }): void {
    switch (msg.type) {
      case 'ready':
        // retainContextWhenHidden を使わないため、再表示のたびに webview が再生成され ready が届く
        this.ready = true;
        this.lastScrollLine = -1;
        this.scheduleRender(0);
        break;
      case 'selection':
        if (msg.selection) {
          this.selection = msg.selection;
          this.manager.notifyStateChange();
        }
        break;
      case 'scroll':
        if (typeof msg.line === 'number') {
          this.topLine = msg.line;
        }
        break;
    }
  }

  scheduleRender(delay = 200): void {
    if (this.renderTimer) {
      clearTimeout(this.renderTimer);
    }
    this.renderTimer = setTimeout(() => {
      this.renderTimer = undefined;
      void this.render();
    }, delay);
  }

  private async render(): Promise<void> {
    if (!this.ready || !this.panel.visible) {
      return;
    }
    let text: string;
    let changes: LineChange[] = [];
    try {
      const doc = await vscode.workspace.openTextDocument(this.uri);
      text = doc.getText();
      this.renderedText = text;
      changes = await this.manager.lineChanges(this.uri, text);
    } catch (e) {
      this.renderedText = undefined;
      text = `ファイルを読み込めませんでした: ${this.uri.fsPath}\n${(e as Error).message}`;
    }
    const config = readConfig();
    const result = render(text, config);
    this.manager.reportWarnings(result.warnings);
    void this.panel.webview.postMessage({
      type: 'update',
      uri: this.key,
      switched: this.switched,
      lineNumbers: config.lineNumbers,
      reset: this.resetView,
      bookmarks: this.manager.bookmarkMarks(this.uri),
      changes,
      minimap: {
        enabled: vscode.workspace.getConfiguration(CONFIG_SECTION).get<boolean>('minimap.enabled', true),
        width: vscode.workspace.getConfiguration(CONFIG_SECTION).get<number>('minimap.width', 80),
      },
      html: result.html,
      css: result.css,
    });
    this.resetView = false;
    if (this.pendingLine !== undefined) {
      const line = this.pendingLine;
      this.pendingLine = undefined;
      this.lastScrollLine = line;
      this.topLine = line;
      void this.panel.webview.postMessage({ type: 'scrollToLine', line });
    }
    if (this.pendingSelection) {
      void this.panel.webview.postMessage({ type: 'setSelection', selection: this.pendingSelection });
      this.pendingSelection = undefined;
    }
  }

  /** ブックマークの表示を更新する */
  sendBookmarks(): void {
    if (this.ready) {
      void this.panel.webview.postMessage({ type: 'bookmarks', bookmarks: this.manager.bookmarkMarks(this.uri) });
    }
  }

  /** 変更行の印を更新する（Git の状態が変わったとき。本文は描き直さない） */
  async sendLineChanges(): Promise<void> {
    if (!this.ready || !this.panel.visible) {
      return;
    }
    const uri = this.uri;
    let changes: LineChange[];
    try {
      const doc = await vscode.workspace.openTextDocument(uri);
      changes = await this.manager.lineChanges(uri, doc.getText());
    } catch {
      return;
    }
    // 待っている間に別の話へ切り替わっていたら送らない
    if (uri === this.uri) {
      void this.panel.webview.postMessage({ type: 'changes', changes });
    }
  }

  scrollToLine(line: number): void {
    if (!this.ready || line === this.lastScrollLine) {
      return;
    }
    this.lastScrollLine = line;
    void this.panel.webview.postMessage({ type: 'scrollToLine', line });
  }

  private buildShell(): string {
    const webview = this.panel.webview;
    const media = (file: string) => webview.asWebviewUri(vscode.Uri.joinPath(this.manager.extensionUri, 'media', file));
    const nonce = createNonce();
    return `<!DOCTYPE html>
<html lang="ja">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; font-src ${webview.cspSource}; img-src ${webview.cspSource} data:; script-src 'nonce-${nonce}';">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<link rel="stylesheet" href="${media('preview.css')}">
<style id="dynamic-style"></style>
</head>
<body>
<main id="content"></main>
<div id="line-changes"></div>
<div id="caret" hidden></div>
<div id="minimap" hidden><canvas></canvas></div>
<div id="scroll-buttons">
<button id="scroll-top" type="button" tabindex="-1" title="一番上へ" aria-label="一番上へ"><svg viewBox="0 0 16 16" aria-hidden="true"><path d="M3 3h10M8 13V6M4.5 9.5 8 6l3.5 3.5"/></svg></button>
<button id="scroll-bottom" type="button" tabindex="-1" title="一番下へ" aria-label="一番下へ"><svg viewBox="0 0 16 16" aria-hidden="true"><path d="M3 13h10M8 3v7M4.5 6.5 8 10l3.5-3.5"/></svg></button>
</div>
<script nonce="${nonce}" src="${media('preview.js')}"></script>
</body>
</html>`;
  }

  dispose(): void {
    if (this.renderTimer) {
      clearTimeout(this.renderTimer);
    }
    this.fileWatcher?.dispose();
    this.manager.onPreviewDisposed(this);
    this.disposables.forEach((d) => d.dispose());
    this.disposables.length = 0;
  }
}

export class PreviewManager implements vscode.Disposable, vscode.WebviewPanelSerializer {
  private readonly previews = new Map<string, NovelPreview>();
  private readonly disposables: vscode.Disposable[] = [];
  private readonly stateEmitter = new vscode.EventEmitter<void>();
  /** 小説ビューのアクティブ状態・表示ファイル・カーソルが変わったとき */
  readonly onDidChangeState = this.stateEmitter.event;
  private readonly reportedWarnings = new Set<string>();

  constructor(
    readonly extensionUri: vscode.Uri,
    private readonly bookmarks: BookmarkStore,
  ) {
    this.disposables.push(
      bookmarks.onDidChange(() => this.previews.forEach((p) => p.sendBookmarks())),
      vscode.window.registerWebviewPanelSerializer(VIEW_TYPE, this),
      vscode.workspace.onDidChangeTextDocument((e) => this.get(e.document.uri)?.scheduleRender()),
      // 別のアプリで編集して戻ってきたとき、監視で検知できなかった変更も反映する
      vscode.window.onDidChangeWindowState((e) => {
        if (e.focused) {
          this.previews.forEach((p) => void p.refreshIfChanged());
        }
      }),
      vscode.workspace.onDidChangeConfiguration((e) => {
        if (e.affectsConfiguration(CONFIG_SECTION)) {
          this.reportedWarnings.clear();
          this.previews.forEach((p) => p.scheduleRender(0));
        }
      }),
      vscode.window.onDidChangeTextEditorVisibleRanges((e) => {
        if (!vscode.workspace.getConfiguration(CONFIG_SECTION).get<boolean>('scrollSync', true)) {
          return;
        }
        const range = e.visibleRanges[0];
        if (range) {
          this.get(e.textEditor.document.uri)?.scrollToLine(range.start.line);
        }
      }),
    );
  }

  private get(uri: vscode.Uri): NovelPreview | undefined {
    return this.previews.get(uri.toString());
  }

  /** 現在アクティブなプレビュー */
  get activePreview(): NovelPreview | undefined {
    for (const p of this.previews.values()) {
      if (p.panel.active) {
        return p;
      }
    }
    return undefined;
  }

  /**
   * エディター領域でアクティブなタブになっている小説ビュー。
   * サイドバーなどにフォーカスがあっても判定できるよう、フォーカスではなくアクティブなタブで判定する。
   */
  get editorPreview(): NovelPreview | undefined {
    const group = vscode.window.tabGroups.activeTabGroup;
    const input = group.activeTab?.input;
    if (!(input instanceof vscode.TabInputWebview) || !input.viewType.endsWith(VIEW_TYPE)) {
      return undefined;
    }
    for (const p of this.previews.values()) {
      if (p.panel.viewColumn === group.viewColumn && p.panel.visible) {
        return p;
      }
    }
    return undefined;
  }

  /**
   * プレビューを開く。
   * toSide = false のときはソースのタブと置き換える（未保存の変更がある場合はソースのタブを残す）。
   */
  async show(uri: vscode.Uri, toSide: boolean): Promise<void> {
    const editor = vscode.window.visibleTextEditors.find((e) => e.document.uri.toString() === uri.toString());
    const line = editor?.visibleRanges[0]?.start.line;
    const selection = editor ? toSourceSelection(editor.selection) : undefined;

    const existing = this.get(uri);
    if (existing) {
      existing.panel.reveal(toSide ? undefined : vscode.ViewColumn.Active, toSide);
      if (line !== undefined) {
        existing.setInitialPosition(line, selection);
      }
      return;
    }

    const column = toSide ? vscode.ViewColumn.Beside : vscode.ViewColumn.Active;
    const panel = vscode.window.createWebviewPanel(
      VIEW_TYPE,
      path.basename(uri.path),
      { viewColumn: column, preserveFocus: toSide },
      { enableScripts: true, enableFindWidget: true, retainContextWhenHidden: false },
    );
    this.add(new NovelPreview(panel, uri, this, !toSide, line, selection));

    if (!toSide) {
      const group = vscode.window.tabGroups.activeTabGroup;
      const sourceTab = group.tabs.find(
        (t) => t.input instanceof vscode.TabInputText && t.input.uri.toString() === uri.toString(),
      );
      if (sourceTab && !sourceTab.isDirty) {
        await vscode.window.tabGroups.close(sourceTab, true);
      }
    }
  }

  async deserializeWebviewPanel(panel: vscode.WebviewPanel, state: unknown): Promise<void> {
    const s = state as { uri?: string; switched?: boolean; selection?: SourceSelection } | undefined;
    if (!s?.uri) {
      panel.dispose();
      return;
    }
    this.add(new NovelPreview(panel, vscode.Uri.parse(s.uri), this, s.switched ?? false, undefined, s.selection));
  }

  private add(preview: NovelPreview): void {
    this.previews.set(preview.key, preview);
    // 作成直後は onDidChangeViewState が来ないことがあるため、ここでもボタン状態を更新する
    if (preview.panel.active) {
      void this.updateEpisodeContext(preview);
    }
    this.notifyStateChange();
  }

  onPreviewDisposed(preview: NovelPreview): void {
    if (this.previews.get(preview.key) === preview) {
      this.previews.delete(preview.key);
    }
    this.notifyStateChange();
  }

  notifyStateChange(): void {
    this.stateEmitter.fire();
  }

  /**
   * ソースを表示する。小説ビューの表示位置とカーソル・選択範囲を引き継ぐ。
   * 置き換えで開いた小説ビューは同じ場所でソースに切り替え、横に開いた小説ビューは既存のエディターを表示する。
   */
  async showSource(preview: NovelPreview): Promise<void> {
    const doc = await vscode.workspace.openTextDocument(preview.uri);
    const visible = vscode.window.visibleTextEditors.find((e) => e.document.uri.toString() === preview.key);
    const viewColumn = preview.switched ? preview.panel.viewColumn : visible?.viewColumn;
    const editor = await vscode.window.showTextDocument(doc, {
      viewColumn: viewColumn ?? vscode.ViewColumn.Active,
      preview: false,
    });

    if (preview.selection) {
      editor.selection = toVsSelection(preview.selection, doc);
    }
    const top = new vscode.Position(Math.min(preview.topLine, doc.lineCount - 1), 0);
    editor.revealRange(new vscode.Range(top, top), vscode.TextEditorRevealType.AtTop);

    if (preview.switched) {
      preview.panel.dispose();
    }
  }

  /** 物語ファイル一覧の並び順（一覧から設定される） */
  private storyOrder: (() => vscode.Uri[]) | undefined;

  setStoryOrder(provider: () => vscode.Uri[]): void {
    this.storyOrder = provider;
  }

  /** 変更行の比較元の内容（Git 連携から設定される） */
  private originalText: ((uri: vscode.Uri) => Promise<string | undefined>) | undefined;

  setOriginalTextProvider(provider: (uri: vscode.Uri) => Promise<string | undefined>): void {
    this.originalText = provider;
  }

  /** 小説ビューの左端に印を付ける変更行。設定 gitChanges.enabled が OFF のときや、比較元が無いときは空 */
  async lineChanges(uri: vscode.Uri, text: string): Promise<LineChange[]> {
    if (!this.originalText || !vscode.workspace.getConfiguration(CONFIG_SECTION).get<boolean>('gitChanges.enabled', true)) {
      return [];
    }
    const original = await this.originalText(uri);
    return original === undefined ? [] : diffLines(splitLines(original), splitLines(text));
  }

  /** すべての小説ビューの変更行の印を更新する */
  refreshLineChanges(): void {
    this.previews.forEach((p) => void p.sendLineChanges());
  }

  /**
   * 前話・次話のファイルを探す。
   * 設定 episode.followStoryList が ON で、ファイルが物語ファイル一覧にあれば一覧の並び順の前後、
   * それ以外は同じフォルダーからファイル名の番号で探す。
   */
  private async findEpisodes(uri: vscode.Uri): Promise<{ prev?: vscode.Uri; next?: vscode.Uri }> {
    if (vscode.workspace.getConfiguration(CONFIG_SECTION).get<boolean>('episode.followStoryList', false) && this.storyOrder) {
      const list = this.storyOrder();
      const index = list.findIndex((u) => u.toString() === uri.toString());
      if (index >= 0) {
        return { prev: list[index - 1], next: list[index + 1] };
      }
    }
    return this.findEpisodesByNumber(uri);
  }

  /** 同じフォルダーから、ファイル名の番号で前話・次話のファイルを探す */
  private async findEpisodesByNumber(uri: vscode.Uri): Promise<{ prev?: vscode.Uri; next?: vscode.Uri }> {
    const pattern = vscode.workspace.getConfiguration(CONFIG_SECTION).get<string>('episode.numberPattern') || DEFAULT_EPISODE_PATTERN;
    let regex: RegExp;
    try {
      regex = new RegExp(pattern);
    } catch (e) {
      this.reportWarnings([`前話・次話の正規表現が不正です: ${pattern} (${(e as Error).message})`]);
      return {};
    }
    const dir = uri.with({ path: path.posix.dirname(uri.path) });
    let entries: [string, vscode.FileType][];
    try {
      entries = await vscode.workspace.fs.readDirectory(dir);
    } catch {
      return {};
    }
    const names = entries
      .filter(([name, type]) => type & vscode.FileType.File && path.extname(name).toLowerCase() === '.txt')
      .map(([name]) => name);
    const found = findEpisodeNeighbors(path.posix.basename(uri.path), names, regex);
    const toUri = (name?: string) => (name ? vscode.Uri.joinPath(dir, name) : undefined);
    return { prev: toUri(found.prev), next: toUri(found.next) };
  }

  /** 表示中の小説ビューの前話・次話ボタンの有効/無効を更新する（設定や一覧が変わったとき） */
  refreshEpisodeContext(): void {
    const preview = this.editorPreview ?? this.activePreview;
    if (preview) {
      void this.updateEpisodeContext(preview);
    }
  }

  /** 前話・次話ボタンの有効/無効を、アクティブな小説ビューに合わせて更新する */
  async updateEpisodeContext(preview: NovelPreview): Promise<void> {
    const found = await this.findEpisodes(preview.uri);
    if (!preview.panel.active) {
      return;
    }
    await vscode.commands.executeCommand('setContext', 'teesNovelView.hasPreviousEpisode', !!found.prev);
    await vscode.commands.executeCommand('setContext', 'teesNovelView.hasNextEpisode', !!found.next);
  }

  /** 前話（direction = -1）・次話（direction = 1）を同じタブで表示する */
  async openEpisode(preview: NovelPreview, direction: -1 | 1): Promise<void> {
    const found = await this.findEpisodes(preview.uri);
    const target = direction < 0 ? found.prev : found.next;
    if (!target) {
      void vscode.window.showInformationMessage(direction < 0 ? '前の話が見つかりません。' : '次の話が見つかりません。');
      return;
    }
    await this.replaceFile(preview, target, false);
  }

  /** 小説ビューに表示するブックマーク（行番号と名前） */
  bookmarkMarks(uri: vscode.Uri): Array<{ line: number; name: string }> {
    return this.bookmarks.forFile(uri).map((b) => ({ line: b.line, name: b.name }));
  }

  /**
   * 小説ビューの表示ファイルを置き換える。既にそのファイルの小説ビューがあればそちらを表示する。
   * @returns ファイルを表示している小説ビュー
   */
  private async replaceFile(preview: NovelPreview, target: vscode.Uri, preserveFocus: boolean): Promise<NovelPreview> {
    const existing = this.get(target);
    if (existing) {
      existing.panel.reveal(undefined, preserveFocus);
      return existing;
    }
    this.previews.delete(preview.key);
    preview.retarget(target);
    this.add(preview);
    if (!preserveFocus) {
      preview.panel.reveal(undefined, false);
    }
    await this.updateEpisodeContext(preview);
    return preview;
  }

  /**
   * 物語ファイル一覧・ブックマーク一覧から開く。
   * エディターで表示中の小説ビューがあればそこに置き換えて表示し、無ければ新しい小説ビューで開く。
   * 一覧のキーボード操作を続けられるよう、フォーカスは一覧に残す。
   * @param line 指定するとその行へ移動し、行頭にカーソルを置く
   */
  async openStory(uri: vscode.Uri, line?: number): Promise<void> {
    const caret: SourceSelection | undefined =
      line === undefined ? undefined : { anchor: { line, col: 0 }, active: { line, col: 0 } };

    let preview: NovelPreview | undefined;
    const current = this.editorPreview;
    if (current) {
      preview = current.key === uri.toString() ? current : await this.replaceFile(current, uri, true);
    } else {
      preview = this.get(uri);
      if (preview) {
        preview.panel.reveal(undefined, true);
      } else {
        const panel = vscode.window.createWebviewPanel(
          VIEW_TYPE,
          path.basename(uri.path),
          { viewColumn: vscode.ViewColumn.Active, preserveFocus: true },
          { enableScripts: true, enableFindWidget: true, retainContextWhenHidden: false },
        );
        // ソースのタブは無いので、ソースに切り替えるときは同じ場所で入れ替える
        this.add(new NovelPreview(panel, uri, this, true, line, caret));
        return;
      }
    }
    if (line !== undefined) {
      preview.setInitialPosition(line, caret);
    }
  }

  reportWarnings(warnings: string[]): void {
    for (const w of warnings) {
      if (!this.reportedWarnings.has(w)) {
        this.reportedWarnings.add(w);
        void vscode.window.showWarningMessage(`Novel View: ${w}`);
      }
    }
  }

  dispose(): void {
    this.previews.forEach((p) => p.panel.dispose());
    this.disposables.forEach((d) => d.dispose());
    this.stateEmitter.dispose();
  }
}

function createNonce(): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let s = '';
  for (let i = 0; i < 32; i++) {
    s += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return s;
}
