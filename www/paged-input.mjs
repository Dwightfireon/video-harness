/* 大文本输入的流畅化：把超长内容分页编辑，textarea 里永远只放一页。
 *
 * 为什么需要：textarea 每敲一个字都会重新排版**全部**内容，成本随「字数 × 换行行数」线性增长。
 * 实测（4× CPU 降速的 Chrome）：
 *   20k 字 / 1334 行 → 每次按键 p95 13ms
 *   60k 字 / 4001 行 → 每次按键 p95 39ms   ← 这就是"打完就卡"
 * CSS（contain / content-visibility / wrap=off / 固定高度）实测全部无效，
 * 因为排版成本来自浏览器内部对整段文本的重新整形，不是我们的样式。
 *
 * 做法：全文保存在 pages 数组里，textarea 只承载当前页（默认 4000 字）。
 * 提交时用 getValue() 拼回完整内容，逐字保留换行与空白。
 */

const DEFAULT_PAGE_CHARS = 4000;
const BULK_INSERT = 500;          // 一次插入超过这么多字，按"粘贴"处理

function splitInto(content, size) {
  if (!content) return [''];
  const out = [];
  for (let i = 0; i < content.length; i += size) out.push(content.slice(i, i + size));
  return out.length ? out : [''];
}

export function attachPagedInput(textarea, {
  pageChars = DEFAULT_PAGE_CHARS,
  pagerHost = null,             // 放翻页控件的容器（可选）
  onChange = null,
} = {}) {
  if (!textarea) throw new Error('attachPagedInput 需要 textarea');
  if (!Number.isInteger(pageChars) || pageChars < 500) throw new Error('分页大小必须 ≥ 500');

  let pages = [''];
  let index = 0;
  let lastValue = '';
  let composing = false;

  const total = () => pages.reduce((a, p) => a + p.length, 0);
  const getValue = () => pages.join('');
  const isPaged = () => pages.length > 1;

  /* 翻页控件：只在真的分页后出现，避免正常输入时多出噪音。 */
  const host = pagerHost;
  let bar = null;
  function renderPager() {
    if (!host) return;
    if (!isPaged()) {
      if (bar) { bar.remove(); bar = null; }
      return;
    }
    if (!bar) {
      bar = document.createElement('div');
      bar.className = 'pager';
      bar.style.cssText = 'display:flex;align-items:center;gap:8px;margin-top:8px;font-size:12px;color:#8B959E';
      host.appendChild(bar);
    }
    bar.innerHTML = '';
    const prev = document.createElement('button');
    prev.type = 'button'; prev.className = 'btn'; prev.textContent = '‹ 上一页';
    prev.disabled = index === 0;
    prev.onclick = () => goto(index - 1);
    const next = document.createElement('button');
    next.type = 'button'; next.className = 'btn'; next.textContent = '下一页 ›';
    next.disabled = index >= pages.length - 1;
    next.onclick = () => goto(index + 1);
    const info = document.createElement('span');
    info.textContent = `第 ${index + 1} / ${pages.length} 页 · 全文 ${total()} 字（已分页编辑，提交时使用完整内容）`;
    bar.append(prev, next, info);
  }

  function goto(next) {
    if (next < 0 || next >= pages.length) return;
    pages[index] = textarea.value;         // 先保存当前页
    index = next;
    textarea.value = pages[index];
    lastValue = textarea.value;
    textarea.scrollTop = 0;
    textarea.focus();
    renderPager();
    onChange?.();
  }

  /* 一旦当前页超长就分页。不能只依赖"增量"判断：直接赋 value、输入法整段上屏、
     脚本填充都不会给出可靠的 delta。这里以绝对长度为准，简单且不会被绕过。 */
  function maybeSplitOnBulkInsert() {
    const value = textarea.value;
    if (value.length <= pageChars) return false;
    // 以光标为界拆分；光标应留在"它原本在的那一页"的对应位置。
    const cursor = Math.max(0, Math.min(textarea.selectionStart ?? value.length, value.length));
    const before = value.slice(0, cursor);
    const after = value.slice(cursor);
    const chunks = splitInto(before, pageChars);
    const last = chunks.pop() ?? '';              // 光标所在的那一块
    const merged = splitInto(last + after, pageChars);
    pages = [...pages.slice(0, index), ...chunks, ...merged, ...pages.slice(index + 1)];
    index += chunks.length;
    textarea.value = pages[index];
    const newCursor = Math.min(last.length, textarea.value.length);
    try { textarea.setSelectionRange(newCursor, newCursor); } catch {}
    // 让当前页尽量把光标滚进视野，而不是停在顶部。
    try {
      const lineHeight = parseFloat(getComputedStyle(textarea).lineHeight) || 20;
      const lineOfCursor = (textarea.value.slice(0, newCursor).match(/\n/g) || []).length;
      textarea.scrollTop = Math.max(0, lineOfCursor * lineHeight - textarea.clientHeight / 2);
    } catch {}
    lastValue = textarea.value;
    renderPager();
    onChange?.();
    return true;
  }

  textarea.addEventListener('compositionstart', () => { composing = true; });
  textarea.addEventListener('compositionend', () => {
    composing = false;
    pages[index] = textarea.value;
    lastValue = textarea.value;
    maybeSplitOnBulkInsert();
    onChange?.();
  });
  textarea.addEventListener('input', () => {
    if (composing) return;                 // 中文输入法组合期间不打断
    if (!maybeSplitOnBulkInsert()) {
      pages[index] = textarea.value;
      lastValue = textarea.value;
    }
    onChange?.();
  });
  // 兜底：切页/切窗口前保存（避免未触发 input 的边界情况）
  textarea.addEventListener('blur', () => { pages[index] = textarea.value; });

  function setValue(value) {
    pages = splitInto(String(value ?? ''), pageChars);
    index = 0;
    textarea.value = pages[0];
    lastValue = textarea.value;
    renderPager();
    onChange?.();
  }
  function setPageChars(size) {
    if (!Number.isInteger(size) || size < 500) return;
    pageChars = size;
    setValue(getValue());
  }

  setValue('');

  return { getValue, setValue, setPageChars, isPaged, get pageIndex() { return index; },
    get pageCount() { return pages.length; }, get pageChars() { return pageChars; },
    get pageLength() { return pages[index].length; } };
}
