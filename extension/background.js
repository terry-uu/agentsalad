/**
 * Agent Salad Browser Extension — Background Service Worker
 *
 * WebSocket으로 Agent Salad 서버에 연결, 서버 명령을 Content Script로 라우팅.
 * chrome.debugger API로 CDP Input.* 명령을 직접 보내 isTrusted 이벤트를 생성한다.
 * (browser-use의 Mouse.click / Input.insertText / Input.dispatchKeyEvent 동일 방식)
 *
 * MV3 Service Worker는 chrome.alarms로 keepalive + 자동 재연결.
 */

const DEFAULT_SERVER = 'ws://127.0.0.1:3210/ws/browser';
const HEARTBEAT_MS = 25000;
const KEEPALIVE_ALARM = 'keepalive';
const KEEPALIVE_INTERVAL_MIN = 0.25;

let ws = null;
let heartbeatTimer = null;
let serverUrl = DEFAULT_SERVER;
let userDisconnected = false;

// debugger attach 상태 추적
const attachedTabs = new Set();

function getState() {
  if (!ws) return 'disconnected';
  if (ws.readyState === WebSocket.CONNECTING) return 'connecting';
  if (ws.readyState === WebSocket.OPEN) return 'connected';
  return 'disconnected';
}

function broadcastState() {
  chrome.runtime.sendMessage({ type: 'connectionState', state: getState() }).catch(() => {});
}

// ── WebSocket ───────────────────────────────────────────────

function connect() {
  if (userDisconnected) return;
  if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) return;

  try { ws = new WebSocket(serverUrl); } catch (e) {
    console.debug('[AgentSalad] WS create failed:', e.message || e);
    ws = null;
    return;
  }

  ws.onopen = () => {
    console.log('[AgentSalad] Connected');
    broadcastState();
    startHeartbeat();
  };

  ws.onmessage = (ev) => handleServerMessage(ev.data);

  ws.onclose = () => {
    stopHeartbeat();
    ws = null;
    broadcastState();
  };

  ws.onerror = (e) => {
    console.debug('[AgentSalad] WS error (will reconnect via alarm):', e.message || 'connection refused');
  };
}

function disconnect() {
  userDisconnected = true;
  stopHeartbeat();
  if (ws) { ws.onclose = null; ws.close(); ws = null; }
  broadcastState();
}

function startHeartbeat() {
  stopHeartbeat();
  heartbeatTimer = setInterval(() => {
    if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'ping' }));
  }, HEARTBEAT_MS);
}

function stopHeartbeat() {
  if (heartbeatTimer) { clearInterval(heartbeatTimer); heartbeatTimer = null; }
}

// ── Keepalive Alarm ─────────────────────────────────────────

chrome.alarms.create(KEEPALIVE_ALARM, { periodInMinutes: KEEPALIVE_INTERVAL_MIN });

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === KEEPALIVE_ALARM) {
    if (!userDisconnected && (!ws || ws.readyState !== WebSocket.OPEN)) {
      connect();
    }
  }
});

// ── CDP via chrome.debugger ─────────────────────────────────

async function ensureDebugger(tabId) {
  if (attachedTabs.has(tabId)) return;
  await chrome.debugger.attach({ tabId }, '1.3');
  attachedTabs.add(tabId);
}

function cdp(tabId, method, params = {}) {
  return chrome.debugger.sendCommand({ tabId }, method, params);
}

chrome.debugger.onDetach.addListener((source) => {
  if (source.tabId) attachedTabs.delete(source.tabId);
});

// browser-use Mouse.click 동일: mousePressed → mouseReleased
async function cdpClick(tabId, x, y, button = 'left', clickCount = 1) {
  await ensureDebugger(tabId);
  await cdp(tabId, 'Input.dispatchMouseEvent', {
    type: 'mousePressed', x, y, button, clickCount,
  });
  await cdp(tabId, 'Input.dispatchMouseEvent', {
    type: 'mouseReleased', x, y, button, clickCount,
  });
}

// browser-use Input.insertText 동일
async function cdpType(tabId, text) {
  await ensureDebugger(tabId);
  await cdp(tabId, 'Input.insertText', { text });
}

// browser-use SendKeysEvent 동일
async function cdpKey(tabId, key, modifiers = 0) {
  await ensureDebugger(tabId);
  const type = key.length === 1 ? 'keyDown' : 'rawKeyDown';
  await cdp(tabId, 'Input.dispatchKeyEvent', {
    type, key, text: key.length === 1 ? key : undefined, modifiers,
  });
  await cdp(tabId, 'Input.dispatchKeyEvent', {
    type: 'keyUp', key, modifiers,
  });
}

// browser-use Mouse.scroll 동일: mouseWheel
async function cdpScroll(tabId, x, y, deltaX, deltaY) {
  await ensureDebugger(tabId);
  await cdp(tabId, 'Input.dispatchMouseEvent', {
    type: 'mouseWheel', x, y, deltaX, deltaY,
  });
}

// ── Server Message Handler ──────────────────────────────────

async function handleServerMessage(raw) {
  let msg;
  try { msg = JSON.parse(raw); } catch { return; }
  if (msg.type === 'pong') return;

  const { id, action, params } = msg;
  if (!id || !action) return;

  try {
    let result;
    switch (action) {
      case 'tabs':        result = await cmdTabs(); break;
      case 'tab_switch':  result = await cmdTabSwitch(params); break;
      case 'screenshot':  result = await cmdScreenshot(); break;
      case 'navigate':    result = await cmdNavigate(params); break;
      case 'click':       result = await cmdClick(params); break;
      case 'type':        result = await cmdType(params); break;
      case 'keys':        result = await cmdKeys(params); break;
      case 'scroll':      result = await cmdScroll(params); break;
      default:            result = await forwardToContent(action, params); break;
    }
    send(id, true, result);
  } catch (err) {
    send(id, false, null, err.message || String(err));
  }
}

function send(id, success, data, error) {
  if (!ws || ws.readyState !== WebSocket.OPEN) return;
  ws.send(JSON.stringify(success ? { id, success, data } : { id, success, error }));
}

// ── CDP-backed Commands (click/type/keys/scroll) ────────────

async function cmdClick(p) {
  const tab = await activeTab();
  await ensureContentScript(tab.id);
  // content script에서 요소 좌표 + 스크롤 + 정보 받기
  const info = await askContent(tab.id, 'getClickTarget', { index: p.index });
  if (info.error) throw new Error(info.error);
  await cdpClick(tab.id, info.x, info.y);
  return { clicked: p.index, tag: info.tag, text: info.text };
}

async function cmdType(p) {
  const tab = await activeTab();
  await ensureContentScript(tab.id);
  // 요소를 포커스 + 기존 값 클리어
  const info = await askContent(tab.id, 'focusAndClear', { index: p.index });
  if (info.error) throw new Error(info.error);
  // 먼저 클릭으로 포커스 확실히
  await cdpClick(tab.id, info.x, info.y);
  await sleep(50);
  // 기존 내용 전체선택 후 삭제
  await cdpKey(tab.id, 'a', 8); // Ctrl+A (modifiers: 8 = meta on mac... let's use select all)
  await cdpKey(tab.id, 'Backspace');
  await sleep(50);
  await cdpType(tab.id, p.text);
  return { typed: p.text.length + ' chars', element: p.index };
}

async function cmdKeys(p) {
  const tab = await activeTab();
  await ensureDebugger(tab.id);

  const parts = p.keys.split('+');
  const key = parts.pop();
  let modifiers = 0;
  for (const mod of parts) {
    const m = mod.toLowerCase();
    if (m === 'ctrl' || m === 'control') modifiers |= 2;
    if (m === 'alt') modifiers |= 1;
    if (m === 'shift') modifiers |= 8;
    if (m === 'meta' || m === 'cmd') modifiers |= 4;
  }
  await cdpKey(tab.id, key, modifiers);
  return { sent: p.keys };
}

async function cmdScroll(p) {
  const tab = await activeTab();
  await ensureDebugger(tab.id);
  // 뷰포트 중앙에서 스크롤
  const amount = p.pixels || 500;
  const deltaY = p.direction === 'down' ? amount : -amount;
  await cdpScroll(tab.id, 400, 300, 0, deltaY);
  // 스크롤 후 위치 정보는 content script에서
  await ensureContentScript(tab.id);
  const scrollInfo = await askContent(tab.id, 'getScrollInfo', {});
  return {
    direction: p.direction, scrolledPixels: amount,
    ...scrollInfo,
  };
}

// ── Tab / Screenshot / Navigate ─────────────────────────────

async function cmdTabs() {
  const tabs = await chrome.tabs.query({});
  return { tabs: tabs.map((t, i) => ({ index: i, id: t.id, title: (t.title || '').slice(0, 100), url: t.url || '', active: t.active })) };
}

async function cmdTabSwitch(p) {
  const tabs = await chrome.tabs.query({});
  if (p.tabIndex < 0 || p.tabIndex >= tabs.length) throw new Error(`Invalid tab index ${p.tabIndex}. Range: 0-${tabs.length - 1}`);
  await chrome.tabs.update(tabs[p.tabIndex].id, { active: true });
  return { switched: p.tabIndex, title: tabs[p.tabIndex].title };
}

async function cmdScreenshot() {
  const tab = await activeTab();
  const dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, { format: 'png' });
  return { screenshot: dataUrl, url: tab.url, title: tab.title };
}

async function cmdNavigate(p) {
  const url = p.url.startsWith('http') ? p.url : `https://${p.url}`;
  const tab = await activeTab();
  await chrome.tabs.update(tab.id, { url });
  await waitTabLoad(tab.id, 30000);
  const updated = await chrome.tabs.get(tab.id);
  return { url: updated.url, title: updated.title };
}

function waitTabLoad(tabId, timeout) {
  return new Promise((resolve) => {
    const timer = setTimeout(() => { chrome.tabs.onUpdated.removeListener(fn); resolve(); }, timeout);
    function fn(id, info) {
      if (id === tabId && info.status === 'complete') {
        clearTimeout(timer);
        chrome.tabs.onUpdated.removeListener(fn);
        setTimeout(resolve, 200);
      }
    }
    chrome.tabs.onUpdated.addListener(fn);
  });
}

// ── Content Script Communication ────────────────────────────

function askContent(tabId, action, params) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Content script timeout: ${action}`)), 15000);
    chrome.tabs.sendMessage(tabId, { action, params }, { frameId: 0 }, (res) => {
      clearTimeout(timer);
      if (chrome.runtime.lastError) { reject(new Error(chrome.runtime.lastError.message)); return; }
      if (!res) { reject(new Error('No response from content script')); return; }
      resolve(res.data || res);
    });
  });
}

async function forwardToContent(action, params) {
  const tab = await activeTab();
  await ensureContentScript(tab.id);

  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Content script timeout: ${action}`)), 15000);
    chrome.tabs.sendMessage(tab.id, { action, params }, { frameId: 0 }, (res) => {
      clearTimeout(timer);
      if (chrome.runtime.lastError) { reject(new Error(chrome.runtime.lastError.message)); return; }
      if (!res) { reject(new Error('No response from content script')); return; }
      if (res.error) { reject(new Error(res.error)); return; }
      resolve(res.data);
    });
  });
}

async function ensureContentScript(tabId) {
  try {
    await chrome.tabs.sendMessage(tabId, { action: 'ping' }, { frameId: 0 });
  } catch {
    await chrome.scripting.executeScript({ target: { tabId, frameIds: [0] }, files: ['content.js'] });
    await new Promise((r) => setTimeout(r, 100));
  }
}

async function activeTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab) throw new Error('No active tab');
  return tab;
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

// ── Popup IPC ───────────────────────────────────────────────

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.type === 'getState') {
    sendResponse({ state: getState(), serverUrl });
    return false;
  }
  if (msg.type === 'connect') {
    serverUrl = msg.serverUrl || DEFAULT_SERVER;
    chrome.storage.local.set({ serverUrl });
    userDisconnected = false;
    if (ws) { ws.onclose = null; ws.close(); ws = null; }
    connect();
    sendResponse({ ok: true });
    return false;
  }
  if (msg.type === 'disconnect') {
    disconnect();
    sendResponse({ ok: true });
    return false;
  }
  return false;
});

// ── Startup ─────────────────────────────────────────────────

chrome.storage.local.get(['serverUrl'], (r) => {
  if (r.serverUrl) serverUrl = r.serverUrl;
  connect();
});
