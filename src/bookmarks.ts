import * as vscode from 'vscode';
import { adjustLine, LineEdit } from './lineAdjust';

export interface Bookmark {
  id: string;
  /** ファイルの URI（文字列） */
  uri: string;
  /** 0 始まりの行番号 */
  line: number;
  name: string;
}

const STORAGE_KEY = 'teesNovelView.bookmarks';

/** uri が roots のいずれかのフォルダーの中（またはフォルダーそのもの）にあるか */
function isInside(uri: string, roots: vscode.Uri[]): boolean {
  return roots.some((root) => {
    const r = root.toString().replace(/\/$/, '');
    return uri === r || uri.startsWith(`${r}/`);
  });
}

/**
 * ブックマークの保存場所。VS Code がワークスペースごとに用意する保存領域（workspaceState）に保存する。
 * 開いているワークスペース（フォルダー）ごとに別のブックマークになる。
 */
export class BookmarkStore implements vscode.Disposable {
  private bookmarks: Bookmark[];
  private readonly changeEmitter = new vscode.EventEmitter<void>();
  readonly onDidChange = this.changeEmitter.event;
  private readonly disposables: vscode.Disposable[] = [];
  private saveTimer: NodeJS.Timeout | undefined;

  /**
   * @param memento ワークスペースごとの保存領域（context.workspaceState）
   * @param legacy 以前の版の保存先（context.globalState）。このワークスペースのブックマークを移し替える
   * @param workspaceRoots このワークスペースに属するとみなすフォルダー（移し替えの判定に使う）
   */
  constructor(
    private readonly memento: vscode.Memento,
    legacy: vscode.Memento,
    workspaceRoots: vscode.Uri[],
  ) {
    this.bookmarks = memento.get<Bookmark[]>(STORAGE_KEY, []);
    let changed = false;

    // 以前の版は PC 全体（globalState）に保存していた。このワークスペースのファイルのものだけ移し、
    // 残りは各ファイルのワークスペースを開いたときに移せるよう globalState に残す
    const old = legacy.get<Bookmark[]>(STORAGE_KEY, []);
    if (old.length > 0 && workspaceRoots.length > 0) {
      const mine = old.filter((b) => isInside(b.uri, workspaceRoots));
      if (mine.length > 0) {
        const ids = new Set(this.bookmarks.map((b) => b.id));
        this.bookmarks.push(...mine.filter((b) => !ids.has(b.id)));
        void legacy.update(STORAGE_KEY, old.filter((b) => !isInside(b.uri, workspaceRoots)));
        changed = true;
      }
    }

    // 以前の版は名前の先頭に行番号（例 "12: "）を含めていた。一覧で行番号を表示するようになったので取り除く
    for (const b of this.bookmarks) {
      const name = b.name.replace(/^[0-9,]+: /, '');
      if (name !== b.name && name) {
        b.name = name;
        changed = true;
      }
    }
    if (changed) {
      void memento.update(STORAGE_KEY, this.bookmarks);
    }
    this.disposables.push(
      this.changeEmitter,
      vscode.workspace.onDidChangeTextDocument((e) => this.onDocumentChanged(e)),
      vscode.workspace.onDidRenameFiles((e) => {
        let changed = false;
        for (const { oldUri, newUri } of e.files) {
          const oldKey = oldUri.toString();
          for (const b of this.bookmarks) {
            // ファイル自体、またはフォルダーの名前変更
            if (b.uri === oldKey || b.uri.startsWith(`${oldKey}/`)) {
              b.uri = newUri.toString() + b.uri.slice(oldKey.length);
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
        const before = this.bookmarks.length;
        this.bookmarks = this.bookmarks.filter((b) => !deleted.some((d) => b.uri === d || b.uri.startsWith(`${d}/`)));
        if (this.bookmarks.length !== before) {
          this.commit();
        }
      }),
    );
  }

  all(): Bookmark[] {
    return [...this.bookmarks];
  }

  forFile(uri: vscode.Uri): Bookmark[] {
    const key = uri.toString();
    return this.bookmarks.filter((b) => b.uri === key).sort((a, b) => a.line - b.line);
  }

  find(id: string): Bookmark | undefined {
    return this.bookmarks.find((b) => b.id === id);
  }

  findAt(uri: vscode.Uri, line: number): Bookmark | undefined {
    const key = uri.toString();
    return this.bookmarks.find((b) => b.uri === key && b.line === line);
  }

  add(uri: vscode.Uri, line: number, name: string): Bookmark {
    const bookmark: Bookmark = {
      id: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
      uri: uri.toString(),
      line,
      name,
    };
    this.bookmarks.push(bookmark);
    this.commit();
    return bookmark;
  }

  rename(id: string, name: string): void {
    const b = this.find(id);
    if (b) {
      b.name = name;
      this.commit();
    }
  }

  remove(id: string): void {
    this.bookmarks = this.bookmarks.filter((b) => b.id !== id);
    this.commit();
  }

  clear(): void {
    this.bookmarks = [];
    this.commit();
  }

  private onDocumentChanged(e: vscode.TextDocumentChangeEvent): void {
    const key = e.document.uri.toString();
    const targets = this.bookmarks.filter((b) => b.uri === key);
    if (targets.length === 0 || e.contentChanges.length === 0) {
      return;
    }
    let changed = false;
    // contentChanges は後ろの位置から順に並んでいるため、順に適用すればよい
    for (const change of e.contentChanges) {
      const edit: LineEdit = {
        startLine: change.range.start.line,
        startCharacter: change.range.start.character,
        endLine: change.range.end.line,
        isEmpty: change.range.isEmpty,
        newlines: (change.text.match(/\r\n|\r|\n/g) ?? []).length,
      };
      for (const b of targets) {
        const line = adjustLine(b.line, edit);
        if (line !== b.line) {
          b.line = line;
          changed = true;
        }
      }
    }
    if (changed) {
      this.commit();
    }
  }

  /** 変更を通知し、保存する（連続した編集に備えて保存は少し遅らせる） */
  private commit(): void {
    this.changeEmitter.fire();
    if (this.saveTimer) {
      clearTimeout(this.saveTimer);
    }
    this.saveTimer = setTimeout(() => {
      this.saveTimer = undefined;
      void this.memento.update(STORAGE_KEY, this.bookmarks);
    }, 300);
  }

  dispose(): void {
    if (this.saveTimer) {
      clearTimeout(this.saveTimer);
      void this.memento.update(STORAGE_KEY, this.bookmarks);
    }
    this.disposables.forEach((d) => d.dispose());
  }
}
