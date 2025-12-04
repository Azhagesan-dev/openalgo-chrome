// OpenAlgo Options Scalping Extension v2.0
// Global state
let state = {
  action: 'BUY',
  optionType: 'CE',
  selectedExpiry: '',
  selectedOffset: 'ATM',
  selectedStrike: 0,
  useMoneyness: true,
  lots: 1,
  orderType: 'MARKET',
  price: 0,
  lotSize: 25,
  underlyingLtp: 0,
  underlyingPrevClose: 0,
  optionLtp: 0,
  optionPrevClose: 0
};

let expiryList = [];
let strikeChain = [];
let settings = {};
let refreshInterval = null;

// Initialize on load
document.addEventListener('DOMContentLoaded', init);
if (document.readyState === 'interactive' || document.readyState === 'complete') init();

async function init() {
  if (document.getElementById('openalgo-controls')) return;
  settings = await loadSettings();
  injectStyles();
  injectUI();
  if (settings.uiMode === 'scalping' && settings.symbols?.length > 0) {
    startDataRefresh();
  }
}

// Load settings from chrome storage
function loadSettings() {
  return new Promise((resolve) => {
    chrome.storage.sync.get(['hostUrl', 'apiKey', 'symbols', 'activeSymbolId', 'uiMode', 'symbol', 'exchange', 'product', 'quantity'], (data) => {
      resolve({
        hostUrl: data.hostUrl || 'http://127.0.0.1:5000',
        apiKey: data.apiKey || '',
        symbols: data.symbols || [],
        activeSymbolId: data.activeSymbolId || '',
        uiMode: data.uiMode || 'scalping',
        // Legacy settings for quick mode
        symbol: data.symbol || '',
        exchange: data.exchange || 'NSE',
        product: data.product || 'MIS',
        quantity: data.quantity || '1'
      });
    });
  });
}

// Save settings
function saveSettings(newSettings) {
  return new Promise((resolve) => {
    chrome.storage.sync.set(newSettings, () => {
      Object.assign(settings, newSettings);
      resolve();
    });
  });
}

// Get active symbol config
function getActiveSymbol() {
  if (!settings.symbols?.length) return null;
  return settings.symbols.find(s => s.id === settings.activeSymbolId) || settings.symbols[0];
}

// Generate UUID
function uuid() {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
    const r = Math.random() * 16 | 0;
    return (c === 'x' ? r : (r & 0x3 | 0x8)).toString(16);
  });
}

// Derive option exchange from underlying exchange
function deriveOptionExchange(exchange) {
  if (exchange === 'NSE_INDEX' || exchange === 'NSE') return 'NFO';
  if (exchange === 'BSE_INDEX' || exchange === 'BSE') return 'BFO';
  return 'NFO';
}

// Format number with commas
function formatNumber(num, decimals = 2) {
  return Number(num).toLocaleString('en-IN', { minimumFractionDigits: decimals, maximumFractionDigits: decimals });
}

// Calculate change display
function getChangeDisplay(ltp, prevClose) {
  const change = ltp - prevClose;
  const changePercent = prevClose ? ((change / prevClose) * 100) : 0;
  const arrow = change >= 0 ? '↑' : '↓';
  const sign = change >= 0 ? '+' : '';
  const colorClass = change >= 0 ? 'positive' : 'negative';
  return { change, changePercent, arrow, sign, colorClass };
}

// API call helper
async function apiCall(endpoint, data) {
  try {
    const response = await fetch(`${settings.hostUrl}${endpoint}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ apikey: settings.apiKey, ...data })
    });
    return await response.json();
  } catch (error) {
    console.error('API Error:', error);
    return { status: 'error', message: error.message };
  }
}

// Fetch quotes for underlying
async function fetchUnderlyingQuote() {
  const symbol = getActiveSymbol();
  if (!symbol) return;
  const result = await apiCall('/api/v1/quotes', { symbol: symbol.symbol, exchange: symbol.exchange });
  if (result.status === 'success' && result.data) {
    state.underlyingLtp = result.data.ltp || 0;
    state.underlyingPrevClose = result.data.prev_close || 0;
    updateUnderlyingDisplay();
  }
}

// Fetch funds
async function fetchFunds() {
  const result = await apiCall('/api/v1/funds', {});
  if (result.status === 'success' && result.data) {
    const available = parseFloat(result.data.availablecash) || 0;
    const realized = parseFloat(result.data.m2mrealized) || 0;
    const unrealized = parseFloat(result.data.m2munrealized) || 0;
    const todayPL = realized + unrealized;
    updateFundsDisplay(available, todayPL);
  }
}

// Fetch expiry list
async function fetchExpiry() {
  const symbol = getActiveSymbol();
  if (!symbol) return;
  const result = await apiCall('/api/v1/expiry', {
    symbol: symbol.symbol,
    exchange: symbol.optionExchange,
    instrumenttype: 'options'
  });
  if (result.status === 'success' && result.data) {
    expiryList = result.data;
    if (expiryList.length > 0 && !state.selectedExpiry) {
      state.selectedExpiry = expiryList[0].replace(/-/g, '').toUpperCase();
    }
    updateExpirySlider();
  }
}

// Fetch strike chain using optionsymbol API
async function fetchStrikeChain() {
  const symbol = getActiveSymbol();
  if (!symbol || !state.selectedExpiry) return;

  const offsets = ['ITM5', 'ITM4', 'ITM3', 'ITM2', 'ITM1', 'ATM', 'OTM1', 'OTM2', 'OTM3', 'OTM4', 'OTM5'];
  const promises = offsets.map(offset =>
    apiCall('/api/v1/optionsymbol', {
      strategy: 'Chrome',
      underlying: symbol.symbol,
      exchange: symbol.exchange,
      expiry_date: state.selectedExpiry,
      offset: offset,
      option_type: state.optionType
    })
  );

  const results = await Promise.all(promises);
  strikeChain = offsets.map((offset, i) => {
    const r = results[i];
    if (r.status === 'success') {
      const strikeMatch = r.symbol.match(/(\d+)(CE|PE)$/);
      return {
        offset,
        symbol: r.symbol,
        exchange: r.exchange || symbol.optionExchange,
        strike: strikeMatch ? parseInt(strikeMatch[1]) : 0,
        lotsize: r.lotsize || 25,
        ltp: 0,
        prevClose: 0
      };
    }
    return null;
  }).filter(Boolean);

  // Store lotsize from ATM
  const atmStrike = strikeChain.find(s => s.offset === 'ATM');
  if (atmStrike) state.lotSize = atmStrike.lotsize;

  // Fetch LTPs for all strikes
  await fetchStrikeLTPs();
}

// Fetch LTPs for strike chain
async function fetchStrikeLTPs() {
  if (strikeChain.length === 0) return;
  const symbols = strikeChain.map(s => ({ symbol: s.symbol, exchange: s.exchange }));
  const result = await apiCall('/api/v1/multiquotes', { symbols });

  if (result.status === 'success' && result.results) {
    result.results.forEach(r => {
      const strike = strikeChain.find(s => s.symbol === r.symbol);
      if (strike && r.data) {
        strike.ltp = r.data.ltp || 0;
        strike.prevClose = r.data.prev_close || 0;
      }
    });
  }
  updateStrikeDropdown();
  updateSelectedOptionLTP();
}

// Update selected option LTP display
function updateSelectedOptionLTP() {
  const selected = strikeChain.find(s => s.offset === state.selectedOffset);
  if (selected) {
    state.optionLtp = selected.ltp;
    state.optionPrevClose = selected.prevClose;
    state.selectedStrike = selected.strike;
    updatePriceDisplay();
  }
}

// Place order using optionsorder API (moneyness-based)
async function placeOptionsOrder() {
  const symbol = getActiveSymbol();
  if (!symbol) return showNotification('No symbol selected', 'error');

  const quantity = state.lotSize * state.lots;
  const data = {
    strategy: 'Chrome',
    underlying: symbol.symbol,
    exchange: symbol.exchange,
    expiry_date: state.selectedExpiry,
    offset: state.selectedOffset,
    option_type: state.optionType,
    action: state.action,
    quantity: quantity,
    pricetype: state.orderType,
    product: symbol.productType,
    price: state.orderType === 'LIMIT' || state.orderType === 'SL' ? String(state.price) : '0',
    trigger_price: state.orderType === 'SL' || state.orderType === 'SL-M' ? String(state.price) : '0'
  };

  const result = await apiCall('/api/v1/optionsorder', data);
  handleOrderResponse(result);
}

// Place order using placeorder API (strike-based)
async function placePlaceOrder() {
  const symbol = getActiveSymbol();
  const selected = strikeChain.find(s => s.offset === state.selectedOffset);
  if (!symbol || !selected) return showNotification('No strike selected', 'error');

  const quantity = state.lotSize * state.lots;
  const data = {
    strategy: 'Chrome',
    symbol: selected.symbol,
    exchange: selected.exchange,
    action: state.action,
    product: symbol.productType,
    pricetype: state.orderType,
    quantity: String(quantity),
    price: state.orderType === 'LIMIT' || state.orderType === 'SL' ? String(state.price) : '0',
    trigger_price: state.orderType === 'SL' || state.orderType === 'SL-M' ? String(state.price) : '0'
  };

  const result = await apiCall('/api/v1/placeorder', data);
  handleOrderResponse(result);
}

// Handle order response
function handleOrderResponse(result) {
  if (result.status === 'success') {
    showNotification(`Order placed! ID: ${result.orderid}`, 'success');
  } else {
    showNotification(`Order failed: ${result.message}`, 'error');
  }
}

// Legacy order functions for quick mode
function placeLegacyOrder(action) {
  const url = `${settings.hostUrl}/api/v1/placeorder`;
  const data = {
    apikey: settings.apiKey,
    strategy: 'Chrome',
    symbol: settings.symbol,
    action: action,
    exchange: settings.exchange,
    pricetype: 'MARKET',
    product: settings.product,
    quantity: settings.quantity
  };
  makeLegacyApiCall(url, data, action === 'BUY' ? 'Long Entry' : 'Short Entry');
}

function placeLegacySmartOrder(action) {
  const url = `${settings.hostUrl}/api/v1/placesmartorder`;
  const data = {
    apikey: settings.apiKey,
    strategy: 'Chrome',
    exchange: settings.exchange,
    symbol: settings.symbol,
    action: action,
    product: settings.product,
    pricetype: 'MARKET',
    quantity: '0',
    position_size: '0'
  };
  makeLegacyApiCall(url, data, action === 'BUY' ? 'Long Exit' : 'Short Exit');
}

function makeLegacyApiCall(url, data, actionText) {
  fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) })
    .then(r => r.json())
    .then(data => {
      if (data.status === 'success') showNotification(`${actionText} successful!`, 'success');
      else showNotification(`Error: ${data.message}`, 'error');
    })
    .catch(e => showNotification(`API Error: ${e.message}`, 'error'));
}

// Start data refresh interval
function startDataRefresh() {
  fetchUnderlyingQuote();
  fetchFunds();
  fetchExpiry();
  if (refreshInterval) clearInterval(refreshInterval);
  refreshInterval = setInterval(() => {
    fetchUnderlyingQuote();
    fetchFunds();
    if (strikeChain.length > 0) fetchStrikeLTPs();
  }, 5000);
}

// Show notification
function showNotification(message, type) {
  const n = document.createElement('div');
  n.className = `openalgo-notification ${type}`;
  n.textContent = message;
  document.body.appendChild(n);
  setTimeout(() => { n.classList.add('fadeOut'); setTimeout(() => n.remove(), 500); }, 3000);
}

// UI update functions
function updateUnderlyingDisplay() {
  const el = document.getElementById('oa-underlying-ltp');
  if (!el) return;
  const { change, changePercent, arrow, sign, colorClass } = getChangeDisplay(state.underlyingLtp, state.underlyingPrevClose);
  el.innerHTML = `<span class="${colorClass}">${formatNumber(state.underlyingLtp)} ${arrow} ${sign}${formatNumber(change)} (${sign}${changePercent.toFixed(2)}%)</span>`;
}

function updateFundsDisplay(available, todayPL) {
  const el = document.getElementById('oa-funds');
  if (!el) return;
  const plClass = todayPL >= 0 ? 'positive' : 'negative';
  const plSign = todayPL >= 0 ? '+' : '';
  el.innerHTML = `Avail: ₹${formatNumber(available, 0)} | <span class="${plClass}">P/L: ${plSign}₹${formatNumber(todayPL, 0)}</span>`;
}

function updateExpirySlider() {
  const container = document.getElementById('oa-expiry-slider');
  if (!container) return;
  container.innerHTML = expiryList.slice(0, 8).map(exp => {
    const formatted = exp.replace(/-/g, '').toUpperCase();
    const short = exp.split('-').slice(0, 2).join('');
    const isActive = formatted === state.selectedExpiry;
    return `<button class="oa-expiry-btn ${isActive ? 'active' : ''}" data-expiry="${formatted}">${short}</button>`;
  }).join('');
  container.querySelectorAll('.oa-expiry-btn').forEach(btn => {
    btn.addEventListener('click', async () => {
      state.selectedExpiry = btn.dataset.expiry;
      updateExpirySlider();
      await fetchStrikeChain();
    });
  });
}

function updateStrikeDropdown() {
  const list = document.getElementById('oa-strike-list');
  if (!list) return;
  list.innerHTML = strikeChain.map(s => {
    const { sign, colorClass } = getChangeDisplay(s.ltp, s.prevClose);
    const change = s.ltp - s.prevClose;
    const isATM = s.offset === 'ATM';
    const isSelected = s.offset === state.selectedOffset;
    return `<div class="oa-strike-row ${isATM ? 'atm' : ''} ${isSelected ? 'selected' : ''}" data-offset="${s.offset}" data-strike="${s.strike}">
      <span class="oa-moneyness">${s.offset}</span>
      <span class="oa-strike">${s.strike}</span>
      <span class="oa-ltp ${colorClass}">${formatNumber(s.ltp)} ${sign}${formatNumber(Math.abs(change))}</span>
    </div>`;
  }).join('');
  list.querySelectorAll('.oa-strike-row').forEach(row => {
    row.addEventListener('click', () => {
      state.selectedOffset = row.dataset.offset;
      state.selectedStrike = parseInt(row.dataset.strike);
      updateSelectedOptionLTP();
      updateStrikeButton();
      toggleStrikeDropdown(false);
    });
  });
}

function updateStrikeButton() {
  const btn = document.getElementById('oa-strike-btn');
  if (btn) btn.textContent = `${state.selectedOffset} ${state.selectedStrike}`;
}

function updatePriceDisplay() {
  const el = document.getElementById('oa-price');
  if (!el) return;
  if (state.orderType === 'MARKET') {
    el.value = state.optionLtp.toFixed(2);
    el.disabled = true;
  } else {
    el.disabled = false;
    if (state.price === 0) state.price = state.optionLtp;
    el.value = state.price.toFixed(2);
  }
  updateOrderButton();
}

function updateOrderButton() {
  const btn = document.getElementById('oa-order-btn');
  if (!btn) return;
  const price = state.orderType === 'MARKET' ? state.optionLtp : state.price;
  btn.textContent = `${state.action} @ ${formatNumber(price)}`;
  btn.className = `oa-order-btn ${state.action === 'BUY' ? 'buy' : 'sell'}`;
}

function toggleStrikeDropdown(show) {
  const dd = document.getElementById('oa-strike-dropdown');
  if (dd) dd.classList.toggle('hidden', !show);
}

// Inject the main UI
function injectUI() {
  const container = document.createElement('div');
  container.id = 'openalgo-controls';
  container.className = 'oa-container';

  if (settings.uiMode === 'scalping') {
    container.innerHTML = buildScalpingUI();
    setupScalpingEvents(container);
  } else {
    container.innerHTML = buildQuickUI();
    setupQuickEvents(container);
  }

  makeDraggable(container);
  document.body.appendChild(container);
}

function buildScalpingUI() {
  const symbol = getActiveSymbol();
  return `
    <div class="oa-drag-handle"></div>
    <div class="oa-header">
      <select id="oa-symbol-select" class="oa-select">
        ${settings.symbols.map(s => `<option value="${s.id}" ${s.id === settings.activeSymbolId ? 'selected' : ''}>${s.symbol}</option>`).join('')}
        ${settings.symbols.length === 0 ? '<option value="">Add symbol in settings</option>' : ''}
      </select>
      <span id="oa-underlying-ltp" class="oa-ltp-display">--</span>
      <span id="oa-funds" class="oa-funds">--</span>
      <button id="oa-settings-btn" class="oa-icon-btn">⋮</button>
    </div>
    <div class="oa-controls">
      <button id="oa-action-btn" class="oa-toggle buy">B</button>
      <button id="oa-option-type-btn" class="oa-toggle">CE</button>
      <button id="oa-strike-btn" class="oa-strike-select">ATM --</button>
      <div class="oa-lots">
        <button id="oa-lots-dec" class="oa-lot-btn">−</button>
        <input id="oa-lots" type="number" value="1" min="1">
        <button id="oa-lots-inc" class="oa-lot-btn">+</button>
        <span class="oa-lots-label">LOTS</span>
      </div>
      <button id="oa-ordertype-btn" class="oa-toggle">${state.orderType}</button>
      <input id="oa-price" type="number" class="oa-price-input" value="0" step="0.05">
      <button id="oa-order-btn" class="oa-order-btn buy">BUY @ --</button>
    </div>
    <div id="oa-strike-dropdown" class="oa-strike-dropdown hidden">
      <div id="oa-expiry-slider" class="oa-expiry-slider"></div>
      <div class="oa-strike-header"><span>Moneyness</span><span>Strike</span><span>LTP</span></div>
      <div id="oa-strike-list" class="oa-strike-list"></div>
    </div>
    <div id="oa-settings-panel" class="oa-settings-panel hidden"></div>
  `;
}

function buildQuickUI() {
  return `
    <div class="oa-drag-handle"></div>
    <div class="oa-quick-row">
      <button id="le-btn" class="oa-btn success">LE</button>
      <button id="lx-btn" class="oa-btn warning">LX</button>
      <button id="se-btn" class="oa-btn error">SE</button>
      <button id="sx-btn" class="oa-btn info">SX</button>
      <button id="oa-settings-btn" class="oa-icon-btn">⋮</button>
    </div>
    <div id="oa-settings-panel" class="oa-settings-panel hidden"></div>
  `;
}

function setupScalpingEvents(container) {
  // Symbol select
  container.querySelector('#oa-symbol-select')?.addEventListener('change', async (e) => {
    await saveSettings({ activeSymbolId: e.target.value });
    strikeChain = [];
    state.selectedExpiry = '';
    startDataRefresh();
  });

  // Action toggle (B/S)
  container.querySelector('#oa-action-btn')?.addEventListener('click', (e) => {
    state.action = state.action === 'BUY' ? 'SELL' : 'BUY';
    e.target.textContent = state.action === 'BUY' ? 'B' : 'S';
    e.target.className = `oa-toggle ${state.action === 'BUY' ? 'buy' : 'sell'}`;
    updateOrderButton();
  });

  // Option type toggle (CE/PE)
  container.querySelector('#oa-option-type-btn')?.addEventListener('click', async (e) => {
    state.optionType = state.optionType === 'CE' ? 'PE' : 'CE';
    e.target.textContent = state.optionType;
    await fetchStrikeChain();
  });

  // Strike button
  container.querySelector('#oa-strike-btn')?.addEventListener('click', () => {
    const dd = document.getElementById('oa-strike-dropdown');
    const isHidden = dd.classList.contains('hidden');
    toggleStrikeDropdown(isHidden);
    if (isHidden && strikeChain.length === 0) fetchStrikeChain();
  });

  // Lots controls
  container.querySelector('#oa-lots-dec')?.addEventListener('click', () => {
    if (state.lots > 1) { state.lots--; document.getElementById('oa-lots').value = state.lots; }
  });
  container.querySelector('#oa-lots-inc')?.addEventListener('click', () => {
    state.lots++; document.getElementById('oa-lots').value = state.lots;
  });
  container.querySelector('#oa-lots')?.addEventListener('change', (e) => {
    state.lots = Math.max(1, parseInt(e.target.value) || 1);
    e.target.value = state.lots;
  });

  // Order type toggle
  const orderTypes = ['MARKET', 'LIMIT', 'SL', 'SL-M'];
  container.querySelector('#oa-ordertype-btn')?.addEventListener('click', (e) => {
    const idx = orderTypes.indexOf(state.orderType);
    state.orderType = orderTypes[(idx + 1) % orderTypes.length];
    e.target.textContent = state.orderType;
    updatePriceDisplay();
  });

  // Price input
  container.querySelector('#oa-price')?.addEventListener('change', (e) => {
    state.price = parseFloat(e.target.value) || 0;
    updateOrderButton();
  });

  // Order button
  container.querySelector('#oa-order-btn')?.addEventListener('click', () => {
    if (state.useMoneyness) placeOptionsOrder();
    else placePlaceOrder();
  });

  // Settings button
  container.querySelector('#oa-settings-btn')?.addEventListener('click', () => toggleSettingsPanel());
}

function setupQuickEvents(container) {
  container.querySelector('#le-btn')?.addEventListener('click', () => placeLegacyOrder('BUY'));
  container.querySelector('#lx-btn')?.addEventListener('click', () => placeLegacySmartOrder('BUY'));
  container.querySelector('#se-btn')?.addEventListener('click', () => placeLegacyOrder('SELL'));
  container.querySelector('#sx-btn')?.addEventListener('click', () => placeLegacySmartOrder('SELL'));
  container.querySelector('#oa-settings-btn')?.addEventListener('click', () => toggleSettingsPanel());
}

// Settings panel
function toggleSettingsPanel() {
  const panel = document.getElementById('oa-settings-panel');
  if (!panel) return;
  const isHidden = panel.classList.contains('hidden');
  if (isHidden) {
    panel.innerHTML = buildSettingsPanel();
    setupSettingsEvents(panel);
  }
  panel.classList.toggle('hidden');
}

function buildSettingsPanel() {
  const isScalping = settings.uiMode === 'scalping';
  return `
    <div class="oa-settings-content">
      <h3>Settings</h3>
      <div class="oa-form-group">
        <label>Host URL</label>
        <input id="oa-host" type="text" value="${settings.hostUrl}">
      </div>
      <div class="oa-form-group">
        <label>API Key</label>
        <input id="oa-apikey" type="text" value="${settings.apiKey}">
      </div>
      <div class="oa-form-group">
        <label>UI Mode</label>
        <select id="oa-uimode">
          <option value="scalping" ${isScalping ? 'selected' : ''}>Options Scalping</option>
          <option value="quick" ${!isScalping ? 'selected' : ''}>Quick Orders (LE/LX/SE/SX)</option>
        </select>
      </div>
      ${isScalping ? buildSymbolSettings() : buildQuickSettings()}
      <button id="oa-save-settings" class="oa-btn primary">Save Settings</button>
    </div>
  `;
}

function buildSymbolSettings() {
  return `
    <h4>Symbols</h4>
    <div id="oa-symbol-list">
      ${settings.symbols.map(s => `
        <div class="oa-symbol-item" data-id="${s.id}">
          <span>${s.symbol} (${s.exchange})</span>
          <button class="oa-remove-symbol">✕</button>
        </div>
      `).join('')}
    </div>
    <div class="oa-add-symbol">
      <input id="oa-new-symbol" type="text" placeholder="Symbol (e.g. NIFTY)">
      <select id="oa-new-exchange">
        <option value="NSE_INDEX">NSE_INDEX</option>
        <option value="NSE">NSE</option>
        <option value="BSE_INDEX">BSE_INDEX</option>
        <option value="BSE">BSE</option>
      </select>
      <select id="oa-new-product">
        <option value="MIS">MIS</option>
        <option value="NRML">NRML</option>
      </select>
      <button id="oa-add-symbol" class="oa-btn success">Add</button>
    </div>
  `;
}

function buildQuickSettings() {
  return `
    <div class="oa-form-group">
      <label>Symbol</label>
      <input id="oa-quick-symbol" type="text" value="${settings.symbol}">
    </div>
    <div class="oa-form-group">
      <label>Exchange</label>
      <select id="oa-quick-exchange">
        <option value="NSE" ${settings.exchange === 'NSE' ? 'selected' : ''}>NSE</option>
        <option value="NFO" ${settings.exchange === 'NFO' ? 'selected' : ''}>NFO</option>
        <option value="BSE" ${settings.exchange === 'BSE' ? 'selected' : ''}>BSE</option>
        <option value="BFO" ${settings.exchange === 'BFO' ? 'selected' : ''}>BFO</option>
      </select>
    </div>
    <div class="oa-form-group">
      <label>Product</label>
      <select id="oa-quick-product">
        <option value="MIS" ${settings.product === 'MIS' ? 'selected' : ''}>MIS</option>
        <option value="NRML" ${settings.product === 'NRML' ? 'selected' : ''}>NRML</option>
        <option value="CNC" ${settings.product === 'CNC' ? 'selected' : ''}>CNC</option>
      </select>
    </div>
    <div class="oa-form-group">
      <label>Quantity</label>
      <input id="oa-quick-qty" type="number" value="${settings.quantity}">
    </div>
  `;
}

function setupSettingsEvents(panel) {
  // Add symbol
  panel.querySelector('#oa-add-symbol')?.addEventListener('click', async () => {
    const symbolInput = panel.querySelector('#oa-new-symbol');
    const exchange = panel.querySelector('#oa-new-exchange').value;
    const product = panel.querySelector('#oa-new-product').value;
    const symbolName = symbolInput.value.trim().toUpperCase();
    if (!symbolName) return;

    const newSymbol = {
      id: uuid(),
      symbol: symbolName,
      exchange: exchange,
      optionExchange: deriveOptionExchange(exchange),
      productType: product
    };
    settings.symbols.push(newSymbol);
    if (!settings.activeSymbolId) settings.activeSymbolId = newSymbol.id;
    await saveSettings({ symbols: settings.symbols, activeSymbolId: settings.activeSymbolId });
    symbolInput.value = '';
    toggleSettingsPanel();
    location.reload();
  });

  // Remove symbol
  panel.querySelectorAll('.oa-remove-symbol').forEach(btn => {
    btn.addEventListener('click', async (e) => {
      const id = e.target.closest('.oa-symbol-item').dataset.id;
      settings.symbols = settings.symbols.filter(s => s.id !== id);
      if (settings.activeSymbolId === id) settings.activeSymbolId = settings.symbols[0]?.id || '';
      await saveSettings({ symbols: settings.symbols, activeSymbolId: settings.activeSymbolId });
      toggleSettingsPanel();
      location.reload();
    });
  });

  // Save settings
  panel.querySelector('#oa-save-settings')?.addEventListener('click', async () => {
    const newSettings = {
      hostUrl: panel.querySelector('#oa-host').value,
      apiKey: panel.querySelector('#oa-apikey').value,
      uiMode: panel.querySelector('#oa-uimode').value
    };
    if (newSettings.uiMode === 'quick') {
      newSettings.symbol = panel.querySelector('#oa-quick-symbol')?.value || '';
      newSettings.exchange = panel.querySelector('#oa-quick-exchange')?.value || 'NSE';
      newSettings.product = panel.querySelector('#oa-quick-product')?.value || 'MIS';
      newSettings.quantity = panel.querySelector('#oa-quick-qty')?.value || '1';
    }
    await saveSettings(newSettings);
    showNotification('Settings saved!', 'success');
    if (newSettings.uiMode !== settings.uiMode) location.reload();
    toggleSettingsPanel();
  });
}

// Draggable functionality
function makeDraggable(el) {
  let isDragging = false, offsetX, offsetY;
  el.style.position = 'fixed';
  el.style.zIndex = '10000';
  el.style.top = '100px';
  el.style.left = '20px';

  el.addEventListener('mousedown', (e) => {
    if (e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT' || e.target.tagName === 'BUTTON') return;
    isDragging = true;
    offsetX = e.clientX - el.getBoundingClientRect().left;
    offsetY = e.clientY - el.getBoundingClientRect().top;
    e.preventDefault();
  });

  document.addEventListener('mousemove', (e) => {
    if (isDragging) {
      el.style.left = (e.clientX - offsetX) + 'px';
      el.style.top = (e.clientY - offsetY) + 'px';
    }
  });

  document.addEventListener('mouseup', () => isDragging = false);
}

// Inject CSS styles
function injectStyles() {
  const style = document.createElement('style');
  style.textContent = `
    .oa-container { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; background: #1a1a2e; color: #eee; border-radius: 12px; box-shadow: 0 8px 32px rgba(0,0,0,0.4); padding: 12px; min-width: 420px; }
    .oa-drag-handle { height: 4px; background: #444; border-radius: 2px; margin: -8px -8px 8px; cursor: move; }
    .oa-header { display: flex; align-items: center; gap: 8px; margin-bottom: 10px; flex-wrap: wrap; }
    .oa-select { background: #2a2a4a; color: #fff; border: 1px solid #444; border-radius: 6px; padding: 6px 10px; font-weight: 600; }
    .oa-ltp-display { font-size: 14px; font-weight: 600; }
    .oa-funds { font-size: 12px; margin-left: auto; }
    .positive { color: #00e676 !important; }
    .negative { color: #ff5252 !important; }
    .oa-icon-btn { background: transparent; border: none; color: #888; font-size: 18px; cursor: pointer; padding: 4px 8px; }
    .oa-icon-btn:hover { color: #fff; }
    .oa-controls { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }
    .oa-toggle { background: #333; color: #fff; border: none; border-radius: 6px; padding: 8px 14px; font-weight: 700; cursor: pointer; text-transform: uppercase; }
    .oa-toggle.buy { background: #00c853; }
    .oa-toggle.sell { background: #ff1744; }
    .oa-strike-select { background: #2a2a4a; color: #fff; border: 1px solid #555; border-radius: 6px; padding: 8px 12px; cursor: pointer; min-width: 100px; }
    .oa-lots { display: flex; align-items: center; gap: 4px; }
    .oa-lot-btn { background: #333; color: #fff; border: none; border-radius: 4px; width: 28px; height: 28px; cursor: pointer; font-size: 16px; }
    .oa-lots input { width: 40px; background: #2a2a4a; color: #fff; border: 1px solid #444; border-radius: 4px; text-align: center; padding: 4px; }
    .oa-lots-label { font-size: 11px; color: #888; }
    .oa-price-input { width: 70px; background: #2a2a4a; color: #fff; border: 1px solid #444; border-radius: 6px; padding: 8px; text-align: right; }
    .oa-price-input:disabled { opacity: 0.6; }
    .oa-order-btn { padding: 10px 16px; border: none; border-radius: 8px; font-weight: 700; cursor: pointer; text-transform: uppercase; }
    .oa-order-btn.buy { background: linear-gradient(135deg, #00c853, #00e676); color: #000; }
    .oa-order-btn.sell { background: linear-gradient(135deg, #ff1744, #ff5252); color: #fff; }
    .oa-strike-dropdown { position: absolute; top: 100%; left: 0; right: 0; background: #1a1a2e; border: 1px solid #333; border-radius: 8px; margin-top: 4px; max-height: 300px; overflow: auto; z-index: 100; }
    .oa-strike-dropdown.hidden { display: none; }
    .oa-expiry-slider { display: flex; gap: 6px; padding: 8px; overflow-x: auto; border-bottom: 1px solid #333; }
    .oa-expiry-btn { background: #2a2a4a; color: #aaa; border: none; border-radius: 4px; padding: 6px 10px; font-size: 11px; cursor: pointer; white-space: nowrap; }
    .oa-expiry-btn.active { background: #4a4a8a; color: #fff; }
    .oa-strike-header { display: grid; grid-template-columns: 1fr 1fr 1.5fr; padding: 6px 10px; font-size: 10px; color: #666; border-bottom: 1px solid #333; }
    .oa-strike-list { max-height: 200px; overflow-y: auto; }
    .oa-strike-row { display: grid; grid-template-columns: 1fr 1fr 1.5fr; padding: 8px 10px; cursor: pointer; font-size: 12px; }
    .oa-strike-row:hover { background: #2a2a4a; }
    .oa-strike-row.selected { background: #3a3a6a; }
    .oa-strike-row.atm { background: #2a3a4a; font-weight: 600; }
    .oa-moneyness { color: #888; }
    .oa-strike { color: #fff; }
    .oa-ltp { text-align: right; }
    .oa-settings-panel { position: absolute; top: 100%; left: 0; right: 0; background: #1a1a2e; border: 1px solid #333; border-radius: 8px; margin-top: 4px; z-index: 101; }
    .oa-settings-panel.hidden { display: none; }
    .oa-settings-content { padding: 12px; }
    .oa-settings-content h3 { margin: 0 0 12px; font-size: 14px; }
    .oa-settings-content h4 { margin: 12px 0 8px; font-size: 12px; color: #888; }
    .oa-form-group { margin-bottom: 10px; }
    .oa-form-group label { display: block; font-size: 11px; color: #888; margin-bottom: 4px; }
    .oa-form-group input, .oa-form-group select { width: 100%; background: #2a2a4a; color: #fff; border: 1px solid #444; border-radius: 4px; padding: 8px; box-sizing: border-box; }
    .oa-symbol-list { max-height: 100px; overflow-y: auto; margin-bottom: 8px; }
    .oa-symbol-item { display: flex; justify-content: space-between; align-items: center; padding: 6px 8px; background: #2a2a4a; border-radius: 4px; margin-bottom: 4px; font-size: 12px; }
    .oa-remove-symbol { background: transparent; border: none; color: #ff5252; cursor: pointer; font-size: 14px; }
    .oa-add-symbol { display: flex; gap: 4px; flex-wrap: wrap; }
    .oa-add-symbol input, .oa-add-symbol select { flex: 1; min-width: 60px; background: #2a2a4a; color: #fff; border: 1px solid #444; border-radius: 4px; padding: 6px; font-size: 11px; }
    .oa-btn { padding: 8px 14px; border: none; border-radius: 6px; font-weight: 600; cursor: pointer; text-transform: uppercase; font-size: 12px; }
    .oa-btn.primary { background: #5c6bc0; color: #fff; }
    .oa-btn.success { background: #00c853; color: #fff; }
    .oa-btn.warning { background: #ffc107; color: #000; }
    .oa-btn.error { background: #ff5252; color: #fff; }
    .oa-btn.info { background: #29b6f6; color: #fff; }
    .oa-quick-row { display: flex; gap: 6px; align-items: center; }
    .openalgo-notification { position: fixed; bottom: 20px; right: 20px; padding: 12px 20px; border-radius: 8px; font-weight: 600; z-index: 10001; animation: slideIn 0.3s ease; }
    .openalgo-notification.success { background: #00c853; color: #fff; }
    .openalgo-notification.error { background: #ff5252; color: #fff; }
    .openalgo-notification.fadeOut { opacity: 0; transition: opacity 0.5s; }
    @keyframes slideIn { from { transform: translateX(100px); opacity: 0; } to { transform: translateX(0); opacity: 1; } }
  `;
  document.head.appendChild(style);
}

// Listen for messages
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.action === 'injectButtons') {
    init();
    sendResponse({ success: true });
  }
  return true;
});
