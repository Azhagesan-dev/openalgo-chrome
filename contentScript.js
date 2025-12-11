// OpenAlgo Options Scalping Extension v2.3
// Global state
let state = {
  action: 'BUY',
  optionType: 'CE',
  selectedExpiry: '',
  selectedOffset: 'ATM',
  selectedStrike: 0,
  selectedSymbol: '', // Full option symbol for API calls
  strikeMode: 'moneyness', // 'moneyness' or 'strike'
  extendLevel: 5, // Current ITM/OTM level (5 = ITM5/OTM5)
  useMoneyness: true,
  lots: 0, // Start with 0 until lot size is known
  orderType: 'MARKET',
  price: 0,
  lotSize: 0, // Start with 0 until determined
  underlyingLtp: 0,
  underlyingPrevClose: 0,
  optionLtp: 0,
  optionPrevClose: 0,
  margin: 0, // Required margin for current order
  theme: 'dark',
  refreshMode: 'auto',
  refreshIntervalSec: 5,
  rateLimit: 100, // Delay between API calls in ms
  refreshAreas: { funds: true, underlying: true, selectedStrike: true },
  loading: { funds: false, underlying: false, strikes: false, margin: false },
  quantityAutoCorrected: false, // Flag to track if quantity was auto-corrected
  netposAutoCorrected: false, // Flag to track if netpos quantity was auto-corrected
  fetchOpenPosAfterMargin: false,
  currentNetQty: 0 // actual net position quantity (in qty units)
};

let isInitialized = false;

let expiryList = [];
let strikeChain = [];
let settings = {};
let refreshInterval = null;

// Initialize on load
document.addEventListener('DOMContentLoaded', init);
if (document.readyState === 'interactive' || document.readyState === 'complete') init();

async function init() {
  // Prevent multiple initializations
  if (isInitialized || document.getElementById('openalgo-controls')) return;

  isInitialized = true;
  settings = await loadSettings();
  injectStyles();
  injectUI();
  applyTheme(state.theme);
  updateModeIndicator(); // Update mode indicator on init
  if (settings.uiMode === 'scalping' && settings.symbols?.length > 0 && settings.apiKey && settings.hostUrl) {
    state.fetchOpenPosAfterMargin = true; // Enable netposition fetch after first margin call during init
    fetchExpiry(); // Fetch expiry on initial load
    startDataRefresh();
  }
}

// Load settings from chrome storage
function loadSettings() {
  return new Promise((resolve) => {
    chrome.storage.sync.get(['hostUrl', 'apiKey', 'symbols', 'activeSymbolId', 'uiMode', 'symbol', 'exchange', 'product', 'quantity', 'theme', 'refreshMode', 'refreshIntervalSec', 'refreshAreas', 'strikeMode', 'rateLimit'], (data) => {
      state.theme = data.theme || 'dark';
      state.refreshMode = data.refreshMode || 'auto';
      state.refreshIntervalSec = data.refreshIntervalSec || 5;
      state.rateLimit = data.rateLimit || 100;
      state.refreshAreas = data.refreshAreas || { funds: true, underlying: true, selectedStrike: true };
      state.strikeMode = data.strikeMode || 'moneyness';
      state.useMoneyness = state.strikeMode === 'moneyness';

      // Default symbols if none exist
      let symbols = data.symbols || [];
      if (symbols.length === 0) {
        symbols = [{
          id: 'default-nifty',
          symbol: 'NIFTY',
          exchange: 'NSE_INDEX',
          optionExchange: 'NFO',
          productType: 'MIS',
          quantityMode: 'lots' // 'lots' or 'quantity'
        }];
      }

      resolve({
        hostUrl: data.hostUrl || 'http://127.0.0.1:5000',
        apiKey: data.apiKey || '',
        symbols: symbols,
        activeSymbolId: data.activeSymbolId || symbols[0]?.id || '',
        uiMode: data.uiMode || 'scalping',
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

// Quantity helpers
function getQuantityMode() {
  const symbol = getActiveSymbol();
  return symbol?.quantityMode || 'lots';
}

function toLots(quantity) {
  if (!state.lotSize) return 0;
  if (!quantity) return 0;
  const sign = quantity >= 0 ? 1 : -1;
  const lots = Math.floor(Math.abs(quantity) / state.lotSize);
  return sign * lots;
}

function toQuantity(displayValue) {
  const normalized = Math.max(1, parseInt(displayValue, 10) || 1);
  if (getQuantityMode() === 'lots') {
    return state.lotSize ? normalized * state.lotSize : normalized;
  }
  return normalized;
}

function getDisplayQuantity(quantity = state.lots) {
  if (!quantity) return 0;
  return getQuantityMode() === 'lots'
    ? toLots(quantity)
    : quantity;
}

function getApiQuantity() {
  return Math.max(1, state.lots || 1);
}

function syncQuantityInput() {
  const lotsInput = document.getElementById('oa-lots');
  if (!lotsInput) return;
  // Keep loading state until lot size and a valid quantity are known
  if (!state.lotSize || !state.lots) return;
  const displayValue = getDisplayQuantity();
  lotsInput.value = displayValue ? displayValue.toString() : '0';
  lotsInput.classList.remove('loading');
    if (document.body.classList.contains('oa-light-theme')) {
      lotsInput.style.background = '#f0f0f0';
      lotsInput.style.color = '#222';
    }
}

function setQuantityFromDisplay(displayValue) {
  state.lots = toQuantity(displayValue);
  syncQuantityInput();
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

// Rate limiter - queue-based to handle concurrent requests properly
let apiCallQueue = [];
let isProcessingQueue = false;

async function rateLimitedApiCall(endpoint, data) {
  return new Promise((resolve, reject) => {
    apiCallQueue.push({ endpoint, data, resolve, reject });
    processApiQueue();
  });
}

async function processApiQueue() {
  if (isProcessingQueue || apiCallQueue.length === 0) return;

  isProcessingQueue = true;

  while (apiCallQueue.length > 0) {
    const { endpoint, data, resolve, reject } = apiCallQueue.shift();

    try {
      const result = await apiCall(endpoint, data);
      resolve(result);

      // Wait for rate limit delay before processing next call
      if (apiCallQueue.length > 0) {
        await new Promise(r => setTimeout(r, state.rateLimit));
      }
    } catch (error) {
      reject(error);
    }
  }

  isProcessingQueue = false;
}

// Fetch margin for current order
async function fetchMargin() {
  const symbol = getActiveSymbol();
  if (!symbol || !state.selectedSymbol) return;

  // Don't fetch margin if quantity is invalid in quantity mode
  if (symbol.quantityMode === 'quantity' && getApiQuantity() % state.lotSize !== 0) {
    state.margin = 0;
    updateOrderButton();
    return;
  }

  const price = state.orderType === 'MARKET' ? state.optionLtp : state.price;
  if (!price) return;

  const quantity = getApiQuantity();

  state.loading.margin = true;
  const result = await rateLimitedApiCall('/api/v1/margin', {
    positions: [{
      symbol: state.selectedSymbol,
      exchange: symbol.optionExchange,
      action: state.action,
      product: symbol.product || 'MIS',
      pricetype: state.orderType === 'SL-M' ? 'SL-M' : (state.orderType === 'SL' ? 'SL' : (state.orderType === 'LIMIT' ? 'LIMIT' : 'MARKET')),
      quantity: String(quantity),
      price: String(price)
    }]
  });

  if (result.status === 'success' && result.data) {
    state.margin = result.data.total_margin_required || 0;
    updateOrderButton();
  }
  state.loading.margin = false;
  if (state.fetchOpenPosAfterMargin) {
    state.fetchOpenPosAfterMargin = false;
    fetchOpenPosition();
  }
}

// Fetch quotes for underlying
async function fetchUnderlyingQuote() {
  const symbol = getActiveSymbol();
  if (!symbol) return;
  state.loading.underlying = true;
  showLoadingIndicator('underlying');
  const result = await rateLimitedApiCall('/api/v1/quotes', { symbol: symbol.symbol, exchange: symbol.exchange });
  state.loading.underlying = false;
  hideLoadingIndicator('underlying');
  if (result.status === 'success' && result.data) {
    state.underlyingLtp = result.data.ltp || 0;
    state.underlyingPrevClose = result.data.prev_close || 0;
    updateUnderlyingDisplay();
  }
}

// Fetch funds
async function fetchFunds() {
  state.loading.funds = true;
  showLoadingIndicator('funds');
  const result = await rateLimitedApiCall('/api/v1/funds', {});
  state.loading.funds = false;
  hideLoadingIndicator('funds');
  if (result.status === 'success' && result.data) {
    const available = parseFloat(result.data.availablecash) || 0;
    const realized = parseFloat(result.data.m2mrealized) || 0;
    const unrealized = parseFloat(result.data.m2munrealized) || 0;
    const todayPL = realized + unrealized;
    updateFundsDisplay(available, todayPL);
  }
}

// Fetch open position for current symbol
async function fetchOpenPosition() {
  const symbol = getActiveSymbol();
  if (!symbol || !state.selectedSymbol) return;

  const result = await rateLimitedApiCall('/api/v1/openposition', {
    strategy: 'Chrome',
    symbol: state.selectedSymbol,
    exchange: symbol.optionExchange,
    product: symbol.productType
  });

  if (result.status === 'success') {
    const quantity = parseInt(result.quantity) || 0;
    updateNetPosDisplay(quantity);
  }
}

// Fetch expiry list
async function fetchExpiry() {
  // Don't fetch if API credentials are not configured
  if (!settings.apiKey || !settings.hostUrl) return;

  const symbol = getActiveSymbol();
  if (!symbol) return;
  const result = await rateLimitedApiCall('/api/v1/expiry', {
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
    // Auto-fetch strike chain after expiry is loaded
    if (state.selectedExpiry) {
      await fetchStrikeChain();
      // Remove redundant refreshSelectedStrike() - fetchStrikeChain -> updateSelectedOptionLTP -> updatePriceDisplay -> fetchMargin handles it
    }
  }
}

// Fetch strike chain using optionsymbol API
let isFetchingStrikeChain = false;
let isExtendingStrikes = false;

async function fetchStrikeChain() {
  // Prevent concurrent executions
  if (isFetchingStrikeChain) return;
  isFetchingStrikeChain = true;

  const symbol = getActiveSymbol();
  if (!symbol || !state.selectedExpiry) {
    isFetchingStrikeChain = false;
    return;
  }

  // Build offsets dynamically based on current extend level
  const offsets = [];
  for (let i = state.extendLevel; i >= 1; i--) {
    offsets.push(`ITM${i}`);
  }
  offsets.push('ATM');
  for (let i = 1; i <= state.extendLevel; i++) {
    offsets.push(`OTM${i}`);
  }

  state.loading.strikes = true;
  showLoadingIndicator('strikes');

  try {
    // Make API calls sequentially to respect rate limits
    const results = [];
    for (const offset of offsets) {
      const result = await rateLimitedApiCall('/api/v1/optionsymbol', {
        strategy: 'Chrome',
        underlying: symbol.symbol,
        exchange: symbol.exchange,
        expiry_date: state.selectedExpiry,
        offset: offset,
        option_type: state.optionType
      });
      results.push(result);
    }
  strikeChain = offsets.map((offset, i) => {
    const r = results[i];
    if (r.status === 'success') {
      // Parse strike from option symbol format: [BaseSymbol][DDMMMYY][Strike][CE/PE]
      const strikeMatch = r.symbol.match(/^[A-Z]+(?:\d{2}[A-Z]{3}\d{2})(\d+)(?=CE$|PE$)/);
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
  if (atmStrike) {
    state.lotSize = atmStrike.lotsize;
    // Initialize quantity input now that we know the lot size
    initializeQuantityInput();
  }

  // Fetch LTPs for all strikes
  await fetchStrikeLTPs();
  } finally {
    isFetchingStrikeChain = false;
  }
}

// Fetch LTPs for strike chain
async function fetchStrikeLTPs() {
  if (strikeChain.length === 0) return;
  const symbols = strikeChain.map(s => ({ symbol: s.symbol, exchange: s.exchange }));
  const result = await rateLimitedApiCall('/api/v1/multiquotes', { symbols });

  if (result.status === 'success' && result.results) {
    result.results.forEach(r => {
      const strike = strikeChain.find(s => s.symbol === r.symbol);
      if (strike && r.data) {
        strike.ltp = r.data.ltp || 0;
        strike.prevClose = r.data.prev_close || 0;
      }
    });
  }
  state.loading.strikes = false;
  hideLoadingIndicator('strikes');
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
    // Prepare symbol for margin call which happens in updatePriceDisplay
    state.selectedSymbol = selected.symbol;
    updatePriceDisplay();
    updateStrikeButton();
  }
}

// Place order using optionsorder API (moneyness-based)
async function placeOptionsOrder() {
  const symbol = getActiveSymbol();
  if (!symbol) return showNotification('No symbol selected', 'error');

  // Check if quantity was auto-corrected and not manually verified
  if (state.quantityAutoCorrected) {
    showNotification('Invalid qty - Adjusted to nearest valid lot. Please confirm and place again.', 'error', 5000);
    state.quantityAutoCorrected = false;
    return;
  }

  // Check quantity validation in quantity mode
  if (symbol.quantityMode === 'quantity' && state.lots % state.lotSize !== 0) {
    return showNotification(`Quantity must be multiple of ${state.lotSize} (lot size)`, 'error');
  }

  const quantity = getApiQuantity();

  const data = {
    strategy: 'Chrome',
    underlying: symbol.symbol,
    exchange: symbol.exchange,
    expiry_date: state.selectedExpiry,
    offset: state.selectedOffset,
    option_type: state.optionType,
    action: state.action,
    quantity: String(quantity),
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

  // Check if quantity was auto-corrected and not manually verified
  if (state.quantityAutoCorrected) {
    showNotification('Invalid qty - Adjusted to nearest valid lot. Please confirm and place again.', 'error', 5000);
    state.quantityAutoCorrected = false;
    return;
  }

  // Check quantity validation in quantity mode
  if (symbol.quantityMode === 'quantity' && state.lots % state.lotSize !== 0) {
    return showNotification(`Quantity must be multiple of ${state.lotSize} (lot size)`, 'error');
  }

  const quantity = getApiQuantity();

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
    // Refresh net position after successful order
    setTimeout(() => fetchOpenPosition(), 1000); // Small delay to allow position to update
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

// Start data refresh interval (expiry only on init, not in interval)
function startDataRefresh() {
  // Don't start data refresh if API credentials are not configured
  if (!settings.apiKey || !settings.hostUrl) return;

  if (state.refreshAreas.underlying) fetchUnderlyingQuote();
  if (state.refreshAreas.funds) fetchFunds();
  // Don't fetch expiry here - only on symbol change and initial load
  if (refreshInterval) clearInterval(refreshInterval);
  if (state.refreshMode === 'auto') {
    refreshInterval = setInterval(() => {
      if (state.refreshAreas.underlying) fetchUnderlyingQuote();
      if (state.refreshAreas.funds) fetchFunds();
      if (state.refreshAreas.selectedStrike) refreshSelectedStrike();
    }, state.refreshIntervalSec * 1000);
  }
}

// Manual refresh
function manualRefresh() {
  if (state.refreshAreas.underlying) fetchUnderlyingQuote();
  if (state.refreshAreas.funds) fetchFunds();
  if (state.refreshAreas.selectedStrike) refreshSelectedStrike();
}

// Refresh only the selected strike's LTP and update price if MARKET
// In moneyness mode: first get latest strike from optionsymbol API, then quotes
async function refreshSelectedStrike() {
  const symbol = getActiveSymbol();
  if (!symbol) return;

  state.loading.strikes = true;
  showLoadingIndicator('strikes');

  // In moneyness mode, get latest strike from optionsymbol API first
  if (state.strikeMode === 'moneyness' && state.selectedExpiry) {
    const symbolResult = await rateLimitedApiCall('/api/v1/optionsymbol', {
      strategy: 'Chrome',
      underlying: symbol.symbol,
      exchange: symbol.exchange,
      expiry_date: state.selectedExpiry,
      offset: state.selectedOffset,
      option_type: state.optionType
    });

    if (symbolResult.status === 'success') {
      const strikeMatch = symbolResult.symbol.match(/^[A-Z]+(?:\d{2}[A-Z]{3}\d{2})(\d+)(?=CE$|PE$)/);
      state.selectedStrike = strikeMatch ? parseInt(strikeMatch[1]) : 0;
      state.selectedSymbol = symbolResult.symbol;
      state.lotSize = symbolResult.lotsize || state.lotSize;

      // Update strike in chain
      const chainItem = strikeChain.find(s => s.offset === state.selectedOffset);
      if (chainItem) {
        chainItem.symbol = symbolResult.symbol;
        chainItem.strike = state.selectedStrike;
      }
    }
  }

  // Now fetch quote for the selected strike
  const selected = strikeChain.find(s => s.offset === state.selectedOffset);
  if (selected) {
    const result = await rateLimitedApiCall('/api/v1/quotes', { symbol: selected.symbol, exchange: selected.exchange });
    if (result.status === 'success' && result.data) {
      selected.ltp = result.data.ltp || 0;
      selected.prevClose = result.data.prev_close || 0;
      state.optionLtp = selected.ltp;
      state.optionPrevClose = selected.prevClose;
      // Ensure available for margin call
      state.selectedSymbol = selected.symbol;

      // Update price display unconditionally (updates UI and fetches margin)
      updatePriceDisplay();
      updateStrikeDropdown();
      updateStrikeButton();
    }
  }

  state.loading.strikes = false;
  hideLoadingIndicator('strikes');
}

// Show notification
function showNotification(message, type, duration = 1000) {
  const n = document.createElement('div');
  n.className = `openalgo-notification ${type}`;
  n.textContent = message;
  document.body.appendChild(n);
  setTimeout(() => { n.classList.add('fadeOut'); setTimeout(() => n.remove(), 500); }, duration);
}

// UI update functions
function updateUnderlyingDisplay() {
  const el = document.getElementById('oa-underlying-ltp');
  if (!el) return;
  const { change, changePercent, sign, colorClass } = getChangeDisplay(state.underlyingLtp, state.underlyingPrevClose);
  el.innerHTML = `<span class="oa-ltp-value ${colorClass}">${formatNumber(state.underlyingLtp)}</span> <span class="oa-change-text">${sign}${formatNumber(change)} (${sign}${changePercent.toFixed(2)}%)</span>`;
}

function updateFundsDisplay(available, todayPL) {
  const el = document.getElementById('oa-funds');
  if (!el) return;
  const plClass = todayPL >= 0 ? 'positive' : 'negative';
  const plSign = todayPL >= 0 ? '+' : '';
  el.innerHTML = `Avail: ₹${formatNumber(available, 0)} | <span class="${plClass}">P/L: ${plSign}₹${formatNumber(todayPL, 0)}</span>`;
}

function updateNetPosDisplay(quantity) {
  const el = document.getElementById('oa-netpos');
  const symbol = getActiveSymbol();
  if (el && symbol) {
    state.currentNetQty = quantity;
    const displayValue = symbol.quantityMode === 'quantity'
      ? quantity
      : toLots(quantity);
    el.dataset.qty = quantity.toString();
    el.value = displayValue.toString();
    updateResizeButton();
  }
}

function updateNetPosDisplayMode() {
  const el = document.getElementById('oa-netpos');
  const symbol = getActiveSymbol();
  if (el && symbol) {
    const baseQty = parseInt(el.dataset.qty || el.value) || 0;
    const displayValue = symbol.quantityMode === 'quantity'
      ? baseQty
      : toLots(baseQty);
    el.value = displayValue.toString();
    updateResizeButton();
  }
}

function updateModeIndicator() {
  const el = document.getElementById('oa-mode-indicator');
  const symbol = getActiveSymbol();
  if (el && symbol) {
    el.textContent = symbol.quantityMode === 'quantity' ? 'QTY' : 'LOTS';
    el.title = 'Click to toggle between QTY and LOTS mode';
    el.style.background = symbol.quantityMode === 'quantity' ? 'rgba(0, 230, 118, 0.1)' : 'rgba(92, 107, 192, 0.1)';
    el.style.color = symbol.quantityMode === 'quantity' ? '#00e676' : '#5c6bc0';
  }
  // Refresh quantity/net position display for the active mode
  syncQuantityInput();
  updateNetPosDisplayMode();
  // Re-validate quantity when mode changes
  validateQuantity();
  updateResizeButton();
}

function getTargetNetQty() {
  const el = document.getElementById('oa-netpos');
  const symbol = getActiveSymbol();
  if (!el || !symbol) return 0;
  // dataset.qty stores base quantity (qty units)
  const datasetQty = parseInt(el.dataset.qty || '0', 10);
  if (datasetQty) return datasetQty;
  const displayValue = parseInt(el.value || '0', 10) || 0;
  if (symbol.quantityMode === 'quantity') return displayValue;
  return displayValue * (state.lotSize || 1);
}

function updateResizeButton() {
  const btn = document.getElementById('oa-resize-btn');
  const symbol = getActiveSymbol();
  if (!btn || !symbol) return;

  const target = getTargetNetQty();
  const qtyModeIsQty = getQuantityMode() === 'quantity';
  const displayQty = Math.abs(qtyModeIsQty ? target : toLots(target));

  btn.className = 'oa-resize-btn';
  btn.textContent = `Resize ${displayQty}`;
  const modeText = qtyModeIsQty ? 'qty' : 'lots';
  btn.title = `Resize position to ${displayQty} ${modeText}`;
}

async function placeResize() {
  const symbol = getActiveSymbol();
  if (!symbol || !state.selectedSymbol) return showNotification('No symbol selected', 'error');

  // Check if netpos quantity was auto-corrected and not manually verified
  if (state.netposAutoCorrected) {
    showNotification('Invalid qty - Adjusted to nearest valid lot. Please confirm and resize again.', 'error', 5000);
    state.netposAutoCorrected = false;
    return;
  }

  const targetQty = Math.max(0, getTargetNetQty()); // qty units for API

  const data = {
    strategy: 'Chrome',
    symbol: state.selectedSymbol,
    exchange: symbol.optionExchange,
    action: state.action,
    product: symbol.productType,
    pricetype: 'MARKET',
    quantity: String(targetQty),
    position_size: String(targetQty),
    price: '0',
    trigger_price: '0'
  };

  const result = await apiCall('/api/v1/placesmartorder', data);
  if (result.status === 'success') {
    showNotification('Resize placed', 'success');
    fetchOpenPosition();
  } else {
    showNotification(`Resize failed: ${result.message}`, 'error');
  }
}

async function toggleQuantityModeUI() {
  const symbol = getActiveSymbol();
  if (!symbol) return;
  symbol.quantityMode = symbol.quantityMode === 'quantity' ? 'lots' : 'quantity';
  await saveSettings({ symbols: settings.symbols });
  updateModeIndicator();
  validateQuantity();
  fetchOpenPosition();
  showNotification(`Mode: ${symbol.quantityMode.toUpperCase()}`, 'success');
}

function initializeQuantityInput() {
  const lotsInput = document.getElementById('oa-lots');
  const lotsDecBtn = document.getElementById('oa-lots-dec');
  const lotsIncBtn = document.getElementById('oa-lots-inc');
  const lotsUpdateBtn = document.getElementById('oa-lots-update');

  if (lotsInput && state.lotSize > 0) {
    // Set initial quantity to 1 * lot size
    state.lots = state.lotSize;
    lotsInput.disabled = false;
    lotsInput.readOnly = true; // Keep readonly like netpos
    lotsInput.classList.remove('loading');
    syncQuantityInput();

    // Reset auto-corrected flag since this is proper initialization
    state.quantityAutoCorrected = false;

    // Enable buttons
    if (lotsDecBtn) lotsDecBtn.disabled = false;
    if (lotsIncBtn) lotsIncBtn.disabled = false;
    if (lotsUpdateBtn) lotsUpdateBtn.disabled = false;

    // Trigger validation and margin calculation
    const validationPassed = validateQuantity();
    if (validationPassed) {
      fetchMargin();
    }
    updateResizeButton();
  }
}

function validateQuantity() {
  const lotsInput = document.getElementById('oa-lots');
  const symbol = getActiveSymbol();

  if (!lotsInput || !symbol) return true; // Return true if we can't validate
  if (!state.lotSize) return true;

  // Don't validate if input is still in loading state
  if (lotsInput.classList.contains('oa-loading')) return true;

  let validationPassed = true;

  if (symbol.quantityMode === 'quantity') {
    // In quantity mode, check if the entered quantity is multiple of lot size
    const quantity = state.lots;
    if (quantity % state.lotSize !== 0) {
      // Auto-reset to nearest valid multiple of lot size
      const remainder = quantity % state.lotSize;
      const lowerMultiple = quantity - remainder;
      const upperMultiple = lowerMultiple + state.lotSize;

      // Choose the nearest valid quantity
      const validQuantity = (remainder <= state.lotSize / 2) ? lowerMultiple : upperMultiple;

      // Ensure we don't go below lot size
      const finalValidQuantity = Math.max(state.lotSize, validQuantity);

      state.lots = finalValidQuantity;
      syncQuantityInput();
      state.quantityAutoCorrected = true;
      validationPassed = false;

      // Show notification with longer duration
      showNotification(`Warning invalid qty - Quantity reset to ${finalValidQuantity} (nearest valid multiple).`, 'error', 5000);
    }
  }
  // Keep display in sync for lots mode
  if (symbol.quantityMode === 'lots') {
    syncQuantityInput();
  }
  // In lots mode, always valid since lots * lotSize is always valid
  return validationPassed;
}

function validateNetposQuantity() {
  const netposEl = document.getElementById('oa-netpos');
  const symbol = getActiveSymbol();

  if (!netposEl || !symbol) return true; // Return true if we can't validate
  if (!state.lotSize) return true;

  // Don't validate if input is still in loading state
  if (netposEl.classList.contains('oa-loading')) return true;

  let wasAutoCorrected = false;

  if (symbol.quantityMode === 'quantity') {
    // In quantity mode, check if the entered quantity is multiple of lot size
    const displayValue = parseInt(netposEl.value || '0', 10) || 0;
    const quantity = symbol.quantityMode === 'lots' ? displayValue * state.lotSize : displayValue;

    if (quantity % state.lotSize !== 0) {
      // Auto-reset to nearest valid multiple of lot size
      const remainder = quantity % state.lotSize;
      const lowerMultiple = quantity - remainder;
      const upperMultiple = lowerMultiple + state.lotSize;

      // Choose the nearest valid quantity
      const validQuantity = (remainder <= state.lotSize / 2) ? lowerMultiple : upperMultiple;

      // Ensure we don't go below lot size
      const finalValidQuantity = Math.max(state.lotSize, validQuantity);

      // Update the input value and dataset
      const displayQty = symbol.quantityMode === 'lots' ? Math.floor(finalValidQuantity / state.lotSize) : finalValidQuantity;
      netposEl.value = displayQty.toString();
      netposEl.dataset.qty = finalValidQuantity.toString();

      // Set auto-corrected flag to prevent automatic resize
      state.netposAutoCorrected = true;
      wasAutoCorrected = true;

      // Show notification with longer duration
      showNotification(`Warning invalid qty - Quantity reset to ${finalValidQuantity} (nearest valid multiple).`, 'error', 5000);
    }
  }
  // Keep display in sync for lots mode
  if (symbol.quantityMode === 'lots') {
    const displayValue = parseInt(netposEl.value || '0', 10) || 0;
    const qty = displayValue * (state.lotSize || 1);
    netposEl.dataset.qty = qty.toString();
  }

  // Reset auto-corrected flag only if no correction was made
  if (!wasAutoCorrected) {
    state.netposAutoCorrected = false;
  }

  return !wasAutoCorrected; // Return true if no correction was made
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

      // Show loading on multiple elements
      const strikeBtn = document.getElementById('oa-strike-btn');
      const priceInput = document.getElementById('oa-price');
      const orderBtn = document.getElementById('oa-order-btn');
      const strikeCol = document.getElementById('oa-strike-col');
      const ltpCol = document.getElementById('oa-ltp-col');

      strikeBtn?.classList.add('oa-loading');
      priceInput?.classList.add('oa-loading');
      orderBtn?.classList.add('oa-loading');
      strikeCol?.classList.add('oa-loading');

      await fetchStrikeChain();

      // Now loading on LTP column while quotes fetch
      strikeCol?.classList.remove('oa-loading');
      ltpCol?.classList.add('oa-loading');

      await fetchStrikeLTPs();

      // Remove all loading
      strikeBtn?.classList.remove('oa-loading');
      priceInput?.classList.remove('oa-loading');
      orderBtn?.classList.remove('oa-loading');
      ltpCol?.classList.remove('oa-loading');
    });
  });
}

function updateStrikeDropdown() {
  const list = document.getElementById('oa-strike-list');
  if (!list) return;
  const optType = state.optionType;
  const isStrikeMode = state.strikeMode === 'strike';

  list.innerHTML = strikeChain.map(s => {
    const { colorClass } = getChangeDisplay(s.ltp, s.prevClose);
    const isATM = s.offset === 'ATM';
    const isSelected = s.offset === state.selectedOffset;

    // In moneyness mode: highlight offset, strike non-editable
    // In strike mode: offset dim, strike editable
    const offsetClass = isStrikeMode ? 'oa-moneyness dim' : 'oa-moneyness';
    const strikeClass = isStrikeMode ? 'oa-strike editable' : 'oa-strike';

    return `<div class="oa-strike-row ${isATM ? 'atm' : ''} ${isSelected ? 'selected' : ''}" data-offset="${s.offset}" data-strike="${s.strike}" data-symbol="${s.symbol}">
      <span class="${offsetClass}">${s.offset}</span>
      <span class="${strikeClass}">${s.strike} <span class="oa-opt-badge ${optType === 'CE' ? 'ce' : 'pe'}">${optType}</span></span>
      <span class="oa-ltp ${colorClass}">${formatNumber(s.ltp)}</span>
    </div>`;
  }).join('');

  list.querySelectorAll('.oa-strike-row').forEach(row => {
    row.addEventListener('click', () => {
      state.selectedOffset = row.dataset.offset;
      state.selectedStrike = parseInt(row.dataset.strike);
      state.selectedSymbol = row.dataset.symbol; // Save full symbol for API calls
      updateSelectedOptionLTP();
      updateStrikeButton();
      toggleStrikeDropdown(false);
      // Immediately update dropdown HTML so it shows correct selection when opened again
      updateStrikeDropdown();
      // Fetch net position for the selected strike
      fetchOpenPosition();
    });
  });
}

function updateStrikeButton() {
  const btn = document.getElementById('oa-strike-btn');
  if (!btn) return;
  if (state.strikeMode === 'moneyness') {
    // Show only moneyness (ATM, ITM1, etc.) in moneyness mode
    btn.textContent = state.selectedOffset;
  } else {
    btn.textContent = `${state.selectedStrike} ${state.optionType}`;
  }
}

function updatePriceDisplay() {
  const el = document.getElementById('oa-price');
  if (!el) return;
  if (state.orderType === 'MARKET') {
    el.value = state.optionLtp.toFixed(2);
    el.disabled = true;
  } else {
    el.disabled = false;
    // Auto-update price to current strike LTP when strike is selected
    state.price = state.optionLtp;
    el.value = state.price.toFixed(2);
  }
  updateOrderButton();
  fetchMargin(); // Fetch margin when price changes
}

function updateOrderButton() {
  const btn = document.getElementById('oa-order-btn');
  if (!btn) return;
  const price = state.orderType === 'MARKET' ? state.optionLtp : state.price;
  const marginText = state.margin > 0 ? ` [₹${formatNumber(state.margin, 0)}]` : '';
  btn.textContent = `${state.action} @ ${formatNumber(price)}${marginText}`;
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
  container.className = settings.uiMode === 'scalping' ? 'oa-container oa-scalping' : 'oa-container oa-quick';

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
  const themeIcon = state.theme === 'dark' ? '☀️' : '🌙';
  const modeLabel = state.strikeMode === 'moneyness' ? 'M' : 'S';
  // Initial strike button text based on mode
  const strikeText = state.strikeMode === 'moneyness' ? 'Moneyness' : 'Strike';
  return `
    <div class="oa-drag-handle"></div>
    <div class="oa-header">
      <select id="oa-symbol-select" class="oa-select">
        ${settings.symbols.map(s => `<option value="${s.id}" ${s.id === settings.activeSymbolId ? 'selected' : ''}>${s.symbol}</option>`).join('')}
        ${settings.symbols.length === 0 ? '<option value="">Add symbol in settings</option>' : ''}
      </select>
      <span id="oa-underlying-ltp" class="oa-ltp-display">--</span>
      <span id="oa-mode-indicator" class="oa-mode-indicator">--</span>
      <span id="oa-funds" class="oa-funds">--</span>
      <button id="oa-theme-btn" class="oa-icon-btn" title="Toggle theme">${themeIcon}</button>
      <button id="oa-refresh-btn" class="oa-icon-btn" title="Refresh settings">🔄</button>
      <button id="oa-settings-btn" class="oa-icon-btn">⋮</button>
    </div>
    <div class="oa-controls">
      <button id="oa-action-btn" class="oa-toggle buy">B</button>
      <button id="oa-option-type-btn" class="oa-toggle">CE</button>
      <button id="oa-strike-btn" class="oa-strike-select">${strikeText}</button>
      <div class="oa-lots">
        <button id="oa-lots-dec" class="oa-lot-btn" disabled>−</button>
        <div class="oa-input-wrapper">
          <input id="oa-lots" type="text" value="0" readonly>
          <button id="oa-lots-update" class="oa-input-update" title="Update" disabled>↻</button>
        </div>
        <button id="oa-lots-inc" class="oa-lot-btn" disabled>+</button>
      </div>
      <button id="oa-ordertype-btn" class="oa-toggle oa-ordertype-fixed">${state.orderType}</button>
      <div class="oa-input-wrapper price-wrapper">
        <input id="oa-price" type="text" class="oa-price-input" value="0">
        <button id="oa-price-update" class="oa-input-update" title="Update">↻</button>
      </div>
      <button id="oa-order-btn" class="oa-order-btn buy">BUY @ --</button>
      <div class="oa-netpos-input-wrapper">
        <input id="oa-netpos" type="text" class="oa-netpos-input" value="0" readonly>
        <span class="oa-netpos-label" title="Net Position">P</span>
        <button id="oa-netpos-update" class="oa-input-update" title="Refresh Net Position">↻</button>
      </div>
      <button id="oa-resize-btn" class="oa-resize-btn neutral" title="Resize position">Resize</button>
    </div>
    <div id="oa-strike-dropdown" class="oa-strike-dropdown hidden">
      <div class="oa-expiry-container">
        <button id="oa-expiry-left" class="oa-expiry-arrow">‹</button>
        <div id="oa-expiry-slider" class="oa-expiry-slider"></div>
        <button id="oa-expiry-right" class="oa-expiry-arrow">›</button>
      </div>
      <div class="oa-strike-header"><span>Moneyness</span><span id="oa-strike-col">Strike</span><span id="oa-ltp-col">LTP</span></div>
      <div id="oa-strike-list" class="oa-strike-list"></div>
      <div class="oa-strike-actions">
        <button id="oa-update-strikes" class="oa-action-btn" title="Update strikes & quotes">⟳ Update</button>
        <button id="oa-mode-toggle" class="oa-action-btn" title="Toggle Moneyness/Strike mode">${modeLabel}</button>
        <button id="oa-extend-strikes" class="oa-action-btn" title="Load more strikes">+ More</button>
      </div>
    </div>
    <div id="oa-refresh-panel" class="oa-refresh-panel hidden"></div>
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
  // Symbol select - only fetch expiry when symbol changes
  container.querySelector('#oa-symbol-select')?.addEventListener('change', async (e) => {
    await saveSettings({ activeSymbolId: e.target.value });
    strikeChain = [];
    state.selectedExpiry = '';
    state.selectedSymbol = ''; // Clear symbol to prevent stale margin calls
    state.extendLevel = 5;
    state.fetchOpenPosAfterMargin = true;
    updateModeIndicator(); // Update mode indicator for new symbol
    validateQuantity(); // Validate quantity for new symbol
    if (settings.apiKey && settings.hostUrl) {
      fetchExpiry(); // Only fetch expiry on symbol change
      startDataRefresh();
    }
  });

  // Quantity mode toggle (click on mode indicator)
  container.querySelector('#oa-mode-indicator')?.addEventListener('click', () => {
    toggleQuantityModeUI();
  });

  // Action toggle (B/S)
  container.querySelector('#oa-action-btn')?.addEventListener('click', (e) => {
    state.action = state.action === 'BUY' ? 'SELL' : 'BUY';
    e.target.textContent = state.action === 'BUY' ? 'B' : 'S';
    e.target.className = `oa-toggle ${state.action === 'BUY' ? 'buy' : 'sell'}`;
    updateOrderButton();
    fetchMargin();
  });

  // Option type toggle (CE/PE) - with loading animation and price update
  container.querySelector('#oa-option-type-btn')?.addEventListener('click', async (e) => {
    state.optionType = state.optionType === 'CE' ? 'PE' : 'CE';
    e.target.textContent = state.optionType;
    e.target.dataset.label = e.target.textContent;
    e.target.classList.add('oa-loading');
    await fetchStrikeChain();
    e.target.classList.remove('oa-loading');
    // Update price element with new strike LTP
    if (state.orderType === 'MARKET') {
      updatePriceDisplay();
    }
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
    const symbol = getActiveSymbol();
    const lotsInput = document.getElementById('oa-lots');

    // Don't process if controls are disabled or in loading state
    if (!symbol || !lotsInput || lotsInput.classList.contains('oa-loading')) return;

    const step = state.lotSize || 1;
    const minQuantity = state.lotSize || 1;

    if (state.lots > minQuantity) {
      state.lots = Math.max(minQuantity, state.lots - step);
      syncQuantityInput();
      state.quantityAutoCorrected = false; // Reset flag on manual change
      const validationPassed = validateQuantity();
      if (validationPassed) {
        fetchMargin();
      }
    }
  });
  container.querySelector('#oa-lots-inc')?.addEventListener('click', () => {
    const symbol = getActiveSymbol();
    const lotsInput = document.getElementById('oa-lots');

    // Don't process if controls are disabled or in loading state
    if (!symbol || !lotsInput || lotsInput.classList.contains('oa-loading')) return;

    const step = state.lotSize || 1;
      state.lots += step;
      syncQuantityInput();
      state.quantityAutoCorrected = false; // Reset flag on manual change
      const validationPassed = validateQuantity();
      if (validationPassed) {
        fetchMargin();
      }
      updateResizeButton();
  });
  // Qty input - handle click to enable editing (like netpos)
  container.querySelector('#oa-lots')?.addEventListener('click', (e) => {
    if (e.target.readOnly && !e.target.classList.contains('oa-loading')) {
      e.target.readOnly = false;
      e.target.classList.add('editable');
      e.target.select();
    }
  });

  // Qty input - handle blur (click outside)
  container.querySelector('#oa-lots')?.addEventListener('blur', (e) => {
    if (!e.target.readOnly) {
      e.target.readOnly = true;
      e.target.classList.remove('editable');
    }
  });

  container.querySelector('#oa-lots')?.addEventListener('change', (e) => {
    // Don't process changes if input is in loading state
    if (e.target.classList.contains('oa-loading')) return;

    const symbol = getActiveSymbol();
    const minDisplay = symbol ? (symbol.quantityMode === 'lots' ? 1 : (state.lotSize || 1)) : 1;
    const newValue = Math.max(minDisplay, parseInt(e.target.value) || minDisplay);
    setQuantityFromDisplay(newValue);

    // Reset auto-corrected flag when user manually changes quantity
    state.quantityAutoCorrected = false;

    // Validate quantity in quantity mode
    let validationPassed = true;
    if (symbol && symbol.quantityMode === 'quantity') {
      validationPassed = validateQuantity();
    }

    if (validationPassed) {
      fetchMargin();
    }
    updateResizeButton();
  });

  // Order type toggle
  const orderTypes = ['MARKET', 'LIMIT', 'SL', 'SL-M'];
  container.querySelector('#oa-ordertype-btn')?.addEventListener('click', (e) => {
    const idx = orderTypes.indexOf(state.orderType);
    state.orderType = orderTypes[(idx + 1) % orderTypes.length];
    e.target.textContent = state.orderType;
    updatePriceDisplay();
  });

  // Price input - update on blur (click outside) only
  const priceInput = container.querySelector('#oa-price');
  priceInput?.addEventListener('blur', (e) => {
    state.price = parseFloat(e.target.value) || 0;
    updateOrderButton();
    fetchMargin();
  });

  // Price update button (↻)
  container.querySelector('#oa-price-update')?.addEventListener('click', () => {
    const priceEl = document.getElementById('oa-price');
    if (priceEl) {
      state.price = parseFloat(priceEl.value) || 0;
      updateOrderButton();
      fetchMargin();
    }
  });

  // Lots update button (↻)
  container.querySelector('#oa-lots-update')?.addEventListener('click', () => {
    const lotsEl = document.getElementById('oa-lots');
    const symbol = getActiveSymbol();

    // Don't process if controls are disabled or in loading state
    if (!lotsEl || lotsEl.value === 'Loading...') return;

    if (symbol) {
      const minValue = symbol.quantityMode === 'lots' ? 1 : (state.lotSize || 1);
      const newValue = Math.max(minValue, parseInt(lotsEl.value) || minValue);
      setQuantityFromDisplay(newValue);
      state.quantityAutoCorrected = false; // Reset flag on manual change

      // Only validate in quantity mode
      let validationPassed = true;
      if (symbol.quantityMode === 'quantity') {
        validationPassed = validateQuantity();
      }

      if (validationPassed) {
        fetchMargin();
      }
      updateResizeButton();
    }
  });

  // Net pos refresh functionality - double click on input to refresh
  container.querySelector('#oa-netpos')?.addEventListener('dblclick', () => {
    if (!document.getElementById('oa-netpos').classList.contains('editable')) {
      fetchOpenPosition();
    }
  });

  // Net pos input - make editable on click
  container.querySelector('#oa-netpos')?.addEventListener('click', (e) => {
    if (e.target.readOnly && !e.target.classList.contains('oa-loading')) {
      e.target.readOnly = false;
      e.target.classList.add('editable');
      e.target.select();
      e.target.dataset.editing = 'true';
      // Update button title for editing mode
      const updateBtn = document.getElementById('oa-netpos-update');
      if (updateBtn) updateBtn.title = 'Set target qty';
    }
  });

  // Net pos input - handle blur (click outside)
  container.querySelector('#oa-netpos')?.addEventListener('blur', (e) => {
    if (!e.target.readOnly) {
      e.target.readOnly = true;
      e.target.classList.remove('editable');
      // Keep editing flag true so update button can still commit the value
      e.target.dataset.editing = e.target.dataset.editing || 'true';
      // Validate netpos quantity
      validateNetposQuantity();
    }
  });

  // Net pos input - handle change
  container.querySelector('#oa-netpos')?.addEventListener('change', (e) => {
    // Don't process changes if input is in loading state
    if (e.target.value === 'Loading...' || e.target.readOnly) return;
    validateNetposQuantity();
    updateResizeButton();
  });

  // Net pos refresh button (↻)
  container.querySelector('#oa-netpos-update')?.addEventListener('click', () => {
    const netposEl = document.getElementById('oa-netpos');
    const updateBtn = document.getElementById('oa-netpos-update');
    const symbol = getActiveSymbol();
    if (netposEl && (netposEl.dataset.editing === 'true' || !netposEl.readOnly)) {
      // If user modified the quantity, commit the edited value
      const newDisplayValue = Math.max(0, parseInt(netposEl.value) || 0);
      const baseQty = symbol
        ? (symbol.quantityMode === 'lots' ? newDisplayValue * (state.lotSize || 1) : newDisplayValue)
        : newDisplayValue;
      netposEl.dataset.qty = baseQty.toString();
      netposEl.value = (symbol && symbol.quantityMode === 'lots' ? newDisplayValue : baseQty).toString();
      // Make it readonly again after setting the value
      netposEl.readOnly = true;
      netposEl.classList.remove('editable');
      netposEl.dataset.editing = 'false';
      // Reset auto-corrected flag since user has confirmed the value
      state.netposAutoCorrected = false;
      // Reset button title back to refresh mode
      if (updateBtn) updateBtn.title = 'Refresh Net Position';
      updateResizeButton();
    } else {
      // If readonly, fetch current position
      fetchOpenPosition();
    }
  });

  // Resize button
  container.querySelector('#oa-resize-btn')?.addEventListener('click', () => {
    // Validate netpos quantity before placing resize order
    const validationPassed = validateNetposQuantity();
    // Only place resize if validation passed
    if (validationPassed) {
      placeResize();
    }
  });

  // Order button
  container.querySelector('#oa-order-btn')?.addEventListener('click', () => {
    // Validate quantity before placing order
    const symbol = getActiveSymbol();
    let validationPassed = true;
    if (symbol && symbol.quantityMode === 'quantity') {
      validationPassed = validateQuantity();
    }

    // Only place order if validation passed
    if (validationPassed) {
      if (state.useMoneyness) placeOptionsOrder();
      else placePlaceOrder();
    }
  });

  // Theme toggle
  container.querySelector('#oa-theme-btn')?.addEventListener('click', () => toggleTheme());

  // Refresh button
  container.querySelector('#oa-refresh-btn')?.addEventListener('click', () => toggleRefreshPanel());

  // Expiry slider arrows
  container.querySelector('#oa-expiry-left')?.addEventListener('click', () => scrollExpiry(-1));
  container.querySelector('#oa-expiry-right')?.addEventListener('click', () => scrollExpiry(1));

  // Strike dropdown controls
  container.querySelector('#oa-update-strikes')?.addEventListener('click', () => updateStrikesAndQuotes());
  container.querySelector('#oa-mode-toggle')?.addEventListener('click', () => toggleStrikeMode());
  container.querySelector('#oa-extend-strikes')?.addEventListener('click', () => extendStrikes());

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

// Theme toggle
function toggleTheme() {
  state.theme = state.theme === 'dark' ? 'light' : 'dark';
  applyTheme(state.theme);
  saveSettings({ theme: state.theme });
  const btn = document.getElementById('oa-theme-btn');
  if (btn) btn.textContent = state.theme === 'dark' ? '☀️' : '🌙';
}

function applyTheme(theme) {
  const container = document.getElementById('openalgo-controls');
  if (!container) return;
  if (theme === 'light') {
    container.classList.add('oa-light-theme');
    container.classList.remove('oa-dark-theme');
  } else {
    container.classList.add('oa-dark-theme');
    container.classList.remove('oa-light-theme');
  }
}

// Refresh panel
function toggleRefreshPanel() {
  const panel = document.getElementById('oa-refresh-panel');
  if (!panel) return;
  const isHidden = panel.classList.contains('hidden');
  if (isHidden) {
    panel.innerHTML = buildRefreshPanel();
    setupRefreshEvents(panel);
  }
  panel.classList.toggle('hidden');
}

function buildRefreshPanel() {
  return `
    <div class="oa-refresh-content">
      <div class="oa-refresh-row">
        <div class="oa-refresh-col">
          <label class="oa-small-label">Mode</label>
          <select id="oa-refresh-mode" class="oa-small-select">
            <option value="manual" ${state.refreshMode === 'manual' ? 'selected' : ''}>Manual</option>
            <option value="auto" ${state.refreshMode === 'auto' ? 'selected' : ''}>Auto</option>
          </select>
        </div>
        <div class="oa-refresh-col" id="oa-interval-group" ${state.refreshMode === 'manual' ? 'style="display:none"' : ''}>
          <label class="oa-small-label">Sec</label>
          <input id="oa-refresh-interval" type="number" min="3" max="60" value="${state.refreshIntervalSec}" class="oa-small-input">
        </div>
      </div>
      <div class="oa-checkbox-inline">
        <label class="oa-checkbox-compact"><input type="checkbox" id="oa-ref-funds" ${state.refreshAreas.funds ? 'checked' : ''}> Funds</label>
        <label class="oa-checkbox-compact"><input type="checkbox" id="oa-ref-underlying" ${state.refreshAreas.underlying ? 'checked' : ''}> Undly</label>
        <label class="oa-checkbox-compact"><input type="checkbox" id="oa-ref-selectedStrike" ${state.refreshAreas.selectedStrike ? 'checked' : ''}> Strike</label>
      </div>
      <div class="oa-refresh-actions">
        <button id="oa-refresh-save" class="oa-btn primary">Save</button>
        <button id="oa-refresh-now" class="oa-btn success">Now</button>
      </div>
    </div>
  `;
}

function setupRefreshEvents(panel) {
  panel.querySelector('#oa-refresh-mode')?.addEventListener('change', (e) => {
    const intGroup = panel.querySelector('#oa-interval-group');
    if (intGroup) intGroup.style.display = e.target.value === 'manual' ? 'none' : '';
  });
  panel.querySelector('#oa-refresh-save')?.addEventListener('click', async () => {
    state.refreshMode = panel.querySelector('#oa-refresh-mode').value;
    state.refreshIntervalSec = parseInt(panel.querySelector('#oa-refresh-interval').value) || 5;
    state.refreshAreas = {
      funds: panel.querySelector('#oa-ref-funds').checked,
      underlying: panel.querySelector('#oa-ref-underlying').checked,
      selectedStrike: panel.querySelector('#oa-ref-selectedStrike').checked
    };
    await saveSettings({ refreshMode: state.refreshMode, refreshIntervalSec: state.refreshIntervalSec, refreshAreas: state.refreshAreas });
    startDataRefresh();
    toggleRefreshPanel();
    showNotification('Refresh settings saved!', 'success');
  });
  panel.querySelector('#oa-refresh-now')?.addEventListener('click', () => manualRefresh());
}

// Expiry slider scroll
function scrollExpiry(direction) {
  const slider = document.getElementById('oa-expiry-slider');
  if (slider) slider.scrollBy({ left: direction * 80, behavior: 'smooth' });
}

// Loading indicators
function showLoadingIndicator(area) {
  const el = document.getElementById(`oa-${area === 'underlying' ? 'underlying-ltp' : area}`);
  if (el) el.classList.add('oa-loading');
}

function hideLoadingIndicator(area) {
  const el = document.getElementById(`oa-${area === 'underlying' ? 'underlying-ltp' : area}`);
  if (el) el.classList.remove('oa-loading');
}

// Strike dropdown control functions
async function updateStrikesAndQuotes() {
  const btn = document.getElementById('oa-update-strikes');
  const strikeCol = document.getElementById('oa-strike-col');
  const ltpCol = document.getElementById('oa-ltp-col');

  // Always show loading on button
  btn?.classList.add('oa-loading');

  if (state.strikeMode === 'moneyness') {
    // Show loading on strike column first for moneyness mode
    strikeCol?.classList.add('oa-loading');

    // Re-fetch moneyness-based strikes using optionsymbol API
    await fetchStrikeChain();

    // Now loading on LTP column while quotes fetch
    strikeCol?.classList.remove('oa-loading');
    ltpCol?.classList.add('oa-loading');

    await fetchStrikeLTPs();
  } else {
    // In strike mode, only show loading on LTP column (only quotes update)
    ltpCol?.classList.add('oa-loading');
    await fetchStrikeLTPs();
  }

  // Update price if MARKET order
  if (state.orderType === 'MARKET') {
    updatePriceDisplay();
  }

  // Remove all loading
  btn?.classList.remove('oa-loading');
  ltpCol?.classList.remove('oa-loading');
}

async function toggleStrikeMode() {
  state.strikeMode = state.strikeMode === 'moneyness' ? 'strike' : 'moneyness';
  state.useMoneyness = state.strikeMode === 'moneyness';
  await saveSettings({ strikeMode: state.strikeMode });

  // Update mode button label
  const btn = document.getElementById('oa-mode-toggle');
  if (btn) btn.textContent = state.strikeMode === 'moneyness' ? 'M' : 'S';

  // Update strike dropdown to show editable/non-editable strike
  updateStrikeDropdown();
  showNotification(`Mode: ${state.strikeMode === 'moneyness' ? 'Moneyness' : 'Strike'}`, 'success');
}

async function extendStrikes() {
  // Prevent concurrent executions
  if (isExtendingStrikes) return;
  isExtendingStrikes = true;

  try {
    const symbol = getActiveSymbol();
    if (!symbol || !state.selectedExpiry) return;

  const btn = document.getElementById('oa-extend-strikes');
  if (btn) btn.classList.add('oa-loading');

  state.extendLevel++;
  const newITM = `ITM${state.extendLevel}`;
  const newOTM = `OTM${state.extendLevel}`;

  // Fetch new ITM and OTM strikes sequentially to respect rate limits
  const results = [];
  for (const offset of [newITM, newOTM]) {
    const result = await rateLimitedApiCall('/api/v1/optionsymbol', {
      strategy: 'Chrome',
      underlying: symbol.symbol,
      exchange: symbol.exchange,
      expiry_date: state.selectedExpiry,
      offset: offset,
      option_type: state.optionType
    });
    results.push(result);
  }
  const newStrikes = [];

  results.forEach((r, i) => {
    if (r.status === 'success') {
      const offset = i === 0 ? newITM : newOTM;
      const strikeMatch = r.symbol.match(/^[A-Z]+(?:\d{2}[A-Z]{3}\d{2})(\d+)(?=CE$|PE$)/);
      newStrikes.push({
        offset,
        symbol: r.symbol,
        exchange: r.exchange || symbol.optionExchange,
        strike: strikeMatch ? parseInt(strikeMatch[1]) : 0,
        lotsize: r.lotsize || state.lotSize,
        ltp: 0,
        prevClose: 0
      });
    }
  });

  // Add to chain (ITM at beginning, OTM at end)
  const itmStrike = newStrikes.find(s => s.offset === newITM);
  const otmStrike = newStrikes.find(s => s.offset === newOTM);
  if (itmStrike) strikeChain.unshift(itmStrike);
  if (otmStrike) strikeChain.push(otmStrike);

  // Fetch LTPs for new strikes
  if (newStrikes.length > 0) {
    const symbols = newStrikes.map(s => ({ symbol: s.symbol, exchange: s.exchange }));
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
  }

  updateStrikeDropdown();
  if (btn) btn.classList.remove('oa-loading');
  } finally {
    isExtendingStrikes = false;
  }
}

// Build dynamic symbol for Strike mode
function buildDynamicSymbol(strike) {
  const symbol = getActiveSymbol();
  if (!symbol) return null;

  // Format: BANKNIFTY05DEC2453600CE
  const expiry = state.selectedExpiry; // Already in DDMMMYY format
  return `${symbol.symbol}${expiry}${strike}${state.optionType}`;
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
        <label>Rate Limit (ms delay between API calls)</label>
        <input id="oa-ratelimit" type="number" min="0" max="1000" value="${state.rateLimit}">
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
          <span class="oa-symbol-info">${s.symbol} (${s.exchange})</span>
          <div class="oa-symbol-actions">
            <button class="oa-edit-symbol" title="Edit">✏️</button>
            <button class="oa-remove-symbol" title="Remove">✕</button>
          </div>
        </div>
      `).join('')}
    </div>
    <div id="oa-edit-symbol-form" class="oa-edit-form hidden"></div>
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
      productType: product,
      quantityMode: 'lots' // Default to lots mode
    };
    settings.symbols.push(newSymbol);
    if (!settings.activeSymbolId) settings.activeSymbolId = newSymbol.id;
    await saveSettings({ symbols: settings.symbols, activeSymbolId: settings.activeSymbolId });
    symbolInput.value = '';

    // Update UI dynamically
    panel.innerHTML = buildSettingsPanel();
    setupSettingsEvents(panel);

    // Update main symbol dropdown
    const select = document.getElementById('oa-symbol-select');
    if (select) {
      select.innerHTML = settings.symbols.map(s => `<option value="${s.id}" ${s.id === settings.activeSymbolId ? 'selected' : ''}>${s.symbol}</option>`).join('') + (settings.symbols.length === 0 ? '<option value="">Add symbol in settings</option>' : '');
    }
    showNotification('Symbol added!', 'success');
  });

  // Remove symbol
  panel.querySelectorAll('.oa-remove-symbol').forEach(btn => {
    btn.addEventListener('click', async (e) => {
      const id = e.target.closest('.oa-symbol-item').dataset.id;
      settings.symbols = settings.symbols.filter(s => s.id !== id);
      if (settings.activeSymbolId === id) settings.activeSymbolId = settings.symbols[0]?.id || '';
      await saveSettings({ symbols: settings.symbols, activeSymbolId: settings.activeSymbolId });

      // Update UI dynamically
      panel.innerHTML = buildSettingsPanel();
      setupSettingsEvents(panel);

      // Update main symbol dropdown
      const select = document.getElementById('oa-symbol-select');
      if (select) {
        select.innerHTML = settings.symbols.map(s => `<option value="${s.id}" ${s.id === settings.activeSymbolId ? 'selected' : ''}>${s.symbol}</option>`).join('') + (settings.symbols.length === 0 ? '<option value="">Add symbol in settings</option>' : '');
      }
      showNotification('Symbol removed!', 'success');
    });
  });

  // Edit symbol
  panel.querySelectorAll('.oa-edit-symbol').forEach(btn => {
    btn.addEventListener('click', (e) => {
      const id = e.target.closest('.oa-symbol-item').dataset.id;
      const sym = settings.symbols.find(s => s.id === id);
      if (!sym) return;
      const form = panel.querySelector('#oa-edit-symbol-form');
      form.classList.remove('hidden');
      form.innerHTML = `
        <div class="oa-edit-row">
          <input id="oa-edit-name" type="text" value="${sym.symbol}" placeholder="Symbol">
          <select id="oa-edit-exchange">
            <option value="NSE_INDEX" ${sym.exchange === 'NSE_INDEX' ? 'selected' : ''}>NSE_INDEX</option>
            <option value="NSE" ${sym.exchange === 'NSE' ? 'selected' : ''}>NSE</option>
            <option value="BSE_INDEX" ${sym.exchange === 'BSE_INDEX' ? 'selected' : ''}>BSE_INDEX</option>
            <option value="BSE" ${sym.exchange === 'BSE' ? 'selected' : ''}>BSE</option>
          </select>
          <select id="oa-edit-product">
            <option value="MIS" ${sym.productType === 'MIS' ? 'selected' : ''}>MIS</option>
            <option value="NRML" ${sym.productType === 'NRML' ? 'selected' : ''}>NRML</option>
          </select>
          <button id="oa-save-edit" class="oa-btn primary" data-id="${id}">Save</button>
          <button id="oa-cancel-edit" class="oa-btn">Cancel</button>
        </div>
      `;
      form.querySelector('#oa-save-edit')?.addEventListener('click', async () => {
        sym.symbol = form.querySelector('#oa-edit-name').value.trim().toUpperCase();
        sym.exchange = form.querySelector('#oa-edit-exchange').value;
        sym.optionExchange = deriveOptionExchange(sym.exchange);
        sym.productType = form.querySelector('#oa-edit-product').value;
        await saveSettings({ symbols: settings.symbols });
        // Update UI without reload
        form.classList.add('hidden');
        panel.innerHTML = buildSettingsPanel();
        setupSettingsEvents(panel);
        // Update symbol dropdown in main UI
        const select = document.getElementById('oa-symbol-select');
        if (select) {
          select.innerHTML = settings.symbols.map(s => `<option value="${s.id}" ${s.id === settings.activeSymbolId ? 'selected' : ''}>${s.symbol}</option>`).join('');
        }
        showNotification('Symbol updated!', 'success');
      });
      form.querySelector('#oa-cancel-edit')?.addEventListener('click', () => form.classList.add('hidden'));
    });
  });

  // Save settings
  panel.querySelector('#oa-save-settings')?.addEventListener('click', async () => {
    const newSettings = {
      hostUrl: panel.querySelector('#oa-host').value,
      apiKey: panel.querySelector('#oa-apikey').value,
      uiMode: panel.querySelector('#oa-uimode').value,
      rateLimit: parseInt(panel.querySelector('#oa-ratelimit').value) || 100
    };
    state.rateLimit = newSettings.rateLimit;

    if (newSettings.uiMode === 'quick') {
      newSettings.symbol = panel.querySelector('#oa-quick-symbol')?.value || '';
      newSettings.exchange = panel.querySelector('#oa-quick-exchange')?.value || 'NSE';
      newSettings.product = panel.querySelector('#oa-quick-product')?.value || 'MIS';
      newSettings.quantity = panel.querySelector('#oa-quick-qty')?.value || '1';
    }

    const modeChanged = newSettings.uiMode !== settings.uiMode;
    await saveSettings(newSettings);
    showNotification('Settings saved!', 'success');

    // Apply UI mode change without full reload - rebuild UI
    if (modeChanged) {
      const container = document.getElementById('openalgo-controls');
      if (container) {
        // Update container class to fix width immediately
        container.className = newSettings.uiMode === 'scalping' ? 'oa-container oa-scalping' : 'oa-container oa-quick';
        container.innerHTML = newSettings.uiMode === 'scalping' ? buildScalpingUI() : buildQuickUI();
        if (newSettings.uiMode === 'scalping') {
          setupScalpingEvents(container);
          applyTheme(state.theme);
          if (settings.apiKey && settings.hostUrl) {
            fetchExpiry();
            startDataRefresh();
          }
        } else {
          setupQuickEvents(container);
        }
      }
    }
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
    /* Base container - Compact sizing */
    .oa-container { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; background: #000; color: #eee; border-radius: 10px; box-shadow: 0 8px 32px rgba(0,0,0,0.5); padding: 8px; font-size: 11px; position: relative; }
    .oa-container.oa-scalping { min-width: 360px; }
    .oa-container.oa-quick { min-width: auto; }
    .oa-container.oa-dark-theme { background: #000; color: #eee; }
    .oa-container.oa-light-theme { background: #fff; color: #222; box-shadow: 0 4px 20px rgba(0,0,0,0.15); }
    .oa-light-theme .oa-select, .oa-light-theme .oa-toggle, .oa-light-theme .oa-strike-select, .oa-light-theme .oa-lot-btn, .oa-light-theme .oa-price-input { background: #f0f0f0 !important; color: #222 !important; border-color: #ccc !important; }
    .oa-light-theme .oa-lots input { background: #f0f0f0 !important; color: #222 !important; border-color: #ccc !important; }
    .oa-light-theme .oa-lots input.editable { border-color: #3b82f6 !important; background: #fff !important; }
    .oa-light-theme .oa-lots input[readonly]:hover { background: #e8e8e8 !important; }
    .oa-light-theme .oa-small-select, .oa-light-theme .oa-small-input { background: #f0f0f0 !important; color: #222 !important; border-color: #ccc !important; }
    .oa-light-theme .oa-add-symbol input, .oa-light-theme .oa-add-symbol select { background: #f0f0f0 !important; color: #222 !important; border-color: #ccc !important; }
    .oa-light-theme .oa-strike-dropdown, .oa-light-theme .oa-settings-panel, .oa-light-theme .oa-refresh-panel { background: #fff !important; border-color: #ddd !important; }
    .oa-light-theme .oa-expiry-btn { background: #e8e8e8 !important; color: #666 !important; }
    .oa-light-theme .oa-expiry-btn.active { background: #5c6bc0 !important; color: #fff !important; }
    .oa-light-theme .oa-strike-row:hover { background: #f5f5f5 !important; }
    .oa-light-theme .oa-strike-row.selected { background: #bbdefb !important; }
    .oa-light-theme .oa-strike-row.atm { background: #c8e6c9 !important; }
    .oa-light-theme .oa-form-group input, .oa-light-theme .oa-form-group select { background: #f5f5f5 !important; color: #222 !important; border-color: #ccc !important; }
    .oa-light-theme .oa-symbol-item { background: #f0f0f0 !important; }
    .oa-light-theme .oa-mode-slider { background-color: #ddd !important; }
    .oa-light-theme .oa-mode-switch:checked + .oa-mode-slider { background-color: #5c6bc0 !important; }
    .oa-light-theme .oa-strike-actions { background: #f5f5f5; border-top: 1px solid #ddd; }
    .oa-light-theme .oa-action-btn { background: #f0f0f0 !important; color: #333 !important; border: 1px solid #ccc !important; border-radius: 3px !important; font-size: 9px !important; cursor: pointer !important; text-align: center !important; flex: 1 !important; padding: 5px 8px !important; }
    .oa-light-theme .oa-action-btn:hover { background: #e0e0e0; color: #000; }
    .oa-light-theme .oa-strike { color: #222 !important; }
    .oa-light-theme .oa-strike.editable { color: #3b82f6 !important; }
    .oa-drag-handle { height: 3px; background: #333; border-radius: 2px; margin: -4px -4px 6px; cursor: move; }
    .oa-light-theme .oa-drag-handle { background: #ccc !important; }
    
    /* Header */
    .oa-header { display: flex; align-items: center; gap: 6px; margin-bottom: 6px; flex-wrap: wrap; }
    .oa-select { background: #111; color: #fff; border: 1px solid #333; border-radius: 4px; padding: 4px 8px; font-weight: 600; font-size: 11px; }
    .oa-ltp-display { font-size: 11px; font-weight: 600; display: flex; align-items: center; gap: 4px; }
    .oa-ltp-value { font-weight: 700; }
    .oa-change-text { color: #999; font-size: 10px; }
    .oa-mode-indicator { font-size: 9px; color: #5c6bc0; font-weight: 700; padding: 2px 6px; border-radius: 3px; background: rgba(92, 107, 192, 0.1); cursor: pointer; }
    .oa-mode-indicator:hover { filter: brightness(1.1); }
    .oa-funds { font-size: 10px; margin-left: auto; }
    .positive { color: #00e676 !important; }
    .negative { color: #ff5252 !important; }
    .oa-icon-btn { background: transparent; border: none; color: #666; font-size: 14px; cursor: pointer; padding: 2px 6px; }
    .oa-icon-btn:hover { color: #fff; }
    .oa-light-theme .oa-icon-btn { color: #999 !important; }
    .oa-light-theme .oa-icon-btn:hover { color: #333 !important; }
    
    /* Controls row */
    .oa-controls { display: flex; align-items: center; gap: 4px; flex-wrap: wrap; }
    .oa-toggle { background: #222 !important; color: #fff !important; border: none !important; border-radius: 4px !important; padding: 5px 10px !important; font-weight: 700 !important; cursor: pointer !important; text-transform: uppercase !important; font-size: 10px !important; height: auto !important; width: auto !important; }
    .oa-toggle.buy { background: #00c853 !important; }
    .oa-toggle.sell { background: #ff1744 !important; }
    .oa-ordertype-fixed { min-width: 55px !important; text-align: center !important; }
    .oa-strike-select { background: #111 !important; color: #fff !important; border: 1px solid #444 !important; border-radius: 4px !important; padding: 5px 8px !important; cursor: pointer !important; min-width: 80px !important; font-size: 10px !important; height: auto !important; }
    .oa-lots { display: flex; align-items: center; gap: 2px; }
    .oa-lot-btn { background: #222 !important; color: #fff !important; border: none !important; border-radius: 3px !important; width: 22px !important; height: 22px !important; cursor: pointer !important; font-size: 14px !important; padding: 0 !important; margin: 0 !important; }
    .oa-lot-btn:disabled { background: #333 !important; color: #666 !important; cursor: not-allowed !important; }
    .oa-light-theme .oa-lot-btn:disabled { background: #ccc !important; color: #999 !important; }
    .oa-lots input { width: 80px !important; background: #111 !important; color: #fff !important; border: 1px solid #333 !important; border-radius: 4px !important; text-align: right !important; padding: 5px 18px 5px 5px !important; font-size: 10px !important; height: 24px !important; box-sizing: border-box !important; }
    .oa-lots input:disabled { background: #222 !important; color: #666 !important; cursor: not-allowed !important; }
    .oa-lots input.editable { border-color: #5c6bc0 !important; background: #1a1a2e !important; }
    .oa-lots input[readonly] { cursor: pointer !important; }
    .oa-lots input[readonly]:hover { background: #1a1a2e !important; }
    .oa-lots-label { font-size: 9px; color: #666; }
    
    /* Input wrapper with update button */
    .oa-input-wrapper { position: relative !important; display: inline-flex !important; align-items: center !important; }
    .oa-input-wrapper input { padding-right: 18px !important; }
    .oa-input-update { position: absolute !important; right: 2px !important; top: 50% !important; transform: translateY(-50%) !important; background: transparent !important; border: none !important; color: #666 !important; font-size: 10px !important; cursor: pointer !important; padding: 2px !important; line-height: 1 !important; }
    .oa-input-update:hover:not(:disabled) { color: #00e676; }
    .oa-input-update:disabled { color: #666; cursor: not-allowed; }
    .oa-lots .oa-input-wrapper input { width: 70px !important; background: #111 !important; color: #fff !important; border: 1px solid #333 !important; border-radius: 4px !important; text-align: right !important; padding: 5px 18px 5px 5px !important; font-size: 10px !important; height: 24px !important; box-sizing: border-box !important; }
    .oa-lots input.loading { text-align: center; }
    .oa-light-theme .oa-lots .oa-input-wrapper input { background: #f0f0f0 !important; color: #222 !important; border-color: #ccc !important; }
    .oa-light-theme .oa-lots input.editable { border-color: #3b82f6 !important; background: #fff !important; }
    .oa-light-theme .oa-lots input[readonly]:hover { background: #e8e8e8 !important; }
    .price-wrapper { margin-right: 2px; }
    .oa-price-input { width: 55px !important; background: #111 !important; color: #fff !important; border: 1px solid #333 !important; border-radius: 4px !important; padding: 5px 18px 5px 5px !important; text-align: right !important; font-size: 10px !important; height: 24px !important; box-sizing: border-box !important; }
    .oa-price-input:disabled { opacity: 0.5; }
    .netpos-wrapper { margin-right: 2px; }
    /* Net pos button and input */
    .oa-netpos-btn { background: #222 !important; color: #ccc !important; border: 1px solid #333 !important; border-radius: 4px !important; padding: 4px 6px !important; cursor: pointer !important; font-size: 11px !important; font-weight: 700 !important; white-space: nowrap !important; height: auto !important; width: auto !important; }
    .oa-netpos-btn:hover { background: #333 !important; color: #fff !important; }
    .oa-netpos-input-wrapper { position: relative !important; display: inline-flex !important; align-items: center !important; margin-left: 2px !important; }
    .oa-netpos-input { width: 70px !important; background: #111 !important; color: #fff !important; border: 1px solid #333 !important; border-radius: 4px !important; padding: 5px 20px 5px 6px !important; text-align: right !important; font-size: 10px !important; height: 24px !important; box-sizing: border-box !important; }
    .oa-netpos-label { position: absolute !important; right: 6px !important; top: 50% !important; transform: translateY(-50%) !important; color: #666 !important; font-size: 9px !important; font-weight: 700 !important; pointer-events: none !important; }
    .oa-netpos-input.editable { border-color: #5c6bc0; background: #1a1a2e; }
    .oa-netpos-input[readonly] { cursor: pointer; }
    .oa-netpos-input[readonly]:hover { background: #1a1a2e; }

    /* Light theme styles for net pos */
    .oa-light-theme .oa-netpos-input { background: #f0f0f0 !important; color: #222 !important; border-color: #ccc !important; }
    .oa-light-theme .oa-netpos-input.editable { border-color: #3b82f6 !important; background: #fff !important; }
    .oa-light-theme .oa-netpos-input[readonly]:hover { background: #e8e8e8 !important; }
    .oa-light-theme .oa-netpos-label { color: #999 !important; }

    /* Remove spinner arrows from number inputs */
    input[type="text"]::-webkit-outer-spin-button, input[type="text"]::-webkit-inner-spin-button,
    input[type="number"]::-webkit-outer-spin-button, input[type="number"]::-webkit-inner-spin-button { -webkit-appearance: none; margin: 0; }
    input[type="text"], input[type="number"] { -moz-appearance: textfield; }
    
    .oa-order-btn { padding: 6px 12px !important; border: none !important; border-radius: 6px !important; font-weight: 700 !important; cursor: pointer !important; text-transform: uppercase !important; font-size: 10px !important; white-space: nowrap !important; height: auto !important; width: auto !important; }
    .oa-order-btn.buy { background: linear-gradient(135deg, #00c853, #00e676) !important; color: #000 !important; }
    .oa-order-btn.sell { background: linear-gradient(135deg, #ff1744, #ff5252) !important; color: #fff !important; }
    .oa-resize-btn { padding: 6px 10px !important; border: none !important; border-radius: 6px !important; font-weight: 700 !important; cursor: pointer !important; font-size: 10px !important; white-space: nowrap !important; background: #222 !important; color: #eee !important; border: 1px solid #333 !important; height: auto !important; width: auto !important; }
    .oa-resize-btn.neutral { background: #222 !important; color: #eee !important; }
    .oa-resize-btn.buy { background: linear-gradient(135deg, #00c853, #00e676) !important; color: #000 !important; }
    .oa-resize-btn.sell { background: linear-gradient(135deg, #ff1744, #ff5252) !important; color: #fff !important; }
    .oa-light-theme .oa-resize-btn { background: #f0f0f0 !important; color: #222 !important; border-color: #ccc !important; }
    .oa-light-theme .oa-resize-btn.buy { color: #000 !important; }
    .oa-light-theme .oa-resize-btn.sell { color: #fff !important; }
    
    /* Strike dropdown - left aligned */
    .oa-strike-dropdown { position: absolute; top: 100%; left: 0; background: #000; border: 1px solid #222; border-radius: 6px; margin-top: 4px; max-height: 280px; overflow: hidden; z-index: 100; width: 240px; }
    .oa-strike-dropdown.hidden { display: none; }
    .oa-expiry-container { display: flex; align-items: center; border-bottom: 1px solid #222; }
    .oa-expiry-arrow { background: transparent; border: none; color: #666; font-size: 16px; cursor: pointer; padding: 4px 6px; }
    .oa-expiry-arrow:hover { color: #fff; }
    .oa-expiry-slider { display: flex; gap: 4px; padding: 6px; overflow-x: auto; flex: 1; scrollbar-width: none; }
    .oa-expiry-slider::-webkit-scrollbar { display: none; }
    .oa-expiry-btn { background: #111; color: #888; border: none; border-radius: 3px; padding: 4px 8px; font-size: 9px; cursor: pointer; white-space: nowrap; }
    .oa-expiry-btn.active { background: #3a3a6a; color: #fff; }
    .oa-strike-header { display: grid; grid-template-columns: 0.8fr 1fr 0.6fr; padding: 4px 8px; font-size: 9px; color: #555; border-bottom: 1px solid #222; }
    .oa-strike-header span { position: relative; overflow: hidden; }
    .oa-strike-list { max-height: 150px; overflow-y: auto; }
    .oa-strike-row { display: grid; grid-template-columns: 0.8fr 1fr 0.6fr; padding: 5px 8px; cursor: pointer; font-size: 10px; }
    .oa-strike-row:hover { background: #111; }
    .oa-strike-row.atm { background: #0a2a1a; font-weight: 600; }
    .oa-strike-row.selected { background: #1a2a4a; }
    .oa-moneyness { color: #888; font-size: 9px; }
    .oa-moneyness.dim { color: #444; }
    .oa-strike { color: #fff; display: flex; align-items: center; gap: 4px; }
    .oa-strike.editable { color: #5c6bc0; }
    .oa-opt-badge { font-size: 8px; padding: 1px 3px; border-radius: 2px; font-weight: 600; }
    .oa-opt-badge.ce { background: #00c853; color: #000; }
    .oa-opt-badge.pe { background: #ff1744; color: #fff; }
    .oa-ltp { text-align: right; font-size: 10px; }
    
    /* Strike actions row */
    .oa-strike-actions { display: flex; gap: 4px; padding: 6px 8px; border-top: 1px solid #222; background: #0a0a0a; }
    .oa-action-btn { flex: 1; padding: 5px 8px; background: #222; color: #aaa; border: 1px solid #333; border-radius: 3px; font-size: 9px; cursor: pointer; text-align: center; }
    .oa-action-btn:hover { background: #333; color: #fff; }
    .oa-action-btn.oa-loading { opacity: 0.7; pointer-events: none; }
    
    /* Refresh panel - compact right aligned */
    .oa-refresh-panel { position: absolute; top: 100%; right: 0; left: auto; background: #000; border: 1px solid #222; border-radius: 6px; margin-top: 4px; z-index: 102; width: 200px; }
    .oa-refresh-panel.hidden { display: none; }
    .oa-refresh-content { padding: 8px; }
    .oa-refresh-row { display: flex; gap: 8px; margin-bottom: 6px; }
    .oa-refresh-col { display: flex; flex-direction: column; gap: 2px; }
    .oa-small-label { font-size: 8px; color: #666; }
    .oa-small-select { background: #111; color: #fff; border: 1px solid #333; border-radius: 3px; padding: 3px 4px; font-size: 9px; }
    .oa-small-input { width: 40px; background: #111; color: #fff; border: 1px solid #333; border-radius: 3px; padding: 3px 4px; font-size: 9px; text-align: center; }
    .oa-checkbox-inline { display: flex; gap: 6px; flex-wrap: wrap; margin-bottom: 6px; }
    .oa-checkbox-compact { display: flex; align-items: center; gap: 3px; font-size: 9px; color: #aaa; cursor: pointer; }
    .oa-checkbox-compact input[type="checkbox"] { width: 12px; height: 12px; margin: 0; }
    .oa-refresh-actions { display: flex; gap: 4px; }
    
    /* Settings panel - right aligned */
    .oa-settings-panel { position: absolute; top: 100%; right: 0; left: auto; background: #000; border: 1px solid #222; border-radius: 6px; margin-top: 4px; z-index: 101; max-height: 350px; overflow-y: auto; width: 240px; }
    .oa-settings-panel.hidden { display: none; }
    .oa-settings-content { padding: 10px; }
    .oa-settings-content h3 { margin: 0 0 10px; font-size: 12px; }
    .oa-settings-content h4 { margin: 10px 0 6px; font-size: 10px; color: #666; }
    .oa-form-group { margin-bottom: 8px; }
    .oa-form-group label { display: block; font-size: 9px; color: #666; margin-bottom: 3px; }
    .oa-form-group input, .oa-form-group select { width: 100%; background: #111; color: #fff; border: 1px solid #333; border-radius: 3px; padding: 6px; box-sizing: border-box; font-size: 10px; }
    .oa-symbol-list { max-height: 80px; overflow-y: auto; margin-bottom: 6px; }
    .oa-symbol-item { display: flex; justify-content: space-between; align-items: center; padding: 4px 6px; background: #111; border-radius: 3px; margin-bottom: 3px; font-size: 10px; }
    .oa-symbol-info { flex: 1; }
    .oa-symbol-actions { display: flex; gap: 4px; align-items: center; }

    /* Mode toggle switch */
    .oa-mode-toggle { position: relative; display: inline-block; width: 36px; height: 18px; }
    .oa-mode-switch { opacity: 0; width: 0; height: 0; }
    .oa-mode-slider { position: absolute; cursor: pointer; top: 0; left: 0; right: 0; bottom: 0; background-color: #ccc; transition: .4s; border-radius: 18px; }
    .oa-mode-slider:before { position: absolute; content: ""; height: 14px; width: 14px; left: 2px; bottom: 2px; background-color: white; transition: .4s; border-radius: 50%; }
    .oa-mode-switch:checked + .oa-mode-slider { background-color: #5c6bc0; }
    .oa-mode-switch:checked + .oa-mode-slider:before { transform: translateX(18px); }
    .oa-edit-symbol { background: transparent; border: none; cursor: pointer; font-size: 12px; padding: 2px; }
    .oa-remove-symbol { background: transparent; border: none; color: #ff5252; cursor: pointer; font-size: 12px; padding: 2px; }
    .oa-edit-form { background: #1a1a2e; padding: 8px; border-radius: 4px; margin-bottom: 8px; }
    .oa-edit-form.hidden { display: none; }
    .oa-edit-row { display: flex; gap: 4px; flex-wrap: wrap; align-items: center; }
    .oa-edit-row input, .oa-edit-row select { flex: 1; min-width: 50px; background: #111; color: #fff; border: 1px solid #333; border-radius: 3px; padding: 4px; font-size: 9px; }
    .oa-add-symbol { display: flex; gap: 3px; flex-wrap: wrap; }
    .oa-add-symbol input, .oa-add-symbol select { flex: 1; min-width: 50px; background: #111; color: #fff; border: 1px solid #333; border-radius: 3px; padding: 4px; font-size: 9px; }
    .oa-btn { padding: 5px 10px; border: none; border-radius: 4px; font-weight: 600; cursor: pointer; text-transform: uppercase; font-size: 9px; }
    .oa-btn.primary { background: #5c6bc0; color: #fff; }
    .oa-btn.success { background: #00c853; color: #fff; }
    .oa-btn.warning { background: #ffc107; color: #000; }
    .oa-btn.error { background: #ff5252; color: #fff; }
    .oa-btn.info { background: #29b6f6; color: #fff; }
    .oa-quick-row { display: flex; gap: 4px; align-items: center; }
    
    /* Loading animation */
    .oa-loading { position: relative; overflow: hidden; }
    .oa-loading::after { content: ''; position: absolute; top: 0; left: 0; right: 0; bottom: 0; background: linear-gradient(90deg, transparent, rgba(255,255,255,0.15), transparent); animation: oa-shimmer 1s infinite; }
    .oa-light-theme .oa-loading::after { background: linear-gradient(90deg, transparent, rgba(0,0,0,0.1), transparent); }
    @keyframes oa-shimmer { 0% { transform: translateX(-100%); } 100% { transform: translateX(100%); } }
    
    /* Notifications */
    .openalgo-notification { position: fixed; bottom: 20px; right: 20px; padding: 10px 16px; border-radius: 6px; font-weight: 600; z-index: 10001; animation: slideIn 0.3s ease; font-size: 11px; }
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
    // Only re-initialize if not already done and no existing UI
    if (!isInitialized && !document.getElementById('openalgo-controls')) {
      init();
    }
    sendResponse({ success: true });
  }
  return true;
});
