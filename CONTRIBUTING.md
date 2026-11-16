# 開発者向けの情報

Tee's Novel View の開発・ビルドの手順です。拡張機能の使い方は [README.md](README.md) を参照してください。

## 必要な環境

- Node.js 16 以降
- VS Code 1.75 以降

## セットアップとテスト

```bash
npm install
npm test        # コンパイルと単体テスト
```

F5 で拡張機能開発ホストが起動し、`sample/` フォルダーで動作を確認できます（各サンプルの内容は [sample/README.md](sample/README.md) を参照）。

## .vsix の作成とインストール

```bash
npm run package
```

`tees-novel-view-<version>.vsix` が作成されます。VS Code の拡張機能ビューの「…」メニュー →「VSIX からのインストール…」、または次のコマンドでインストールできます。

```bash
code --install-extension tees-novel-view-1.2.0.vsix --force
```

`--force` を付けると、同じバージョンがインストール済みでも上書きします（開発中の版を入れ直すとき）。インストール後はウィンドウを再読み込みしてください。

バージョンを上げる場合は `package.json` の `version` を変更してから作成してください。

パッケージの作成には `@vscode/vsce` の 2.x を使っています（3.x は Node.js 20 以降が必要なため）。vsce 2.x が依存する `cheerio` の最新版は Node.js 16 で動かないため、`package.json` の `overrides` で古い版に固定しています。Node.js 20 以降で開発する場合は、vsce を 3.x に更新して `overrides` を外せます。

## リリース

次の版の機能は `release/<version>` ブランチに集め、`CHANGELOG.md` の「## [x.y.z] - 未リリース」の節に追記していきます。確認用の .vsix は `npm run package` で作ります（「未リリース」のままで構いません）。

リリースするときは次の順に進めます。

1. `CHANGELOG.md` の「未リリース」を公開日（`YYYY-MM-DD`）に、末尾の比較リンクを `.../compare/v<前の版>...v<version>` に書き換えて、release ブランチにコミットする
2. release ブランチのまま `npm run package:release` を実行して、.vsix を作り直す（「未リリース」の消えた CHANGELOG が入る）
3. .vsix を [Visual Studio Marketplace の管理ページ](https://marketplace.visualstudio.com/manage/publishers/Tees-software) にアップロードする
4. 公開されたら、release ブランチを `main` に取り込み（`git merge --no-ff`）、`main` を push する
5. 注釈付きタグ `v<version>` を `main` に付けて push する（必要なら GitHub Releases に .vsix を添付）

`main` は公開中の版と一致させるため、取り込みはマーケットプレイスで公開されてから行います。取り込みは `--no-ff` なので、`main` の内容はアップロードした .vsix を作ったコミットと同じになります。

`npm run package:release` は、次のどれかに当てはまると .vsix を作らずに止まります（`scripts/check-release.js`）。

- `CHANGELOG.md` に今の版（`package.json` の `version`）の節が無い、日付が入っていない、「未リリース」が残っている
- 比較リンクが今の版のタグ（`v<version>`）を指していない（`...HEAD` のまま）
- その版の release ブランチ（`release/<version>`）でない、またはコミットしていない変更がある

## ファイル構成

| パス | 内容 |
| --- | --- |
| `src/extension.ts` | 拡張機能の入口。コマンドの登録 |
| `src/preview.ts` | 小説ビュー（Webview）の管理。ソースとの切り替え、前話・次話 |
| `src/parser.ts` | ルビ記法の解析、色分け範囲の計算、文字数 |
| `src/renderer.ts` | 小説ビューに表示する HTML と CSS の生成 |
| `src/storyTree.ts` / `src/storyDetect.ts` | 物語ファイル一覧と、物語ファイルの判定 |
| `src/bookmarks.ts` / `src/bookmarkTree.ts` / `src/lineAdjust.ts` | ブックマークの保存・一覧・編集に合わせた行の追従 |
| `src/episode.ts` | ファイル名の番号から前話・次話を探す処理 |
| `src/statusBar.ts` | ステータスバーの文字数・カーソル行 |
| `src/editUrl.ts` / `src/editUrlStore.ts` | 編集投稿 URL（エピソード一覧の HTML ソースからの抽出とファイルとの照合 / 保存・コマンド） |
| `src/gitChanges.ts` / `src/lineDiff.ts` | Git 拡張機能との連携（「変更を開く」、変更行の印）と、行単位の差分 |
| `src/test/parser.test.ts` | 単体テスト（vscode に依存しないロジックが対象） |
| `media/preview.js` / `media/preview.css` | 小説ビューの画面（カーソル、ミニマップなど） |
| `media/icon.png` | 拡張機能のアイコン（元データは `docs/icon.svg`） |
| `docs/images/` | README のスクリーンショット |
| `sample/` | 動作確認用のサンプル |
