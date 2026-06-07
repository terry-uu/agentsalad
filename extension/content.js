/**
 * Agent Salad Browser Extension — Content Script
 *
 * browser-use ClickableElementDetector + DOMTreeSerializer를 JS로 포팅.
 * 인터랙티브 요소를 인덱스 맵으로 수집, LLM 소비용 텍스트로 직렬화한다.
 *
 * 참조 원본:
 *   browser_use/dom/serializer/clickable_elements.py
 *   browser_use/dom/serializer/serializer.py
 *   browser_use/dom/views.py
 */

/* ── Element Map ───────────────────────────────────────────── */

let elementMap = [];
let elementMapStale = true;

const observer = new MutationObserver(() => { elementMapStale = true; });
observer.observe(document.documentElement, {
  childList: true, subtree: true, attributes: true,
  attributeFilter: ['class', 'style', 'hidden', 'disabled', 'aria-hidden'],
});

/* ── Interactive Element Detection ─────────────────────────── */
// Ported from browser_use/dom/serializer/clickable_elements.py

const INTERACTIVE_TAGS = new Set([
  'button', 'input', 'select', 'textarea', 'a',
  'details', 'summary', 'option', 'optgroup',
]);

const INTERACTIVE_ROLES = new Set([
  'button', 'link', 'menuitem', 'option', 'radio', 'checkbox', 'tab',
  'textbox', 'combobox', 'slider', 'spinbutton', 'search', 'searchbox',
  'row', 'cell', 'gridcell', 'listbox',
]);

const INTERACTIVE_ATTRS = new Set([
  'onclick', 'onmousedown', 'onmouseup', 'onkeydown', 'onkeyup', 'tabindex',
]);

const SEARCH_INDICATORS = new Set([
  'search', 'magnify', 'glass', 'lookup', 'find', 'query',
  'search-icon', 'search-btn', 'search-button', 'searchbox',
]);

const SKIP_TAGS = new Set([
  'html', 'body', 'head', 'script', 'style', 'meta', 'link',
  'title', 'noscript', 'br', 'hr',
]);

const SVG_CHILD_TAGS = new Set([
  'path', 'rect', 'g', 'circle', 'ellipse', 'line', 'polyline',
  'polygon', 'use', 'defs', 'clippath', 'mask', 'pattern',
  'image', 'text', 'tspan',
]);

function hasFormControl(el, depth = 2) {
  if (depth <= 0) return false;
  for (const c of el.children) {
    const t = c.tagName?.toLowerCase();
    if (t === 'input' || t === 'select' || t === 'textarea') return true;
    if (hasFormControl(c, depth - 1)) return true;
  }
  return false;
}

function isInteractive(el) {
  if (el.nodeType !== Node.ELEMENT_NODE) return false;
  const tag = el.tagName.toLowerCase();
  if (SKIP_TAGS.has(tag) || SVG_CHILD_TAGS.has(tag)) return false;

  if (el.getAttribute('aria-disabled') === 'true') return false;
  if (el.getAttribute('aria-hidden') === 'true') return false;

  // label: skip if "for" proxies to external input; detect wrapped form controls
  if (tag === 'label') {
    if (el.getAttribute('for')) return false;
    if (hasFormControl(el, 2)) return true;
  }
  if (tag === 'span' && hasFormControl(el, 2)) return true;

  // Search class/id heuristic
  const cls = (el.getAttribute('class') || '').toLowerCase();
  const eid = (el.getAttribute('id') || '').toLowerCase();
  for (const s of SEARCH_INDICATORS) {
    if (cls.includes(s) || eid.includes(s)) return true;
  }
  for (const attr of el.attributes) {
    if (attr.name.startsWith('data-') && SEARCH_INDICATORS.has(attr.value?.toLowerCase())) return true;
  }

  // ARIA state properties → interactive widget
  if (el.ariaExpanded !== null || el.ariaPressed !== null ||
      el.ariaChecked !== null || el.ariaSelected !== null) return true;
  if (el.getAttribute('aria-required') === 'true') return true;
  if (el.getAttribute('aria-autocomplete')) return true;

  if (INTERACTIVE_TAGS.has(tag)) return true;

  for (const a of INTERACTIVE_ATTRS) { if (el.hasAttribute(a)) return true; }

  const role = el.getAttribute('role') || el.role;
  if (role && INTERACTIVE_ROLES.has(role)) return true;

  // Icon-sized clickable elements (10-50px)
  const rect = el.getBoundingClientRect();
  if (rect.width >= 10 && rect.width <= 50 && rect.height >= 10 && rect.height <= 50) {
    if (el.hasAttribute('class') || el.hasAttribute('role') ||
        el.hasAttribute('onclick') || el.hasAttribute('data-action') ||
        el.hasAttribute('aria-label')) return true;
  }

  // iframe large enough to scroll
  if ((tag === 'iframe' || tag === 'frame') && rect.width > 100 && rect.height > 100) return true;

  // Final fallback: cursor:pointer (browser-use 동일)
  try { if (getComputedStyle(el).cursor === 'pointer') return true; } catch {}

  return false;
}

/* ── Visibility ────────────────────────────────────────────── */

function isVisible(el) {
  if (!el) return false;
  try {
    const s = getComputedStyle(el);
    if (s.display === 'none' || s.visibility === 'hidden' || s.opacity === '0') return false;
  } catch { return false; }
  const r = el.getBoundingClientRect();
  return r.width > 0 || r.height > 0;
}

function isInViewport(el) {
  const r = el.getBoundingClientRect();
  return r.top < window.innerHeight && r.bottom > 0 && r.left < window.innerWidth && r.right > 0;
}

/* ── DOM Serialization ─────────────────────────────────────── */
// Ported from browser_use/dom/serializer/serializer.py format

const INCLUDE_ATTRS = [
  'title', 'type', 'name', 'role', 'tabindex', 'aria-label', 'placeholder',
  'value', 'alt', 'aria-expanded', 'aria-haspopup', 'aria-checked',
  'aria-selected', 'aria-pressed', 'aria-current', 'aria-autocomplete',
  'aria-valuenow', 'aria-valuemin', 'aria-valuemax', 'href', 'action',
  'data-testid', 'for',
];

const DATE_FMT = {
  date: 'YYYY-MM-DD', time: 'HH:MM', 'datetime-local': 'YYYY-MM-DDTHH:MM',
  month: 'YYYY-MM', week: 'YYYY-W##',
};

function buildAttrs(el) {
  const tag = el.tagName.toLowerCase();
  const parts = [];

  for (const a of INCLUDE_ATTRS) {
    let v = el.getAttribute(a);
    if (v === null || v === '') continue;
    if (tag === 'input' && el.type === 'password' && a === 'value') continue;
    parts.push(`${a}="${v.trim().slice(0, 100)}"`);
  }

  // Date/time format hints (browser-use _build_attributes_string)
  if (tag === 'input') {
    const t = (el.type || '').toLowerCase();
    if (DATE_FMT[t]) {
      parts.push(`format="${DATE_FMT[t]}"`);
      if (!el.getAttribute('placeholder')) parts.push(`placeholder="${DATE_FMT[t]}"`);
    }
    // jQuery/Bootstrap datepicker detection
    if ((t === 'text' || t === '') && cls_has(el, 'datepicker', 'datetimepicker', 'daterangepicker')) {
      const df = el.getAttribute('data-date-format') || 'mm/dd/yyyy';
      parts.push(`format="${df}"`);
    }
  }

  // Live value for input/textarea
  if ((tag === 'input' || tag === 'textarea') && el.type !== 'password') {
    if (el.value && !parts.some(p => p.startsWith('value='))) {
      parts.push(`value="${el.value.slice(0, 100)}"`);
    }
  }

  // Select compound info
  if (tag === 'select') {
    const sel = el.options[el.selectedIndex];
    if (sel) parts.push(`selected="${sel.text.trim().slice(0, 50)}"`);
    if (el.options.length > 0) {
      const first = Array.from(el.options).slice(0, 4).map(o => o.text.trim().slice(0, 30)).join('|');
      parts.push(`options_count="${el.options.length}"`);
      parts.push(`first_options="${first}"`);
    }
  }

  return parts.join(' ');
}

function cls_has(el, ...terms) {
  const c = (el.getAttribute('class') || '').toLowerCase();
  return terms.some(t => c.includes(t));
}

function directText(el) {
  let t = '';
  for (const c of el.childNodes) { if (c.nodeType === Node.TEXT_NODE) t += c.textContent; }
  return t.trim().slice(0, 80);
}

/* ── Build State ───────────────────────────────────────────── */

/**
 * Shadow DOM 포함 전체 요소 수집.
 * querySelectorAll('*')는 light DOM만 탐색하므로,
 * shadowRoot가 있는 요소를 재귀적으로 따라가야 YouTube 등 Web Component 사이트를 커버한다.
 */
function collectAllElements(root) {
  const result = [];
  const all = root.querySelectorAll('*');
  for (const el of all) {
    result.push(el);
    if (el.shadowRoot) {
      result.push(...collectAllElements(el.shadowRoot));
    }
  }
  return result;
}

function buildState(viewportOnly = false) {
  elementMap = [];
  const lines = [];

  lines.push(`viewport: ${window.innerWidth}x${window.innerHeight}`);
  lines.push(`page: ${document.documentElement.scrollWidth}x${document.documentElement.scrollHeight}`);
  lines.push(`scroll: (${Math.round(window.scrollX)}, ${Math.round(window.scrollY)})`);
  lines.push(`url: ${location.href}`);
  lines.push(`title: ${document.title}`);
  lines.push('');

  const all = collectAllElements(document.body || document.documentElement);
  for (const el of all) {
    if (!isVisible(el)) continue;
    if (viewportOnly && !isInViewport(el)) continue;

    if (isInteractive(el)) {
      const idx = elementMap.length;
      elementMap.push(el);

      const tag = el.tagName.toLowerCase();
      const attrs = buildAttrs(el);
      const text = directText(el);

      let line = `[${idx}]<${tag}`;
      if (attrs) line += ` ${attrs}`;
      line += ' />';
      if (text) line += ` ${text}`;
      lines.push(line);
    }
  }

  elementMapStale = false;
  return lines.join('\n');
}

/* ── Action Handlers ───────────────────────────────────────── */

function getEl(index) {
  const el = elementMap[index];
  if (!el) throw new Error(`Element index ${index} not found — call browse_state first`);
  if (!document.contains(el)) throw new Error(`Element index ${index} is stale — page changed, call browse_state`);
  return el;
}

// ── CDP-backing helpers: content script → background에 좌표/정보만 제공 ──

function handleGetClickTarget(p) {
  const el = getEl(p.index);
  el.scrollIntoView({ block: 'center', behavior: 'instant' });
  const rect = el.getBoundingClientRect();
  return {
    x: Math.round(rect.left + rect.width / 2),
    y: Math.round(rect.top + rect.height / 2),
    tag: el.tagName.toLowerCase(),
    text: directText(el).slice(0, 50),
  };
}

function handleFocusAndClear(p) {
  const el = getEl(p.index);
  el.scrollIntoView({ block: 'center', behavior: 'instant' });
  el.focus();
  const rect = el.getBoundingClientRect();
  return {
    x: Math.round(rect.left + rect.width / 2),
    y: Math.round(rect.top + rect.height / 2),
  };
}

function handleGetScrollInfo() {
  return {
    currentScrollY: Math.round(window.scrollY),
    scrollHeight: document.documentElement.scrollHeight,
    viewportHeight: window.innerHeight,
    atBottom: window.scrollY + window.innerHeight >= document.documentElement.scrollHeight - 1,
  };
}

function handleSelect(p) {
  const el = getEl(p.index);
  if (el.tagName.toLowerCase() !== 'select') throw new Error(`Element ${p.index} is not a select`);
  let found = false;
  for (const opt of el.options) {
    if (opt.value === p.value || opt.text.trim() === p.value) {
      el.value = opt.value; found = true; break;
    }
  }
  if (!found) throw new Error(`Option "${p.value}" not found in select`);
  el.dispatchEvent(new Event('change', { bubbles: true }));
  return { selected: p.value, element: p.index };
}

function handleEval(p) {
  try {
    const r = new Function(`return (${p.code})`)();
    return { result: r !== undefined ? String(r).slice(0, 5000) : 'undefined' };
  } catch {
    try { new Function(p.code)(); return { result: 'executed (no return value)' }; }
    catch (e2) { throw new Error(`eval failed: ${e2.message}`); }
  }
}

function handleWait(p) {
  const maxMs = Math.min(p.timeout || 5000, 30000);
  return new Promise((resolve) => {
    const start = Date.now();
    (function check() {
      if (p.selector && document.querySelector(p.selector)) { resolve({ found: true, selector: p.selector }); return; }
      if (p.text && document.body.innerText.includes(p.text)) { resolve({ found: true, text: p.text }); return; }
      if (Date.now() - start > maxMs) { resolve({ found: false, selector: p.selector, text: p.text }); return; }
      setTimeout(check, 100);
    })();
  });
}

/* ── Message Router ────────────────────────────────────────── */

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.action === 'ping') { sendResponse({ data: 'pong' }); return false; }

  (async () => {
    try {
      let data;
      switch (msg.action) {
        case 'state':          data = { _raw_text: buildState(msg.params?.viewportOnly) }; break;
        case 'getClickTarget': data = handleGetClickTarget(msg.params); break;
        case 'focusAndClear':  data = handleFocusAndClear(msg.params); break;
        case 'getScrollInfo':  data = handleGetScrollInfo(); break;
        case 'select':         data = handleSelect(msg.params); break;
        case 'eval':           data = handleEval(msg.params); break;
        case 'wait':           data = await handleWait(msg.params); break;
        default:               throw new Error(`Unknown action: ${msg.action}`);
      }
      sendResponse({ data });
    } catch (err) {
      sendResponse({ error: err.message || String(err) });
    }
  })();
  return true;
});
