(function () {
  // @ts-ignore
  const vscode = acquireVsCodeApi();
  const content = document.getElementById('content');
  const dynamicStyle = document.getElementById('dynamic-style');
  const caret = document.getElementById('caret');

  /**
   * 元テキスト上の位置 { line, col }（col は UTF-16 単位）
   * @typedef {{ line: number, col: number }} SourcePos
   * @typedef {{ anchor: SourcePos, active: SourcePos }} SourceSelection
   */

  /** @type {{ uri?: string, switched?: boolean, line?: number, selection?: SourceSelection }} */
  const state = vscode.getState() || {};
  let initialized = false;

  // -------------------------------------------------------------------------
  // スクロール
  // -------------------------------------------------------------------------

  /** 行番号(小数可)の位置へスクロールする */
  function scrollToLine(line) {
    const lines = content.children;
    if (lines.length === 0) {
      return;
    }
    const index = Math.max(0, Math.min(lines.length - 1, Math.floor(line)));
    const el = lines[index];
    const next = lines[index + 1];
    let top = el.offsetTop;
    const fraction = line - Math.floor(line);
    if (next && fraction > 0) {
      top += (next.offsetTop - el.offsetTop) * fraction;
    }
    window.scrollTo(0, top - 24);
  }

  /** 画面上端に表示されている行番号 */
  function topVisibleLine() {
    const lines = content.children;
    const y = window.scrollY + 24;
    let lo = 0;
    let hi = lines.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (lines[mid].offsetTop <= y) {
        lo = mid;
      } else {
        hi = mid - 1;
      }
    }
    return lo;
  }

  // -------------------------------------------------------------------------
  // 表示位置 ⇔ 元テキスト位置の変換
  //   文字列は <span data-c="元の開始位置"> で、ルビは <ruby data-s data-e> で出力されている
  // -------------------------------------------------------------------------

  /** 要素の先頭の元位置 */
  function startColOf(el) {
    if (el.matches('ruby')) {
      return Number(el.dataset.s);
    }
    if (el.matches('[data-c]')) {
      return Number(el.dataset.c);
    }
    const first = el.querySelector('ruby, [data-c]');
    return first ? startColOf(first) : 0;
  }

  /** ノードの末尾の元位置 */
  function endColOf(node) {
    const el = node.nodeType === Node.TEXT_NODE ? node.parentElement : node;
    const ruby = el.closest('ruby');
    if (ruby) {
      return Number(ruby.dataset.e);
    }
    if (el.matches('[data-c]')) {
      return Number(el.dataset.c) + el.textContent.length;
    }
    const all = el.querySelectorAll('ruby, [data-c]');
    return all.length > 0 ? endColOf(all[all.length - 1]) : 0;
  }

  /**
   * DOM 上の位置を元テキストの位置に変換する
   * @param {Node} node
   * @param {number} offset
   * @param {boolean} isEnd ルビ文字の中を指している場合、範囲の終端ならルビ記法の末尾に寄せる
   * @returns {SourcePos | undefined}
   */
  function toSource(node, offset, isEnd) {
    if (node === content) {
      const lines = content.children;
      if (lines.length === 0) {
        return undefined;
      }
      if (offset >= lines.length) {
        const last = lines[lines.length - 1];
        return { line: Number(last.dataset.line), col: endColOf(last) };
      }
      return { line: Number(lines[offset].dataset.line), col: 0 };
    }
    const el = node.nodeType === Node.TEXT_NODE ? node.parentElement : node;
    if (!el || !content.contains(el)) {
      return undefined;
    }
    const lineEl = el.closest('.line');
    if (!lineEl) {
      return undefined;
    }
    const line = Number(lineEl.dataset.line);

    // ルビ文字（rt / rp）の中 → ルビ記法全体の先頭または末尾
    const ruby = el.closest('ruby');
    if (ruby && el.closest('rt, rp')) {
      return { line, col: Number(isEnd ? ruby.dataset.e : ruby.dataset.s) };
    }
    if (node.nodeType === Node.TEXT_NODE) {
      const chunk = el.closest('[data-c]');
      return { line, col: chunk ? Number(chunk.dataset.c) + offset : 0 };
    }
    // 要素 + 子の番号
    if (offset === 0) {
      return { line, col: el === lineEl ? 0 : startColOf(el) };
    }
    return { line, col: endColOf(el.childNodes[offset - 1]) };
  }

  /**
   * 元テキストの位置を DOM 上の位置に変換する
   * @param {SourcePos} pos
   * @returns {{ node: Node, offset: number } | undefined}
   */
  function toDom(pos) {
    const lineEl = content.children[pos.line];
    if (!lineEl) {
      return undefined;
    }
    for (const chunk of lineEl.querySelectorAll('[data-c]')) {
      const start = Number(chunk.dataset.c);
      const text = chunk.firstChild;
      if (text && pos.col >= start && pos.col <= start + text.length) {
        return { node: text, offset: pos.col - start };
      }
    }
    // ルビ記法の中（| や《》の位置）→ ルビの直前
    for (const ruby of lineEl.querySelectorAll('ruby')) {
      if (pos.col >= Number(ruby.dataset.s) && pos.col < Number(ruby.dataset.e)) {
        const parent = ruby.parentNode;
        return { node: parent, offset: Array.prototype.indexOf.call(parent.childNodes, ruby) };
      }
    }
    return pos.col === 0 ? { node: lineEl, offset: 0 } : { node: lineEl, offset: lineEl.childNodes.length };
  }

  /** 現在の選択範囲（元テキスト位置） */
  function currentSelection() {
    const sel = window.getSelection();
    if (!sel || sel.rangeCount === 0 || !sel.anchorNode || !sel.focusNode) {
      return undefined;
    }
    // 範囲の前後関係を判定し、終端側はルビ記法の末尾に寄せる
    const range = sel.getRangeAt(0);
    const forward = range.startContainer === sel.anchorNode && range.startOffset === sel.anchorOffset;
    const anchor = toSource(sel.anchorNode, sel.anchorOffset, !forward && !sel.isCollapsed);
    const active = toSource(sel.focusNode, sel.focusOffset, forward && !sel.isCollapsed);
    return anchor && active ? { anchor, active } : undefined;
  }

  /** 元テキスト位置で選択範囲を設定する */
  function applySelection(selection, reveal) {
    const anchor = toDom(selection.anchor);
    const active = toDom(selection.active);
    if (!anchor || !active) {
      return;
    }
    state.selection = selection;
    vscode.setState(state);
    const sel = window.getSelection();
    sel.setBaseAndExtent(anchor.node, anchor.offset, active.node, active.offset);
    updateCaret();
    if (reveal) {
      revealCaret();
    }
  }

  // -------------------------------------------------------------------------
  // カーソル（キャレット）
  //   閲覧専用のため contenteditable は使わず、選択範囲の端に独自のカーソルを描画する
  // -------------------------------------------------------------------------

  let windowFocused = document.hasFocus();

  function caretRect() {
    const sel = window.getSelection();
    if (!sel || !sel.focusNode || !content.contains(sel.focusNode)) {
      return undefined;
    }
    const range = document.createRange();
    range.setStart(sel.focusNode, sel.focusOffset);
    range.collapse(true);
    const rects = range.getClientRects();
    if (rects.length > 0) {
      return rects[0];
    }
    // 空行など、文字のない位置
    const el = sel.focusNode.nodeType === Node.TEXT_NODE ? sel.focusNode.parentElement : sel.focusNode;
    const target = el.childNodes[sel.focusOffset] || el;
    const rect = (target.nodeType === Node.ELEMENT_NODE ? target : el).getBoundingClientRect();
    return rect;
  }

  // -------------------------------------------------------------------------
  // ブックマーク
  // -------------------------------------------------------------------------

  /** @type {Array<{ line: number, name: string }>} */
  let bookmarks = [];

  /** ブックマークのある行に bookmarked クラスと名前（ツールチップ）を付ける */
  function applyBookmarks() {
    content.querySelectorAll('.line.bookmarked').forEach((el) => {
      el.classList.remove('bookmarked');
      el.removeAttribute('title');
    });
    for (const b of bookmarks) {
      const el = content.children[b.line];
      if (el) {
        el.classList.add('bookmarked');
        el.title = `ブックマーク: ${b.name}`;
      }
    }
  }

  /** カーソルのある行に current クラスを付ける（行番号の強調表示用） */
  let currentLineEl = null;
  function updateCurrentLine() {
    const sel = window.getSelection();
    const node = sel && sel.focusNode;
    const el = node && content.contains(node) ? (node.nodeType === Node.TEXT_NODE ? node.parentElement : node) : null;
    const lineEl = el ? el.closest('.line') : null;
    if (lineEl === currentLineEl) {
      return;
    }
    if (currentLineEl) {
      currentLineEl.classList.remove('current');
    }
    if (lineEl) {
      lineEl.classList.add('current');
    }
    currentLineEl = lineEl;
    // ミニマップのカーソル行の表示を更新
    schedulePaintMinimap();
  }

  function updateCaret() {
    updateCurrentLine();
    // フォーカスの有無は確実に検知できないことがあるため、フォーカスが無くても描画する（点滅なし・薄く表示）
    const rect = caretRect();
    if (!rect) {
      caret.hidden = true;
      return;
    }
    caret.classList.toggle('inactive', !windowFocused);
    const fontSize = parseFloat(getComputedStyle(content).fontSize) || 16;
    const height = rect.height > 0 ? Math.min(rect.height, fontSize * 1.4) : fontSize * 1.2;
    const lineHeight = rect.height > 0 ? rect.height : height;
    caret.hidden = false;
    caret.style.left = `${rect.left + window.scrollX - 1}px`;
    caret.style.top = `${rect.top + window.scrollY + (lineHeight - height) / 2}px`;
    caret.style.height = `${height}px`;
    // 移動のたびに点滅をリセット
    caret.classList.remove('blink');
    void caret.offsetWidth;
    caret.classList.add('blink');
  }

  function revealCaret() {
    const rect = caretRect();
    if (!rect) {
      return;
    }
    const margin = 40;
    if (rect.top < margin) {
      window.scrollBy(0, rect.top - margin);
    } else if (rect.bottom > window.innerHeight - margin) {
      window.scrollBy(0, rect.bottom - window.innerHeight + margin);
    }
  }

  let selectionTimer = 0;
  document.addEventListener('selectionchange', () => {
    updateCaret();
    clearTimeout(selectionTimer);
    selectionTimer = setTimeout(() => {
      const selection = currentSelection();
      if (selection) {
        state.selection = selection;
        vscode.setState(state);
        vscode.postMessage({ type: 'selection', selection });
      }
    }, 100);
  });

  window.addEventListener('focus', () => {
    windowFocused = true;
    // フォーカス移動で選択範囲が失われていたら、保持している位置を復元する
    const sel = window.getSelection();
    if (state.selection && (!sel || sel.rangeCount === 0 || !content.contains(sel.focusNode))) {
      applySelection(state.selection, false);
    }
    updateCaret();
  });
  window.addEventListener('blur', () => {
    windowFocused = false;
    updateCaret();
  });
  window.addEventListener('resize', updateCaret);

  /** 表示上の行（折り返し後の行）の先頭・末尾へ移動する */
  function moveToVisualLineEdge(sel, toEnd, extend) {
    const rect = caretRect();
    if (!rect) {
      return;
    }
    const box = content.getBoundingClientRect();
    const x = toEnd ? box.right - 1 : box.left + 1;
    const y = rect.top + rect.height / 2;
    const target = document.caretRangeFromPoint(x, y);
    if (!target || !content.contains(target.startContainer)) {
      return;
    }
    if (extend) {
      sel.extend(target.startContainer, target.startOffset);
    } else {
      sel.collapse(target.startContainer, target.startOffset);
    }
  }

  // キー操作: 矢印キーなどでカーソル移動・範囲選択
  const MOVES = {
    ArrowLeft: ['backward', 'character'],
    ArrowRight: ['forward', 'character'],
    ArrowUp: ['backward', 'line'],
    ArrowDown: ['forward', 'line'],
    Home: ['backward', 'lineboundary'],
    End: ['forward', 'lineboundary'],
  };
  document.addEventListener('keydown', (event) => {
    const sel = window.getSelection();
    if ((event.ctrlKey || event.metaKey) && !event.altKey && event.key.toLowerCase() === 'a') {
      event.preventDefault();
      sel.selectAllChildren(content);
      return;
    }
    const move = MOVES[event.key];
    if (!move || event.altKey || !sel || !sel.focusNode || !content.contains(sel.focusNode)) {
      return;
    }
    event.preventDefault();
    const alter = event.shiftKey ? 'extend' : 'move';
    let [direction, granularity] = move;
    if (event.ctrlKey || event.metaKey) {
      granularity = event.key === 'Home' || event.key === 'End' ? 'documentboundary' : granularity === 'character' ? 'word' : granularity;
    }
    if (granularity === 'documentboundary') {
      // 本文（#content）の先頭・末尾へ
      const lineEl = direction === 'forward' ? content.lastElementChild : content.firstElementChild;
      if (lineEl) {
        const offset = direction === 'forward' ? lineEl.childNodes.length : 0;
        if (event.shiftKey) {
          sel.extend(lineEl, offset);
        } else {
          sel.collapse(lineEl, offset);
        }
      }
    } else if (granularity === 'lineboundary') {
      // Chromium の modify('lineboundary') はルビの境目で止まるため、表示上の行の左端・右端の座標から求める
      moveToVisualLineEdge(sel, direction === 'forward', event.shiftKey);
    } else if (!event.shiftKey && !sel.isCollapsed && granularity === 'character') {
      // 選択中に左右キー: 選択の端へ移動
      const range = sel.getRangeAt(0);
      const edge = direction === 'backward' ? [range.startContainer, range.startOffset] : [range.endContainer, range.endOffset];
      sel.collapse(edge[0], edge[1]);
    } else {
      sel.modify(alter, direction, granularity);
    }
    revealCaret();
  });

  // コピー: ルビ（読み）を除き、行は改行でつなぐ
  document.addEventListener('copy', (event) => {
    const sel = window.getSelection();
    if (!sel || sel.rangeCount === 0 || sel.isCollapsed) {
      return;
    }
    const fragment = sel.getRangeAt(0).cloneContents();
    fragment.querySelectorAll('rt, rp').forEach((el) => el.remove());
    const lines = fragment.querySelectorAll('.line');
    const text = lines.length > 0 ? Array.from(lines, (el) => el.textContent).join('\n') : fragment.textContent;
    event.clipboardData.setData('text/plain', text);
    event.preventDefault();
  });

  // -------------------------------------------------------------------------
  // 拡張機能とのメッセージ
  // -------------------------------------------------------------------------

  window.addEventListener('message', (event) => {
    const msg = event.data;
    switch (msg.type) {
      case 'update': {
        const scrollY = window.scrollY;
        // 再描画で DOM が作り直されるので、選択範囲を元テキスト位置で保持して復元する
        let selection = (initialized && currentSelection()) || state.selection;
        if (msg.reset) {
          // 前話・次話に切り替えた: 先頭から表示し、カーソルは引き継がない
          selection = undefined;
          state.selection = undefined;
          state.line = 0;
          window.getSelection().removeAllRanges();
        }
        dynamicStyle.textContent = msg.css;
        content.innerHTML = msg.html;
        content.classList.toggle('line-numbers', !!msg.lineNumbers);
        bookmarks = msg.bookmarks || [];
        applyBookmarks();
        setMinimap(msg.minimap);
        state.uri = msg.uri;
        state.switched = msg.switched;
        if (msg.reset) {
          initialized = true;
          window.scrollTo(0, 0);
        } else if (!initialized) {
          initialized = true;
          if (typeof state.line === 'number') {
            scrollToLine(state.line);
          }
        } else {
          window.scrollTo(0, scrollY);
        }
        if (selection) {
          applySelection(selection, false);
        }
        vscode.setState(state);
        updateCaret();
        scheduleMeasureMinimap();
        break;
      }
      case 'scrollToLine':
        scrollToLine(msg.line);
        updateCaret();
        break;
      case 'bookmarks':
        bookmarks = msg.bookmarks || [];
        applyBookmarks();
        schedulePaintMinimap();
        break;
      case 'setSelection':
        applySelection(msg.selection, false);
        break;
    }
  });

  // -------------------------------------------------------------------------
  // ミニマップ（右端の縮小表示）
  //   本文の各文字列の表示位置（折り返し後）を測っておき、canvas に細い線として描く。
  //   測り直しは内容・幅が変わったときだけで、スクロール時は描き直しのみ行う。
  // -------------------------------------------------------------------------

  const minimap = document.getElementById('minimap');
  const minimapCanvas = minimap.querySelector('canvas');
  /** 文章が短いときに大きくなりすぎないよう、縮尺の上限を設ける */
  const MINIMAP_MAX_SCALE = 0.2;
  const MINIMAP_PADDING = 4;
  let minimapEnabled = false;
  /**
   * 測定結果（文書上の座標）
   * @type {{ width: number, docHeight: number, runs: Array<{ x: number, y: number, w: number, h: number, color: string }>, lineTops: number[], lineHeights: number[] } | undefined}
   */
  let minimapLayout;
  let minimapDrag;
  let minimapHover = false;

  function cssVar(name, fallback) {
    return getComputedStyle(document.documentElement).getPropertyValue(name).trim() || fallback;
  }

  /** 色分けのクラス（s1 など）を持つ最も近い要素のクラス名 */
  function styleClassOf(el) {
    for (let e = el; e && e !== content; e = e.parentElement) {
      const m = /\bs\d+\b/.exec(e.className);
      if (m) {
        return m[0];
      }
    }
    return '';
  }

  function measureMinimap() {
    if (!minimapEnabled) {
      return;
    }
    const box = content.getBoundingClientRect();
    const scrollY = window.scrollY;
    const colors = new Map();
    const runs = [];
    for (const span of content.querySelectorAll('[data-c]')) {
      const cls = styleClassOf(span);
      let color = colors.get(cls);
      if (!color) {
        color = getComputedStyle(span).color;
        colors.set(cls, color);
      }
      for (const r of span.getClientRects()) {
        runs.push({ x: r.left - box.left, y: r.top + scrollY, w: r.width, h: r.height, color });
      }
    }
    const lineTops = [];
    const lineHeights = [];
    for (const line of content.children) {
      const r = line.getBoundingClientRect();
      lineTops.push(r.top + scrollY);
      lineHeights.push(r.height);
    }
    minimapLayout = { width: box.width, docHeight: document.documentElement.scrollHeight, runs, lineTops, lineHeights };
    paintMinimap();
  }

  function minimapScale() {
    return minimapLayout ? Math.min(MINIMAP_MAX_SCALE, minimap.clientHeight / minimapLayout.docHeight) : 0;
  }

  function paintMinimap() {
    if (!minimapEnabled || !minimapLayout) {
      return;
    }
    const cssW = minimap.clientWidth;
    const cssH = minimap.clientHeight;
    const dpr = window.devicePixelRatio || 1;
    if (minimapCanvas.width !== Math.round(cssW * dpr) || minimapCanvas.height !== Math.round(cssH * dpr)) {
      minimapCanvas.width = Math.round(cssW * dpr);
      minimapCanvas.height = Math.round(cssH * dpr);
    }
    const ctx = minimapCanvas.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, cssW, cssH);

    const scale = minimapScale();
    const sx = (cssW - MINIMAP_PADDING * 2) / Math.max(1, minimapLayout.width);

    // カーソル行
    if (currentLineEl) {
      const index = Array.prototype.indexOf.call(content.children, currentLineEl);
      if (index >= 0) {
        ctx.fillStyle = cssVar('--vscode-minimap-selectionHighlight', 'rgba(38, 79, 120, 0.8)');
        ctx.fillRect(0, minimapLayout.lineTops[index] * scale, cssW, Math.max(2, minimapLayout.lineHeights[index] * scale));
      }
    }

    // 本文（文字の部分だけを細い線で）
    ctx.globalAlpha = 0.75;
    for (const run of minimapLayout.runs) {
      ctx.fillStyle = run.color;
      const h = Math.max(1, run.h * scale * 0.6);
      ctx.fillRect(MINIMAP_PADDING + run.x * sx, run.y * scale + (run.h * scale - h) / 2, Math.max(1, run.w * sx), h);
    }
    ctx.globalAlpha = 1;

    // ブックマーク（青い横線）
    ctx.fillStyle = '#3794FF';
    for (const b of bookmarks) {
      const top = minimapLayout.lineTops[b.line];
      if (top !== undefined) {
        ctx.fillRect(0, top * scale, cssW, Math.max(2, Math.min(4, minimapLayout.lineHeights[b.line] * scale)));
      }
    }

    // 表示中の範囲（スライダー）
    ctx.fillStyle = minimapDrag
      ? cssVar('--vscode-minimapSlider-activeBackground', 'rgba(191, 191, 191, 0.2)')
      : minimapHover
        ? cssVar('--vscode-minimapSlider-hoverBackground', 'rgba(100, 100, 100, 0.35)')
        : cssVar('--vscode-minimapSlider-background', 'rgba(121, 121, 121, 0.2)');
    ctx.fillRect(0, window.scrollY * scale, cssW, Math.max(4, window.innerHeight * scale));
  }

  let minimapMeasureFrame = 0;
  function scheduleMeasureMinimap() {
    cancelAnimationFrame(minimapMeasureFrame);
    minimapMeasureFrame = requestAnimationFrame(measureMinimap);
  }
  let minimapPaintFrame = 0;
  function schedulePaintMinimap() {
    cancelAnimationFrame(minimapPaintFrame);
    minimapPaintFrame = requestAnimationFrame(paintMinimap);
  }

  function setMinimap(options) {
    minimapEnabled = !!(options && options.enabled);
    const width = minimapEnabled ? Math.max(40, Math.min(300, Number(options.width) || 80)) : 0;
    document.documentElement.style.setProperty('--tnv-minimap-width', `${width}px`);
    minimap.hidden = !minimapEnabled;
    if (!minimapEnabled) {
      minimapLayout = undefined;
    }
  }

  /** ミニマップ上の位置（y）を、表示中の範囲の上端がどこに来るかとしてスクロールする */
  function scrollFromMinimap(clientY, offset) {
    const scale = minimapScale();
    if (scale > 0) {
      const y = clientY - minimap.getBoundingClientRect().top;
      window.scrollTo(0, (y - offset) / scale);
    }
  }

  minimap.addEventListener('mousedown', (event) => {
    if (event.button !== 0 || !minimapLayout) {
      return;
    }
    // 本文の選択範囲（カーソル）を消さない
    event.preventDefault();
    const scale = minimapScale();
    const y = event.clientY - minimap.getBoundingClientRect().top;
    const sliderTop = window.scrollY * scale;
    const sliderHeight = Math.max(4, window.innerHeight * scale);
    if (y >= sliderTop && y <= sliderTop + sliderHeight) {
      // スライダーをつかんだ: つかんだ位置を保ったままドラッグ
      minimapDrag = { offset: y - sliderTop };
    } else {
      // それ以外: クリックした位置が表示範囲の中央に来るように移動し、そのままドラッグ
      minimapDrag = { offset: sliderHeight / 2 };
      scrollFromMinimap(event.clientY, minimapDrag.offset);
    }
    schedulePaintMinimap();
  });
  window.addEventListener('mousemove', (event) => {
    if (minimapDrag) {
      scrollFromMinimap(event.clientY, minimapDrag.offset);
    }
  });
  window.addEventListener('mouseup', () => {
    if (minimapDrag) {
      minimapDrag = undefined;
      schedulePaintMinimap();
    }
  });
  minimap.addEventListener('mouseenter', () => {
    minimapHover = true;
    schedulePaintMinimap();
  });
  minimap.addEventListener('mouseleave', () => {
    minimapHover = false;
    schedulePaintMinimap();
  });

  // 幅の変更やフォントの読み込みで折り返しが変わったら測り直す
  new ResizeObserver(() => scheduleMeasureMinimap()).observe(content);
  window.addEventListener('resize', scheduleMeasureMinimap);
  if (document.fonts) {
    document.fonts.ready.then(scheduleMeasureMinimap);
  }
  window.addEventListener('scroll', schedulePaintMinimap);

  // -------------------------------------------------------------------------
  // 右上の「一番上へ」「一番下へ」ボタン
  // -------------------------------------------------------------------------

  const scrollTopButton = document.getElementById('scroll-top');
  const scrollBottomButton = document.getElementById('scroll-bottom');
  // ボタンを押しても本文の選択範囲（カーソル）が消えないようにする
  for (const button of [scrollTopButton, scrollBottomButton]) {
    button.addEventListener('mousedown', (event) => event.preventDefault());
  }
  scrollTopButton.addEventListener('click', () => window.scrollTo(0, 0));
  scrollBottomButton.addEventListener('click', () => {
    // 本文の後ろには余白があるため、最後の行が画面の下端に来る位置までにする
    const last = content.lastElementChild;
    const bottom = last ? last.offsetTop + last.offsetHeight + 24 : document.documentElement.scrollHeight;
    window.scrollTo(0, Math.max(0, bottom - window.innerHeight));
  });

  let scrollTimer = 0;
  window.addEventListener('scroll', () => {
    clearTimeout(scrollTimer);
    scrollTimer = setTimeout(() => {
      state.line = topVisibleLine();
      vscode.setState(state);
      vscode.postMessage({ type: 'scroll', line: state.line });
    }, 100);
  });

  vscode.postMessage({ type: 'ready' });
})();
