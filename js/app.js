/* ==========================================================
 * PDF Diff — PDF 差异对比工具
 * 技术方案：pdf.js 提取文本 → jsdiff 计算行级/字符级差异 → 可视化渲染
 * ========================================================== */
"use strict";

pdfjsLib.GlobalWorkerOptions.workerSrc =
  "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js";

/* ---------- 状态 ---------- */
const state = {
  fileA: null, // { file, pages: string[], numPages }
  fileB: null,
  view: "side",
  changes: [], // 当前视图的差异元素 id 列表
  current: -1,
};

/* ---------- DOM ---------- */
const $ = (id) => document.getElementById(id);
const els = {
  dropA: $("dropA"), dropB: $("dropB"),
  fileA: $("fileA"), fileB: $("fileB"),
  compareBtn: $("compareBtn"),
  ignoreSpace: $("ignoreSpace"),
  toolbar: $("toolbar"), stats: $("stats"),
  result: $("result"),
  sideView: $("sideView"), sideGrid: $("sideGrid"),
  headA: $("headA"), headB: $("headB"),
  unifiedView: $("unifiedView"), unifiedList: $("unifiedList"),
  emptyState: $("emptyState"),
  prevDiff: $("prevDiff"), nextDiff: $("nextDiff"), diffPos: $("diffPos"),
  overlay: $("overlay"), overlayText: $("overlayText"),
  toast: $("toast"),
  exportBtn: $("exportBtn"), exportModal: $("exportModal"),
  exportText: $("exportText"), includePrompt: $("includePrompt"),
  copyExport: $("copyExport"), downloadExport: $("downloadExport"),
  exportClose: $("exportClose"),
};

/* ---------- 工具函数 ---------- */
function escapeHtml(s) {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
function formatSize(bytes) {
  if (bytes < 1024) return bytes + " B";
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + " KB";
  return (bytes / 1024 / 1024).toFixed(2) + " MB";
}
let toastTimer = null;
function toast(msg, ms = 2600) {
  els.toast.textContent = msg;
  els.toast.classList.remove("hidden");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => els.toast.classList.add("hidden"), ms);
}
function showOverlay(text) {
  els.overlayText.textContent = text;
  els.overlay.classList.remove("hidden");
}
function hideOverlay() {
  els.overlay.classList.add("hidden");
}

/* ==========================================================
 * 1. 文件选择（点击 / 拖拽）
 * ========================================================== */
function setupDrop(zone, input, side) {
  zone.addEventListener("click", (e) => {
    if (e.target.closest(".dz-clear")) return;
    if (!zone.classList.contains("has-file")) input.click();
  });
  input.addEventListener("change", () => {
    if (input.files[0]) handleFile(side, input.files[0]);
    input.value = "";
  });
  zone.addEventListener("dragover", (e) => {
    e.preventDefault();
    zone.classList.add("dragover");
  });
  zone.addEventListener("dragleave", () => zone.classList.remove("dragover"));
  zone.addEventListener("drop", (e) => {
    e.preventDefault();
    zone.classList.remove("dragover");
    const f = e.dataTransfer.files[0];
    if (f) handleFile(side, f);
  });
  zone.querySelector(".dz-clear").addEventListener("click", (e) => {
    e.stopPropagation();
    state[side] = null;
    zone.classList.remove("has-file");
    zone.querySelector(".dz-empty").classList.remove("hidden");
    zone.querySelector(".dz-file").classList.add("hidden");
    refreshCompareBtn();
  });
}

async function handleFile(side, file) {
  if (file.type !== "application/pdf" && !file.name.toLowerCase().endsWith(".pdf")) {
    toast("请选择 PDF 格式的文件");
    return;
  }
  try {
    showOverlay(`正在读取「${file.name}」…`);
    const doc = await extractPdf(file);
    state[side] = { file, ...doc };
    const zone = side === "fileA" ? els.dropA : els.dropB;
    zone.classList.add("has-file");
    zone.querySelector(".dz-empty").classList.add("hidden");
    const fz = zone.querySelector(".dz-file");
    fz.classList.remove("hidden");
    fz.querySelector(".dz-name").textContent = file.name;
    fz.querySelector(".dz-info").textContent =
      `${doc.numPages} 页 · ${formatSize(file.size)} · ${doc.hasText ? "已提取文本" : "⚠ 未提取到文本（可能是扫描件）"}`;
    if (!doc.hasText) toast("该 PDF 未提取到文本内容，可能是扫描件，无法进行文本比对");
    refreshCompareBtn();
  } catch (err) {
    console.error(err);
    toast("PDF 解析失败：" + (err.message || "文件可能已损坏或加密"));
  } finally {
    hideOverlay();
  }
}

function refreshCompareBtn() {
  els.compareBtn.disabled = !(state.fileA && state.fileB);
}

/* ==========================================================
 * 2. PDF 文本提取（pdf.js）
 * ========================================================== */
async function extractPdf(file) {
  const buf = await file.arrayBuffer();
  const pdf = await pdfjsLib.getDocument({ data: buf }).promise;
  const pages = [];
  for (let i = 1; i <= pdf.numPages; i++) {
    els.overlayText.textContent = `正在解析「${file.name}」第 ${i} / ${pdf.numPages} 页…`;
    const page = await pdf.getPage(i);
    const tc = await page.getTextContent();
    let text = "";
    for (const item of tc.items) {
      if (!("str" in item)) continue;
      text += item.str;
      if (item.hasEOL) text += "\n";
      else if (item.str && !item.str.endsWith(" ")) text += " ";
    }
    pages.push(text);
  }
  const hasText = pages.some((p) => p.trim().length > 0);
  return { pages, numPages: pdf.numPages, hasText };
}

/* 将每页文本拆分为行对象数组 [{text, page}] */
function buildLines(doc, ignoreSpace) {
  const lines = [];
  doc.pages.forEach((pageText, pi) => {
    for (let raw of pageText.split("\n")) {
      if (ignoreSpace) {
        raw = raw.replace(/\s+/g, " ").trim();
        if (!raw) continue;
      } else {
        raw = raw.replace(/[ \t]+/g, " ").trimEnd();
      }
      lines.push({ text: raw, page: pi + 1 });
    }
  });
  return lines;
}

/* ==========================================================
 * 3. 差异计算
 * ========================================================== */
function isCJK(s) {
  return /[\u3400-\u9fff\uf900-\ufaff\u3040-\u30ff\uac00-\ud7af]/.test(s);
}

/* 对一行（行内）做字符级/词级 diff，返回带 <ins>/<del> 的 HTML */
function diffInline(a, b) {
  const parts = isCJK(a + b) ? Diff.diffChars(a, b) : Diff.diffWords(a, b);
  let left = "", right = "";
  for (const p of parts) {
    const esc = escapeHtml(p.value);
    if (p.added) right += `<ins>${esc}</ins>`;
    else if (p.removed) left += `<del>${esc}</del>`;
    else { left += esc; right += esc; }
  }
  return { leftHtml: left, rightHtml: right };
}

/* 核心：按行 diff，将相邻的 删除/新增 合并为 change 块并逐行配对 */
function computeBlocks(linesA, linesB) {
  const ops = Diff.diffArrays(linesA, linesB, {
    comparator: (x, y) => x.text === y.text,
  });

  const blocks = [];
  for (const op of ops) {
    const last = blocks[blocks.length - 1];
    if (op.removed) {
      blocks.push({ type: "del", removed: op.value, added: [] });
    } else if (op.added) {
      if (last && last.type === "del") {
        last.type = "change";
        last.added = op.value;
      } else {
        blocks.push({ type: "add", removed: [], added: op.value });
      }
    } else {
      blocks.push({ type: "eq", removed: op.value, added: op.value });
    }
  }

  let gid = 0;
  for (const b of blocks) {
    if (b.type === "eq") continue;
    b.gid = gid++;
    if (b.type === "change") {
      // 逐行配对，行内做字符级 diff
      const n = Math.max(b.removed.length, b.added.length);
      b.pairs = [];
      for (let i = 0; i < n; i++) {
        const L = b.removed[i] || null;
        const R = b.added[i] || null;
        let leftHtml = null, rightHtml = null;
        if (L && R) {
          const h = diffInline(L.text, R.text);
          leftHtml = h.leftHtml;
          rightHtml = h.rightHtml;
        }
        b.pairs.push({ L, R, leftHtml, rightHtml });
      }
    }
  }

  // 统计
  const stats = {
    addedLines: 0, deletedLines: 0, changedBlocks: 0, totalBlocks: gid,
  };
  for (const b of blocks) {
    if (b.type === "eq") continue;
    stats.addedLines += b.added.length;
    stats.deletedLines += b.removed.length;
    stats.changedBlocks++;
  }
  return { blocks, stats };
}

/* ==========================================================
 * 4. 渲染 —— 左右对照视图
 * ========================================================== */
function renderSide(blocks) {
  const grid = els.sideGrid;
  grid.innerHTML = "";
  let curPageL = null, curPageR = null;

  const pageDivider = (label) => {
    const d = document.createElement("div");
    d.className = "page-divider";
    d.textContent = label;
    grid.appendChild(d);
  };

  for (const b of blocks) {
    if (b.type === "eq") {
      for (const ln of b.removed) {
        if (ln.page !== curPageL) { pageDivider(`第 ${ln.page} 页`); curPageL = ln.page; }
        if (ln.page !== curPageR) { curPageR = ln.page; }
        grid.appendChild(makeCell(ln.text, "same cell-l"));
        grid.appendChild(makeCell(ln.text, "same cell-r"));
      }
    } else {
      const pairs = b.type === "change"
        ? b.pairs
        : (b.type === "del"
          ? b.removed.map((L) => ({ L, R: null }))
          : b.added.map((R) => ({ L: null, R })));

      for (const p of pairs) {
        const row = document.createElement("div");
        row.className = "row-mod";
        row.style.display = "contents";

        if (p.L) {
          if (p.L.page !== curPageL) { pageDivider(`第 ${p.L.page} 页`); curPageL = p.L.page; }
          const cls = p.R === null ? "cell-l cell-del" : "cell-l cell-mod-l";
          const c = makeCell(p.leftHtml || escapeHtml(p.L.text), cls);
          c.dataset.change = b.gid;
          row.appendChild(c);
        } else {
          const c = makeCell("", "cell-l empty");
          c.dataset.change = b.gid;
          row.appendChild(c);
        }
        if (p.R) {
          if (p.R.page !== curPageR) curPageR = p.R.page;
          const cls = p.L === null ? "cell-r cell-add" : "cell-r cell-mod-r";
          const c = makeCell(p.rightHtml || escapeHtml(p.R.text), cls);
          c.dataset.change = b.gid;
          row.appendChild(c);
        } else {
          const c = makeCell("", "cell-r empty");
          c.dataset.change = b.gid;
          row.appendChild(c);
        }
        grid.appendChild(row);
      }
    }
  }
}

function makeCell(html, cls) {
  const c = document.createElement("div");
  c.className = "cell " + cls;
  if (!html) c.innerHTML = "&nbsp;";
  else c.innerHTML = html;
  return c;
}

/* ==========================================================
 * 5. 渲染 —— 合并视图
 * ========================================================== */
function renderUnified(blocks) {
  const list = els.unifiedList;
  list.innerHTML = "";
  let curPage = null;

  const divider = (label) => {
    const d = document.createElement("div");
    d.className = "u-divider";
    d.textContent = label;
    list.appendChild(d);
  };
  const row = (kind, html, gid) => {
    if (gid != null) {
      // 每个差异块前可能需要页码标记
    }
    const r = document.createElement("div");
    r.className = "u-row u-" + kind + (gid != null ? " in-change" : "");
    if (gid != null) r.dataset.change = gid;
    const g = document.createElement("div");
    g.className = "u-gutter";
    g.textContent = kind === "del" ? "−" : kind === "add" ? "+" : "";
    const t = document.createElement("div");
    t.className = "u-text";
    t.innerHTML = html || "&nbsp;";
    r.appendChild(g);
    r.appendChild(t);
    list.appendChild(r);
    return r;
  };

  for (const b of blocks) {
    if (b.type === "eq") {
      for (const ln of b.removed) {
        if (ln.page !== curPage) { divider(`第 ${ln.page} 页`); curPage = ln.page; }
        row("same", escapeHtml(ln.text), null);
      }
    } else if (b.type === "change") {
      for (const p of b.pairs) {
        if (p.L) {
          if (p.L.page !== curPage) { divider(`第 ${p.L.page} 页`); curPage = p.L.page; }
          row("del", p.leftHtml || escapeHtml(p.L.text), b.gid);
        }
        if (p.R) {
          if (p.R.page !== curPage) { divider(`第 ${p.R.page} 页`); curPage = p.R.page; }
          row("add", p.rightHtml || escapeHtml(p.R.text), b.gid);
        }
      }
    } else if (b.type === "del") {
      for (const ln of b.removed) {
        if (ln.page !== curPage) { divider(`第 ${ln.page} 页`); curPage = ln.page; }
        row("del", escapeHtml(ln.text), b.gid);
      }
    } else {
      for (const ln of b.added) {
        if (ln.page !== curPage) { divider(`第 ${ln.page} 页`); curPage = ln.page; }
        row("add", escapeHtml(ln.text), b.gid);
      }
    }
  }
}

/* ==========================================================
 * 6. 差异导航
 * ========================================================== */
function collectChanges() {
  const nodes = els.result.querySelectorAll("[data-change]");
  const seen = new Set();
  const ids = [];
  nodes.forEach((n) => {
    const id = n.dataset.change;
    if (!seen.has(id)) { seen.add(id); ids.push(id); }
  });
  state.changes = ids;
  state.current = -1;
  updateNavPos();
}

function gotoChange(step) {
  if (!state.changes.length) return;
  let idx = state.current + step;
  if (idx < 0) idx = state.changes.length - 1;
  if (idx >= state.changes.length) idx = 0;
  state.current = idx;
  els.result.querySelectorAll(".current").forEach((n) => n.classList.remove("current"));
  const id = state.changes[idx];
  const nodes = els.result.querySelectorAll(`[data-change="${id}"]`);
  nodes.forEach((n) => n.classList.add("current"));
  const first = nodes[0];
  if (first) {
    const scroller = first.closest(".diff-scroll");
    if (scroller) {
      const sr = scroller.getBoundingClientRect();
      const fr = first.getBoundingClientRect();
      scroller.scrollTo({
        top: scroller.scrollTop + (fr.top - sr.top) - sr.height / 2 + fr.height,
        behavior: "smooth",
      });
    }
  }
  updateNavPos();
}

function updateNavPos() {
  els.diffPos.textContent = state.changes.length
    ? `${state.current + 1} / ${state.changes.length}`
    : "0 / 0";
}

/* ==========================================================
 * 7. 主流程：开始对比
 * ========================================================== */
async function compare() {
  if (!state.fileA || !state.fileB) return;
  const ignoreSpace = els.ignoreSpace.checked;
  try {
    showOverlay("正在计算差异…");
    const linesA = buildLines(state.fileA, ignoreSpace);
    const linesB = buildLines(state.fileB, ignoreSpace);

    const { blocks, stats } = computeBlocks(linesA, linesB);

    // 保存对比结果，供导出报告使用
    state.diffData = {
      blocks, stats,
      nameA: state.fileA.file.name, nameB: state.fileB.file.name,
      pagesA: state.fileA.numPages, pagesB: state.fileB.numPages,
    };

    // 页眉文件名
    els.headA.innerHTML = `<span class="dot"></span>原文件：${escapeHtml(state.fileA.file.name)}`;
    els.headB.innerHTML = `<span class="dot"></span>对比文件：${escapeHtml(state.fileB.file.name)}`;

    renderSide(blocks);
    renderUnified(blocks);

    // 工具栏统计
    els.stats.innerHTML = stats.totalBlocks === 0
      ? `<span class="chip same">✓ 两个文件内容完全一致</span>`
      : `<span class="chip add">+ 新增 ${stats.addedLines} 行</span>
         <span class="chip del">− 删除 ${stats.deletedLines} 行</span>
         <span class="chip mod">~ ${stats.changedBlocks} 处差异</span>`;

    els.toolbar.classList.remove("hidden");
    els.result.classList.remove("hidden");
    els.emptyState.classList.add("hidden");
    collectChanges();

    if (stats.totalBlocks > 0) gotoChange(1);
    toast(stats.totalBlocks === 0 ? "两个文件内容完全一致" : `对比完成，共发现 ${stats.totalBlocks} 处差异`);
  } catch (err) {
    console.error(err);
    toast("对比失败：" + (err.message || "未知错误"));
  } finally {
    hideOverlay();
  }
}

/* ==========================================================
 * 8. 视图切换 & 事件绑定
 * ========================================================== */
function switchView(view) {
  state.view = view;
  document.querySelectorAll(".vt-btn").forEach((b) =>
    b.classList.toggle("active", b.dataset.view === view));
  els.sideView.classList.toggle("hidden", view !== "side");
  els.unifiedView.classList.toggle("hidden", view !== "unified");
  collectChanges();
  if (state.changes.length) gotoChange(1);
}

setupDrop(els.dropA, els.fileA, "fileA");
setupDrop(els.dropB, els.fileB, "fileB");

els.compareBtn.addEventListener("click", compare);
document.querySelectorAll(".vt-btn").forEach((b) =>
  b.addEventListener("click", () => switchView(b.dataset.view)));
els.prevDiff.addEventListener("click", () => gotoChange(-1));
els.nextDiff.addEventListener("click", () => gotoChange(1));

document.addEventListener("keydown", (e) => {
  if (els.result.classList.contains("hidden")) return;
  if (e.key === "ArrowUp" || (e.key === "n" && e.shiftKey)) { e.preventDefault(); gotoChange(-1); }
  if (e.key === "ArrowDown" || e.key === "n") { e.preventDefault(); gotoChange(1); }
});

/* ==========================================================
 * 9. 导出差异报告（供大模型分析）
 * ========================================================== */

/* 生成适合大模型阅读的结构化 Markdown 差异报告 */
function buildExportText(withPrompt) {
  const d = state.diffData;
  if (!d) return "";

  const now = new Date();
  const pad = (n) => String(n).padStart(2, "0");
  const ts = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${pad(now.getHours())}:${pad(now.getMinutes())}`;

  const L = [];
  L.push("# PDF 差异对比报告", "");
  L.push("## 基本信息", "");
  L.push(`- 原文件（旧版本）：${d.nameA}（${d.pagesA} 页）`);
  L.push(`- 对比文件（新版本）：${d.nameB}（${d.pagesB} 页）`);
  if (d.stats.totalBlocks === 0) {
    L.push("- 对比结果：两个文件内容完全一致，无差异");
  } else {
    L.push(`- 对比结果：新增 ${d.stats.addedLines} 行、删除 ${d.stats.deletedLines} 行，共 ${d.stats.changedBlocks} 处差异`);
  }
  L.push(`- 导出时间：${ts}`, "");
  L.push("## 差异详情", "");

  if (d.stats.totalBlocks === 0) {
    L.push("两个文件内容完全一致，无任何差异。", "");
  } else {
    L.push("> 说明：以 `-` 开头的行为原文件（旧版本）中的内容；以 `+` 开头的行为对比文件（新版本）中的内容；以两个空格缩进的是保持不变的上下文行；未列出的部分两个版本完全一致。", "");

    const usedCtx = new Set();
    let n = 0;
    d.blocks.forEach((b, i) => {
      if (b.type === "eq") return;
      n++;
      const first = b.removed[0] || b.added[0];
      L.push(`### 差异 ${n}（第 ${first.page} 页）`, "");

      const prev = d.blocks[i - 1];
      if (prev && prev.type === "eq" && prev.removed.length) {
        const c = prev.removed[prev.removed.length - 1];
        if (!usedCtx.has(c)) { usedCtx.add(c); L.push(`  ${c.text}`); }
      }
      const emit = (arr, sign) => arr.forEach((ln) => L.push(`${sign} ${ln.text}`));
      if (b.type === "del" || b.type === "change") emit(b.removed, "-");
      if (b.type === "add" || b.type === "change") emit(b.added, "+");

      const next = d.blocks[i + 1];
      if (next && next.type === "eq" && next.removed.length) {
        const c = next.removed[0];
        if (!usedCtx.has(c)) { usedCtx.add(c); L.push(`  ${c.text}`); }
      }
      L.push("");
    });
  }

  if (withPrompt) {
    L.push("## 分析指令", "");
    L.push("请基于上述差异报告完成以下分析：", "");
    L.push("1. 用简明的语言总结本次变更的主要内容与变更目的；");
    L.push("2. 按重要性列出所有值得关注的变更点，并说明其影响；");
    L.push("3. 指出可能的遗漏、不一致或潜在风险（例如：条款冲突、版本号未同步更新、前后引用不一致等）；");
    L.push("4. 如有需要，给出具体的修改或补充建议。", "");
  }
  return L.join("\n");
}

function refreshExportText() {
  els.exportText.value = buildExportText(els.includePrompt.checked);
}

/* 打开 / 关闭弹窗 */
els.exportBtn.addEventListener("click", () => {
  if (!state.diffData) { toast("请先完成一次对比"); return; }
  refreshExportText();
  els.exportModal.classList.remove("hidden");
});
function closeExportModal() {
  els.exportModal.classList.add("hidden");
}
els.exportClose.addEventListener("click", closeExportModal);
els.exportModal.addEventListener("click", (e) => {
  if (e.target === els.exportModal) closeExportModal();
});
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") closeExportModal();
});

/* 勾选项变化时重新生成 */
els.includePrompt.addEventListener("change", refreshExportText);

/* 复制全文 */
els.copyExport.addEventListener("click", async () => {
  const txt = els.exportText.value;
  try {
    await navigator.clipboard.writeText(txt);
    toast("已复制到剪贴板，可直接粘贴给大模型");
  } catch {
    els.exportText.select();
    document.execCommand("copy");
    toast("已复制到剪贴板");
  }
});

/* 下载 .md 文件 */
els.downloadExport.addEventListener("click", () => {
  const txt = els.exportText.value;
  const blob = new Blob(["\ufeff" + txt], { type: "text/markdown;charset=utf-8" });
  const now = new Date();
  const pad = (n) => String(n).padStart(2, "0");
  const stamp = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}`;
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = `pdf-diff-report-${stamp}.md`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(a.href);
  toast("报告已下载");
});
