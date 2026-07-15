'use strict';

/* ===========================================================================
   ポスティングマップ アプリ本体
   - データはすべて localStorage に保存(サーバー不要の静的PWA)
   - デモモード( URL に ?demo=1 )では GPS の代わりに擬似移動でテストできる
=========================================================================== */

const STORAGE_KEY = 'postingMapData';
const DATA_VERSION = 1;
const BASE_LAYER_STORAGE_KEY = 'postingMapBaseLayer'; // ベース地図の選択(データとは別キー)

const ACCURACY_LIMIT_M = 50;   // これより精度(accuracy)が悪い点は捨てる
const MIN_MOVE_M = 3;          // 前回の記録点からこの距離未満の移動は間引く

const PIN_LABELS = {
  delivered: '配布済み',
  absent: '不在・ポスト無し',
  refused: 'チラシお断り'
};
const PIN_COLORS = {
  delivered: '#2e9e5b',
  absent: '#8a8f98',
  refused: '#d1332a'
};

// ベース地図(タイルレイヤー)の定義。既定は国土地理院(建物形状が入っており戸建て住宅地の把握に向く)
const BASE_LAYERS = {
  gsi: {
    label: '国土地理院(建物表示)',
    url: 'https://cyberjapandata.gsi.go.jp/xyz/std/{z}/{x}/{y}.png',
    options: {
      maxNativeZoom: 18,   // 18より先はネイティブタイルが無いため拡大表示になる
      maxZoom: 19,
      attribution: '出典: <a href="https://maps.gsi.go.jp/development/ichiran.html" target="_blank" rel="noopener">国土地理院</a>'
    }
  },
  osm: {
    label: 'OpenStreetMap',
    url: 'https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png',
    options: {
      maxZoom: 19,
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap</a> contributors'
    }
  }
};

/* =========================================================================
   1. データ層(localStorage 読み書き)
   構造:
   {
     version: 1,
     sessions: [{ id, startTime, endTime, points:[{lat,lng,t}], distance, visible }],
     pins: [{ id, sessionId, lat, lng, type, memo, timestamp }]
   }
========================================================================= */
function createEmptyData() {
  return { version: DATA_VERSION, sessions: [], pins: [] };
}

function migrateData(data) {
  // 将来データ構造が変わった場合はここでバージョンごとの移行処理を追加する
  if (!data.version || data.version < DATA_VERSION) {
    data.version = DATA_VERSION;
  }
  if (!Array.isArray(data.sessions)) data.sessions = [];
  if (!Array.isArray(data.pins)) data.pins = [];
  return data;
}

function loadData() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return createEmptyData();
    return migrateData(JSON.parse(raw));
  } catch (e) {
    console.error('データ読み込みに失敗しました。初期状態で開始します。', e);
    return createEmptyData();
  }
}

function saveData() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state.data));
  } catch (e) {
    console.error('データ保存に失敗しました', e);
    showToast('データの保存に失敗しました(容量不足の可能性があります)');
  }
}

/* =========================================================================
   2. アプリ全体の状態
========================================================================= */
const state = {
  data: loadData(),
  map: null,
  baseLayerType: 'gsi',    // 'gsi' | 'osm'(現在のベース地図)
  baseTileLayer: null,     // 現在地図に載っているベースタイルレイヤー
  gpsMarker: null,
  followMode: true,
  recording: false,
  currentSession: null,   // 記録中セッション { id, startTime, points: [] }
  currentPolyline: null,
  watchId: null,
  wakeLock: null,
  recTimerInterval: null,
  sessionLayers: new Map(),  // sessionId -> polyline
  pinLayers: new Map(),      // pinId -> marker
  pinsVisible: true,
  pendingPinLatLng: null,    // ピン種別選択シート表示中の座標
  editingPinId: null,        // 詳細シートで開いているピンID
  demoMode: false,
  demoTimer: null,
  demoIndex: 0,
  drawMode: false,           // 経路手描きモード中か
  drawPoints: [],            // 手描き中の頂点 [{lat,lng}]
  drawPreviewLayer: null,    // 手描き中のプレビュー用ポリライン(破線)
  drawVertexLayers: []       // 手描き中の頂点マーカー群
};

/* =========================================================================
   3. ユーティリティ
========================================================================= */

// 2点間の距離(メートル)をハーバサイン公式で計算
function haversineDistance(lat1, lng1, lat2, lng2) {
  const R = 6371000; // 地球半径(m)
  const toRad = (deg) => (deg * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) *
    Math.sin(dLng / 2) * Math.sin(dLng / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c;
}

function calcSessionDistance(points) {
  let dist = 0;
  for (let i = 1; i < points.length; i++) {
    dist += haversineDistance(points[i - 1].lat, points[i - 1].lng, points[i].lat, points[i].lng);
  }
  return dist;
}

function formatDistance(m) {
  if (m >= 1000) return (m / 1000).toFixed(2) + 'km';
  return Math.round(m) + 'm';
}

function formatElapsed(ms) {
  const totalSec = Math.floor(ms / 1000);
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  const pad = (n) => String(n).padStart(2, '0');
  return h > 0 ? `${pad(h)}:${pad(m)}:${pad(s)}` : `${pad(m)}:${pad(s)}`;
}

function formatDateJP(dateStr) {
  const d = new Date(dateStr);
  const w = ['日', '月', '火', '水', '木', '金', '土'][d.getDay()];
  return `${d.getMonth() + 1}月${d.getDate()}日(${w})`;
}

function todayKey() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function dateKeyOf(timestamp) {
  const d = new Date(timestamp);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function genId() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

let toastTimer = null;
function showToast(msg) {
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.classList.remove('hidden');
  el.style.opacity = '1';
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    el.style.opacity = '0';
    setTimeout(() => el.classList.add('hidden'), 300);
  }, 2200);
}

/* =========================================================================
   4. 地図の初期化
========================================================================= */

// 保存済みのベース地図設定を読み込む(未設定・不正値は国土地理院を既定にする)
function loadBaseLayerType() {
  try {
    const saved = localStorage.getItem(BASE_LAYER_STORAGE_KEY);
    return saved === 'osm' ? 'osm' : 'gsi';
  } catch (e) {
    return 'gsi';
  }
}

// ベース地図(タイルレイヤーのみ)を切り替える。経路・ピン等の他レイヤーには影響しない
function setBaseLayer(type, opts) {
  const silent = opts && opts.silent;
  if (!BASE_LAYERS[type]) return;

  if (state.baseTileLayer) {
    state.map.removeLayer(state.baseTileLayer);
  }
  const def = BASE_LAYERS[type];
  state.baseTileLayer = L.tileLayer(def.url, def.options).addTo(state.map);
  state.baseLayerType = type;

  try {
    localStorage.setItem(BASE_LAYER_STORAGE_KEY, type);
  } catch (e) {
    console.warn('地図設定の保存に失敗しました', e);
  }

  if (!silent) showToast(`地図: ${def.label}`);
}

function initMap() {
  // 初期中心地: デモモードは東京の住宅街付近、それ以外は東京駅付近(取得できたら現在地へ移動)
  const initialCenter = [35.681236, 139.767125];
  state.map = L.map('map', { zoomControl: false, attributionControl: true })
    .setView(initialCenter, 17);

  L.control.zoom({ position: 'bottomright' }).addTo(state.map);

  // ベース地図タイル(前回選択、無ければ国土地理院を既定表示)
  setBaseLayer(loadBaseLayerType(), { silent: true });

  // 現在地マーカー(青丸)
  const gpsIcon = L.divIcon({ className: 'gps-marker', iconSize: [18, 18] });
  state.gpsMarker = L.marker(initialCenter, { icon: gpsIcon, zIndexOffset: 1000 }).addTo(state.map);

  // 地図をタップ(ドラッグを伴わないクリック)したら任意地点にピン追加
  // ただし経路手描きモード中はピン追加ではなく経路の頂点追加として扱う
  state.map.on('click', (e) => {
    if (state.drawMode) {
      addDrawPoint(e.latlng.lat, e.latlng.lng);
      return;
    }
    openPinTypeSheet(e.latlng.lat, e.latlng.lng);
  });

  // ユーザーが手動で地図を動かしたら追従モードを解除
  state.map.on('dragstart', () => setFollowMode(false));

  renderAllSessions();
  renderAllPins();
}

function setFollowMode(on) {
  state.followMode = on;
  const btn = document.getElementById('followBtn');
  btn.classList.toggle('follow-fab-active', on);
}

/* =========================================================================
   5. GPS 位置追跡(記録開始/停止)
========================================================================= */
function startRecording() {
  if (state.recording) return;

  state.recording = true;
  state.currentSession = {
    id: genId(),
    startTime: Date.now(),
    endTime: null,
    points: []
  };
  state.currentPolyline = L.polyline([], { color: '#e0672a', weight: 5, opacity: 0.95 }).addTo(state.map);

  document.getElementById('recIndicator').classList.remove('hidden');
  const recBtn = document.getElementById('recordBtn');
  recBtn.classList.add('recording');
  recBtn.querySelector('.btn-text').textContent = '記録停止';
  recBtn.querySelector('.btn-icon').textContent = '■';

  state.recTimerInterval = setInterval(updateRecIndicator, 1000);
  updateRecIndicator();

  requestWakeLock();

  if (state.demoMode) {
    startDemoWatch();
  } else {
    if (!('geolocation' in navigator)) {
      showToast('この端末は位置情報に対応していません');
      stopRecording();
      return;
    }
    state.watchId = navigator.geolocation.watchPosition(
      onPositionUpdate,
      onPositionError,
      { enableHighAccuracy: true, maximumAge: 2000, timeout: 15000 }
    );
  }

  showToast('記録を開始しました');
}

function stopRecording() {
  if (!state.recording) return;
  state.recording = false;

  if (state.watchId !== null) {
    navigator.geolocation.clearWatch(state.watchId);
    state.watchId = null;
  }
  stopDemoWatch();
  releaseWakeLock();
  clearInterval(state.recTimerInterval);
  document.getElementById('recIndicator').classList.add('hidden');

  const recBtn = document.getElementById('recordBtn');
  recBtn.classList.remove('recording');
  recBtn.querySelector('.btn-text').textContent = '記録開始';
  recBtn.querySelector('.btn-icon').textContent = '●';

  const session = state.currentSession;
  session.endTime = Date.now();
  session.distance = calcSessionDistance(session.points);
  session.visible = true;

  // 記録点が2点未満(ほぼ移動していない)場合は保存しない
  if (session.points.length >= 2) {
    state.data.sessions.push(session);
    saveData();
    showToast(`記録を保存しました(${formatDistance(session.distance)})`);
  } else {
    showToast('移動距離が短いため記録を破棄しました');
  }

  if (state.currentPolyline) {
    state.map.removeLayer(state.currentPolyline);
    state.currentPolyline = null;
  }
  state.currentSession = null;

  renderAllSessions();
  updateStatsDisplay();
  renderHistoryList();
}

function onPositionError(err) {
  console.warn('位置情報の取得に失敗', err);
  showToast('位置情報を取得できませんでした');
}

function onPositionUpdate(pos) {
  const { latitude, longitude, accuracy } = pos.coords;
  handleNewPoint(latitude, longitude, accuracy, pos.timestamp || Date.now());
}

function handleNewPoint(lat, lng, accuracy, timestamp) {
  // 現在地マーカー・地図追従は精度に関わらず更新(体感の反応速度を優先)
  state.gpsMarker.setLatLng([lat, lng]);
  if (state.followMode) {
    state.map.panTo([lat, lng], { animate: true });
  }

  if (!state.recording || !state.currentSession) return;

  // 精度フィルタ: accuracy が 50m を超える点は破棄
  if (typeof accuracy === 'number' && accuracy > ACCURACY_LIMIT_M) {
    return;
  }

  const points = state.currentSession.points;
  const last = points[points.length - 1];
  if (last) {
    const moved = haversineDistance(last.lat, last.lng, lat, lng);
    // 間引きフィルタ: 前回の記録点から 3m 未満の移動は捨てる
    if (moved < MIN_MOVE_M) return;
  }

  points.push({ lat, lng, t: timestamp });
  state.currentPolyline.addLatLng([lat, lng]);
}

/* =========================================================================
   6. デモモード(?demo=1): 東京の住宅街を歩くイメージの擬似移動
========================================================================= */
function buildDemoRoute() {
  // 東京・谷根千あたりを想定したジグザグの住宅街ルート(緯度経度の相対オフセットで生成)
  const base = { lat: 35.7218, lng: 139.7671 };
  const route = [];
  let lat = base.lat, lng = base.lng;
  const step = 0.00006; // 約6-7m相当
  const pattern = [
    [0, 1, 18], [1, 0, 12], [0, -1, 10], [1, 0, 10],
    [0, 1, 14], [1, 0, 12], [0, -1, 20], [-1, 0, 6],
    [0, -1, 10], [-1, 0, 10], [0, 1, 8], [1, 0, 20]
  ];
  route.push({ lat, lng });
  pattern.forEach(([dx, dy, count]) => {
    for (let i = 0; i < count; i++) {
      lat += dy * step * (0.6 + Math.random() * 0.8);
      lng += dx * step * (0.6 + Math.random() * 0.8);
      route.push({ lat, lng });
    }
  });
  return route;
}

function startDemoWatch() {
  state.demoIndex = 0;
  if (!state._demoRoute) state._demoRoute = buildDemoRoute();
  state.map.setView([state._demoRoute[0].lat, state._demoRoute[0].lng], 18);

  state.demoTimer = setInterval(() => {
    const route = state._demoRoute;
    if (state.demoIndex >= route.length) {
      state.demoIndex = 0; // ループさせてテストを継続できるようにする
    }
    const p = route[state.demoIndex++];
    // デモ用の疑似的な誤差(accuracy)を付与
    const accuracy = 8 + Math.random() * 10;
    handleNewPoint(p.lat, p.lng, accuracy, Date.now());
  }, 2000);
}

function stopDemoWatch() {
  if (state.demoTimer) {
    clearInterval(state.demoTimer);
    state.demoTimer = null;
  }
}

/* =========================================================================
   7. Wake Lock(記録中の画面スリープ防止)
========================================================================= */
async function requestWakeLock() {
  if (!('wakeLock' in navigator)) return; // 非対応ブラウザは黙ってスキップ
  try {
    state.wakeLock = await navigator.wakeLock.request('screen');
    state.wakeLock.addEventListener('release', () => {
      state.wakeLock = null;
    });
  } catch (e) {
    console.warn('Wake Lock を取得できませんでした', e);
  }
}

function releaseWakeLock() {
  if (state.wakeLock) {
    state.wakeLock.release().catch(() => {});
    state.wakeLock = null;
  }
}

document.addEventListener('visibilitychange', async () => {
  // タブ復帰時、記録中であれば Wake Lock を再取得する
  if (state.recording && document.visibilityState === 'visible' && !state.wakeLock) {
    await requestWakeLock();
  }
});

/* =========================================================================
   8. 記録インジケータの更新(経過時間・距離)
========================================================================= */
function updateRecIndicator() {
  if (!state.currentSession) return;
  const elapsed = Date.now() - state.currentSession.startTime;
  const dist = calcSessionDistance(state.currentSession.points);
  document.getElementById('recTime').textContent = formatElapsed(elapsed);
  document.getElementById('recDist').textContent = formatDistance(dist);
}

/* =========================================================================
   9. ピン(配布記録)の管理
========================================================================= */
function addPin(lat, lng, type, memo) {
  const pin = {
    id: genId(),
    sessionId: state.recording && state.currentSession ? state.currentSession.id : null,
    lat, lng, type,
    memo: memo || '',
    timestamp: Date.now()
  };
  state.data.pins.push(pin);
  saveData();
  renderPin(pin);
  updateStatsDisplay();
  return pin;
}

function deletePin(pinId) {
  state.data.pins = state.data.pins.filter((p) => p.id !== pinId);
  saveData();
  const layer = state.pinLayers.get(pinId);
  if (layer) {
    state.map.removeLayer(layer);
    state.pinLayers.delete(pinId);
  }
  updateStatsDisplay();
}

function quickDeliverHere() {
  // 現在地に即座に「配布済み」ピンを追加(歩きながらワンタップで使う想定)
  const latlng = state.gpsMarker.getLatLng();
  addPin(latlng.lat, latlng.lng, 'delivered', '');
  showToast('📮 配布済みとして記録しました');

  // 軽いフィードバック(対応端末のみ)
  if (navigator.vibrate) navigator.vibrate(40);
}

function pinIcon(type) {
  const color = PIN_COLORS[type];
  const isRefused = type === 'refused';
  const size = isRefused ? 26 : 20;
  return L.divIcon({
    className: '',
    html: `<div style="
      width:${size}px;height:${size}px;border-radius:50%;
      background:${color};border:2px solid #fff;
      box-shadow:0 1px 4px rgba(0,0,0,0.5);
      ${isRefused ? 'outline:2px solid ' + color + ';' : ''}
    "></div>`,
    iconSize: [size, size],
    iconAnchor: [size / 2, size / 2]
  });
}

function renderPin(pin) {
  const marker = L.marker([pin.lat, pin.lng], { icon: pinIcon(pin.type) });
  const dt = new Date(pin.timestamp);
  const dateStr = `${dt.getMonth() + 1}/${dt.getDate()} ${String(dt.getHours()).padStart(2, '0')}:${String(dt.getMinutes()).padStart(2, '0')}`;
  const labelClass = pin.type === 'refused' ? 'popup-refused' : '';
  marker.bindPopup(`
    <div class="${labelClass}"><strong>${PIN_LABELS[pin.type]}</strong></div>
    <div>${dateStr}</div>
    ${pin.memo ? `<div>${escapeHtml(pin.memo)}</div>` : ''}
    <button data-pin-detail="${pin.id}" style="margin-top:6px;">詳細・削除</button>
  `);
  marker.on('popupopen', () => {
    const btn = document.querySelector(`[data-pin-detail="${pin.id}"]`);
    if (btn) btn.addEventListener('click', () => openPinDetailSheet(pin.id));
  });
  if (state.pinsVisible) marker.addTo(state.map);
  state.pinLayers.set(pin.id, marker);
}

function renderAllPins() {
  state.pinLayers.forEach((layer) => state.map.removeLayer(layer));
  state.pinLayers.clear();
  state.data.pins.forEach(renderPin);
}

function setPinsVisible(visible) {
  state.pinsVisible = visible;
  state.pinLayers.forEach((layer) => {
    if (visible) {
      if (!state.map.hasLayer(layer)) layer.addTo(state.map);
    } else {
      if (state.map.hasLayer(layer)) state.map.removeLayer(layer);
    }
  });
}

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

/* ---- ピン種別選択シート ---- */
function openPinTypeSheet(lat, lng) {
  state.pendingPinLatLng = { lat, lng };
  document.getElementById('pinMemoInput').value = '';
  document.querySelectorAll('.pin-choice-btn').forEach((b) => b.classList.remove('selected'));
  document.getElementById('pinTypeSheet').dataset.selectedType = '';
  openSheet('pinTypeSheet');
}

function closePinTypeSheet() {
  closeSheet('pinTypeSheet');
  state.pendingPinLatLng = null;
}

/* ---- ピン詳細シート ---- */
function openPinDetailSheet(pinId) {
  const pin = state.data.pins.find((p) => p.id === pinId);
  if (!pin) return;
  state.editingPinId = pinId;
  state.map.closePopup();

  document.getElementById('pinDetailTitle').textContent = PIN_LABELS[pin.type];
  const dt = new Date(pin.timestamp);
  document.getElementById('pinDetailDate').textContent =
    `${formatDateJP(dt)} ${String(dt.getHours()).padStart(2, '0')}:${String(dt.getMinutes()).padStart(2, '0')}`;
  document.getElementById('pinDetailMemo').textContent = pin.memo ? `メモ: ${pin.memo}` : 'メモ: なし';

  openSheet('pinDetailSheet');
}

/* =========================================================================
   10. セッション(記録経路)の描画・履歴管理
========================================================================= */
function renderAllSessions() {
  state.sessionLayers.forEach((layer) => state.map.removeLayer(layer));
  state.sessionLayers.clear();
  state.data.sessions.forEach(renderSession);
}

function renderSession(session) {
  if (session.visible === false) return;
  const isToday = dateKeyOf(session.startTime) === todayKey();
  // 過去の経路は薄い色、今日の経路は濃い色で描画(一目で「通った道」が分かるようにする)
  const style = isToday
    ? { color: '#204137', weight: 5, opacity: 0.85 }
    : { color: '#7f9c92', weight: 4, opacity: 0.45 };
  const latlngs = session.points.map((p) => [p.lat, p.lng]);
  const polyline = L.polyline(latlngs, style).addTo(state.map);
  state.sessionLayers.set(session.id, polyline);
}

function deleteSession(sessionId) {
  state.data.sessions = state.data.sessions.filter((s) => s.id !== sessionId);
  // 紐づいていたピンは削除せず残す(お断り等の情報を誤って失わないため)
  state.data.pins.forEach((p) => { if (p.sessionId === sessionId) p.sessionId = null; });
  saveData();
  const layer = state.sessionLayers.get(sessionId);
  if (layer) {
    state.map.removeLayer(layer);
    state.sessionLayers.delete(sessionId);
  }
  renderHistoryList();
  updateStatsDisplay();
}

function toggleSessionVisibility(sessionId) {
  const session = state.data.sessions.find((s) => s.id === sessionId);
  if (!session) return;
  session.visible = !session.visible;
  saveData();
  const existing = state.sessionLayers.get(sessionId);
  if (existing) {
    state.map.removeLayer(existing);
    state.sessionLayers.delete(sessionId);
  }
  if (session.visible) renderSession(session);
  renderHistoryList();
}

function sessionPinCount(session) {
  return state.data.pins.filter((p) => p.sessionId === session.id && p.type === 'delivered').length;
}
function sessionRefusedCount(session) {
  return state.data.pins.filter((p) => p.sessionId === session.id && p.type === 'refused').length;
}

function renderHistoryList() {
  const container = document.getElementById('historyList');
  const sessions = [...state.data.sessions].sort((a, b) => b.startTime - a.startTime);

  if (sessions.length === 0) {
    container.innerHTML = '<p class="empty-note">まだ記録がありません。「記録開始」から歩き始めましょう。</p>';
    return;
  }

  container.innerHTML = '';
  sessions.forEach((session) => {
    const item = document.createElement('div');
    item.className = 'session-item';
    const delivered = sessionPinCount(session);
    const refused = sessionRefusedCount(session);
    item.innerHTML = `
      <div class="session-info">
        <div class="session-date">${formatDateJP(session.startTime)}</div>
        <div class="session-meta">
          ${formatDistance(session.distance || 0)} ・ 配布 ${delivered}件
          ${refused > 0 ? `<span class="warn-refused"> ・ お断り ${refused}件</span>` : ''}
        </div>
      </div>
      <button class="toggle-btn ${session.visible !== false ? 'on' : ''}" data-toggle="${session.id}" title="経路の表示切替">👁</button>
      <button class="icon-del-btn" data-del="${session.id}" title="削除">🗑</button>
    `;
    container.appendChild(item);
  });

  container.querySelectorAll('[data-toggle]').forEach((btn) => {
    btn.addEventListener('click', () => toggleSessionVisibility(btn.dataset.toggle));
  });
  container.querySelectorAll('[data-del]').forEach((btn) => {
    btn.addEventListener('click', () => {
      if (confirm('この記録(経路)を削除しますか?配布ピンは削除されません。')) {
        deleteSession(btn.dataset.del);
      }
    });
  });
}

/* =========================================================================
   11. 経路手描きモード(地図クリックで経路の頂点を追加して手動で経路を作る)
   - スマホでのGPS記録の代わりに、PC等から後日その日の経路を入力する用途を想定
========================================================================= */
function startDrawMode() {
  if (state.recording) {
    showToast('記録中は経路を手で描けません。先に記録を停止してください');
    return;
  }
  if (state.drawMode) return;

  closeAllSheets();
  state.drawMode = true;
  state.drawPoints = [];
  state.drawPreviewLayer = L.polyline([], {
    color: '#e0672a', weight: 5, opacity: 0.9, dashArray: '8 8'
  }).addTo(state.map);

  document.getElementById('drawBar').classList.remove('hidden');
  updateDrawBar();
  showToast('地図をタップして経路の頂点を追加してください');
}

function addDrawPoint(lat, lng) {
  state.drawPoints.push({ lat, lng });
  state.drawPreviewLayer.addLatLng([lat, lng]);

  const vertex = L.circleMarker([lat, lng], {
    radius: 5, color: '#fff', weight: 2, fillColor: '#e0672a', fillOpacity: 1
  }).addTo(state.map);
  state.drawVertexLayers.push(vertex);

  updateDrawBar();
}

function undoDrawPoint() {
  if (state.drawPoints.length === 0) return;
  state.drawPoints.pop();

  const latlngs = state.drawPreviewLayer.getLatLngs();
  latlngs.pop();
  state.drawPreviewLayer.setLatLngs(latlngs);

  const vertex = state.drawVertexLayers.pop();
  if (vertex) state.map.removeLayer(vertex);

  updateDrawBar();
}

function updateDrawBar() {
  const count = state.drawPoints.length;
  const dist = calcSessionDistance(state.drawPoints);
  document.getElementById('drawPointCount').textContent = `${count}点`;
  document.getElementById('drawDistance').textContent = formatDistance(dist);
}

// 手描き中のプレビューレイヤー(ポリライン・頂点マーカー)をすべて地図から除去
function clearDrawLayers() {
  if (state.drawPreviewLayer) {
    state.map.removeLayer(state.drawPreviewLayer);
    state.drawPreviewLayer = null;
  }
  state.drawVertexLayers.forEach((v) => state.map.removeLayer(v));
  state.drawVertexLayers = [];
}

// 手描きモードを終了し、地図クリックの挙動を通常(ピン追加)に戻す
function exitDrawMode() {
  state.drawMode = false;
  state.drawPoints = [];
  clearDrawLayers();
  document.getElementById('drawBar').classList.add('hidden');
}

function cancelDrawMode() {
  if (!state.drawMode) return;
  exitDrawMode();
  showToast('経路の手描きをキャンセルしました');
}

function saveDrawnRoute() {
  if (!state.drawMode) return;
  if (state.drawPoints.length < 2) {
    showToast('頂点を2つ以上追加してから保存してください');
    return;
  }

  const now = Date.now();
  const session = {
    id: genId(),
    startTime: now,
    endTime: now,
    points: state.drawPoints.map((p) => ({ lat: p.lat, lng: p.lng, t: now })),
    visible: true
  };
  session.distance = calcSessionDistance(session.points);
  state.data.sessions.push(session);
  saveData();

  exitDrawMode();

  renderAllSessions();
  updateStatsDisplay();
  renderHistoryList();
  showToast(`経路を保存しました(${formatDistance(session.distance)})`);
}

/* =========================================================================
   12. 統計表示
========================================================================= */
function updateStatsDisplay() {
  const today = todayKey();
  const todayPins = state.data.pins.filter((p) => p.type === 'delivered' && dateKeyOf(p.timestamp) === today);
  const todaySessions = state.data.sessions.filter((s) => dateKeyOf(s.startTime) === today);
  let todayDist = todaySessions.reduce((sum, s) => sum + (s.distance || 0), 0);
  if (state.recording && state.currentSession && dateKeyOf(state.currentSession.startTime) === today) {
    todayDist += calcSessionDistance(state.currentSession.points);
  }
  const totalCount = state.data.pins.filter((p) => p.type === 'delivered').length;

  document.getElementById('statTodayCount').textContent = `${todayPins.length}件`;
  document.getElementById('statTodayDist').textContent = formatDistance(todayDist);
  document.getElementById('statTotalCount').textContent = `${totalCount}件`;
}

/* =========================================================================
   13. ボトムシート開閉の共通処理
========================================================================= */
function openSheet(id) {
  document.getElementById('overlay').classList.remove('hidden');
  document.getElementById(id).classList.remove('hidden');
}
function closeSheet(id) {
  document.getElementById(id).classList.add('hidden');
  const anyOpen = ['historyPanel', 'settingsPanel', 'pinTypeSheet', 'pinDetailSheet']
    .some((sid) => sid !== id && !document.getElementById(sid).classList.contains('hidden'));
  if (!anyOpen) document.getElementById('overlay').classList.add('hidden');
}
function closeAllSheets() {
  ['historyPanel', 'settingsPanel', 'pinTypeSheet', 'pinDetailSheet'].forEach((id) => {
    document.getElementById(id).classList.add('hidden');
  });
  document.getElementById('overlay').classList.add('hidden');
}

/* =========================================================================
   14. データのエクスポート・インポート・全削除
========================================================================= */
function exportData() {
  const blob = new Blob([JSON.stringify(state.data, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  const d = new Date();
  const stamp = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;
  a.href = url;
  a.download = `posting-map-backup-${stamp}.json`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
  showToast('JSONをエクスポートしました');
}

function importDataFromFile(file) {
  const reader = new FileReader();
  reader.onload = () => {
    try {
      const imported = JSON.parse(reader.result);
      if (!imported || !Array.isArray(imported.sessions) || !Array.isArray(imported.pins)) {
        throw new Error('invalid format');
      }
      if (!confirm('現在のデータに追加でインポートしますか?(キャンセルすると読み込みを中止します)')) return;
      const migrated = migrateData(imported);
      // ID重複を避けるため、既存になければ追加する形でマージ
      const existingSessionIds = new Set(state.data.sessions.map((s) => s.id));
      const existingPinIds = new Set(state.data.pins.map((p) => p.id));
      migrated.sessions.forEach((s) => { if (!existingSessionIds.has(s.id)) state.data.sessions.push(s); });
      migrated.pins.forEach((p) => { if (!existingPinIds.has(p.id)) state.data.pins.push(p); });
      saveData();
      renderAllSessions();
      renderAllPins();
      renderHistoryList();
      updateStatsDisplay();
      showToast('インポートが完了しました');
    } catch (e) {
      console.error(e);
      alert('ファイルの読み込みに失敗しました。正しいバックアップJSONか確認してください。');
    }
  };
  reader.readAsText(file);
}

function deleteAllData() {
  if (!confirm('すべての記録(経路・ピン)を削除します。この操作は取り消せません。本当によろしいですか?')) return;
  if (!confirm('最終確認: 本当にすべてのデータを削除しますか?')) return;
  state.data = createEmptyData();
  saveData();
  renderAllSessions();
  renderAllPins();
  renderHistoryList();
  updateStatsDisplay();
  closeAllSheets();
  showToast('すべてのデータを削除しました');
}

/* =========================================================================
   15. イベント登録・初期化
========================================================================= */
function setupEventListeners() {
  document.getElementById('recordBtn').addEventListener('click', () => {
    if (state.recording) stopRecording(); else startRecording();
  });

  document.getElementById('deliverBtn').addEventListener('click', quickDeliverHere);

  document.getElementById('followBtn').addEventListener('click', () => {
    setFollowMode(!state.followMode);
    if (state.followMode) {
      const c = state.gpsMarker.getLatLng();
      state.map.panTo(c, { animate: true });
    }
  });

  document.getElementById('layerBtn').addEventListener('click', () => {
    setBaseLayer(state.baseLayerType === 'gsi' ? 'osm' : 'gsi');
  });

  document.getElementById('menuBtn').addEventListener('click', () => {
    renderHistoryList();
    openSheet('historyPanel');
  });
  document.getElementById('settingsBtn').addEventListener('click', () => openSheet('settingsPanel'));

  document.querySelectorAll('[data-close]').forEach((btn) => {
    btn.addEventListener('click', () => closeSheet(btn.dataset.close));
  });
  document.getElementById('overlay').addEventListener('click', closeAllSheets);

  document.getElementById('pinsVisibleToggle').addEventListener('click', (e) => {
    setPinsVisible(!state.pinsVisible);
    e.currentTarget.classList.toggle('on', state.pinsVisible);
  });

  // 経路手描きモード
  document.getElementById('drawRouteBtn').addEventListener('click', startDrawMode);
  document.getElementById('drawUndoBtn').addEventListener('click', undoDrawPoint);
  document.getElementById('drawSaveBtn').addEventListener('click', saveDrawnRoute);
  document.getElementById('drawCancelBtn').addEventListener('click', cancelDrawMode);

  // ピン種別選択シート
  document.querySelectorAll('.pin-choice-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.pin-choice-btn').forEach((b) => b.classList.remove('selected'));
      btn.classList.add('selected');
      document.getElementById('pinTypeSheet').dataset.selectedType = btn.dataset.type;
    });
  });
  document.getElementById('pinSaveBtn').addEventListener('click', () => {
    const type = document.getElementById('pinTypeSheet').dataset.selectedType;
    if (!type) { showToast('種別を選択してください'); return; }
    if (!state.pendingPinLatLng) { closePinTypeSheet(); return; }
    const memo = document.getElementById('pinMemoInput').value.trim();
    addPin(state.pendingPinLatLng.lat, state.pendingPinLatLng.lng, type, memo);
    showToast(`${PIN_LABELS[type]}として記録しました`);
    closePinTypeSheet();
    closeSheet('pinTypeSheet');
  });
  document.getElementById('pinCancelBtn').addEventListener('click', closePinTypeSheet);

  // ピン詳細シート
  document.getElementById('pinDeleteBtn').addEventListener('click', () => {
    if (!state.editingPinId) return;
    if (confirm('このピンを削除しますか?')) {
      deletePin(state.editingPinId);
      closeSheet('pinDetailSheet');
      state.editingPinId = null;
      renderHistoryList();
    }
  });

  // 設定パネル
  document.getElementById('exportBtn').addEventListener('click', exportData);
  document.getElementById('importBtn').addEventListener('click', () => document.getElementById('importFile').click());
  document.getElementById('importFile').addEventListener('change', (e) => {
    const file = e.target.files[0];
    if (file) importDataFromFile(file);
    e.target.value = '';
  });
  document.getElementById('deleteAllBtn').addEventListener('click', deleteAllData);
}

function requestInitialLocation() {
  if (state.demoMode) {
    const route = state._demoRoute || (state._demoRoute = buildDemoRoute());
    state.gpsMarker.setLatLng([route[0].lat, route[0].lng]);
    state.map.setView([route[0].lat, route[0].lng], 17);
    return;
  }
  if (!('geolocation' in navigator)) return;
  navigator.geolocation.getCurrentPosition(
    (pos) => {
      const { latitude, longitude } = pos.coords;
      state.gpsMarker.setLatLng([latitude, longitude]);
      state.map.setView([latitude, longitude], 17);
    },
    () => { /* 取得失敗時は初期座標のまま。記録開始時に改めて要求される */ },
    { enableHighAccuracy: true, timeout: 8000 }
  );
}

function init() {
  const params = new URLSearchParams(location.search);
  state.demoMode = params.get('demo') === '1';

  document.getElementById('versionNote').textContent =
    `データバージョン: ${state.data.version}${state.demoMode ? ' ・ デモモードで動作中' : ''}`;

  initMap();
  setFollowMode(true);
  setupEventListeners();
  requestInitialLocation();
  updateStatsDisplay();
  renderHistoryList();

  if (state.demoMode) {
    showToast('デモモードで起動しました(擬似GPSで動作確認できます)');
  }
}

// Service Worker 登録(アプリシェルのオフラインキャッシュ)
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('sw.js').catch((e) => console.warn('SW登録失敗', e));
  });
}

document.addEventListener('DOMContentLoaded', init);
