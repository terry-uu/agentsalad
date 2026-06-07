const st = document.getElementById('st');
const stxt = document.getElementById('stxt');
const srv = document.getElementById('srv');
const bc = document.getElementById('bc');
const bd = document.getElementById('bd');
const L = { connected: '연결됨', connecting: '연결 중...', disconnected: '연결 안 됨' };

function ui(s) {
  st.className = `status ${s}`;
  stxt.textContent = L[s] || s;
  bc.disabled = s === 'connected';
  bd.disabled = s !== 'connected';
}

chrome.runtime.sendMessage({ type: 'getState' }, (r) => {
  if (!r) return;
  ui(r.state);
  if (r.serverUrl) srv.value = r.serverUrl.replace(/^wss?:\/\//, '').replace(/\/ws\/browser$/, '');
});

chrome.runtime.onMessage.addListener((m) => { if (m.type === 'connectionState') ui(m.state); });

bc.addEventListener('click', () => {
  chrome.runtime.sendMessage({ type: 'connect', serverUrl: `ws://${srv.value.trim()}/ws/browser` });
  ui('connecting');
});
bd.addEventListener('click', () => {
  chrome.runtime.sendMessage({ type: 'disconnect' });
  ui('disconnected');
});
