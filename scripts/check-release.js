// リリース用の .vsix を作る前の検査（npm run package:release から呼ばれる）。
// CHANGELOG の書き忘れや、作業中のブランチからのパッケージ作成を防ぐ。問題があれば終了コード 1 で止める。
'use strict';

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const root = path.join(__dirname, '..');
const { version } = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const changelog = fs.readFileSync(path.join(root, 'CHANGELOG.md'), 'utf8');
const errors = [];

// 1. CHANGELOG に今の版の節があり、日付が入っている
const escaped = version.replace(/\./g, '\\.');
const heading = changelog.match(new RegExp(`^## \\[${escaped}\\] - (.+)$`, 'm'));
if (!heading) {
  errors.push(`CHANGELOG.md に「## [${version}] - YYYY-MM-DD」の節がありません`);
} else if (!/^\d{4}-\d{2}-\d{2}\s*$/.test(heading[1])) {
  errors.push(`CHANGELOG.md の [${version}] の日付が「${heading[1].trim()}」のままです（YYYY-MM-DD にしてください）`);
}

// 2. 「未リリース」がどこにも残っていない
if (changelog.includes('未リリース')) {
  errors.push('CHANGELOG.md に「未リリース」が残っています');
}

// 3. 比較リンクが HEAD ではなく今の版のタグを指している
const link = changelog.match(new RegExp(`^\\[${escaped}\\]: (.+)$`, 'm'));
if (!link) {
  errors.push(`CHANGELOG.md の末尾に [${version}] のリンクがありません`);
} else if (!link[1].trim().endsWith(`v${version}`)) {
  errors.push(`CHANGELOG.md の [${version}] のリンクが v${version} を指していません: ${link[1].trim()}`);
}

// 4. main ブランチで、コミットしていない変更がない（公開する版と main を一致させるため）
const git = (args) => execSync(`git ${args}`, { cwd: root, encoding: 'utf8' }).trim();
try {
  const branch = git('rev-parse --abbrev-ref HEAD');
  if (branch !== 'main') {
    errors.push(`main ブランチではありません（現在: ${branch}）`);
  }
  const status = git('status --porcelain --untracked-files=no');
  if (status) {
    errors.push(`コミットしていない変更があります:\n${status.replace(/^/gm, '    ')}`);
  }
} catch (e) {
  errors.push(`Git の状態を確認できませんでした: ${e.message}`);
}

if (errors.length > 0) {
  console.error(`リリース用の .vsix（${version}）を作れません:`);
  errors.forEach((e) => console.error(`  - ${e}`));
  process.exit(1);
}
console.log(`リリース前の検査 OK（${version}）`);
