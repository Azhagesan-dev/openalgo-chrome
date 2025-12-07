# OpenAlgo Options Scalping Extension - Knowledge Base

This document details the features, user instructions, and implementation logic for the OpenAlgo Options Scalping Extension (v2.0).

## 1. Project Objective
Upgrade the existing OpenAlgo Chrome extension from a simple order placement tool to a feature-rich **Options Scalping Interface**. The new design focuses on speed, clean UI, and direct integration with OpenAlgo Python backend APIs.

---

## 2. Core Features & User Instructions

### A. Dual UI Modes
**Requirement:** The extension supports two distinct interface modes, configurable via Settings.
1.  **Options Scalping Mode (Default):** The new, full-featured interface for options trading.
2.  **Quick Orders Mode (Legacy):** The original LE/LX/SE/SX button interface.
*Implementation Details:*
*   Toggle located in the Settings Panel (`⋮` button).
*   Only one mode is visible at a time to keep the UI clean.

### B. Options Scalping UI Layout
The UI is designed with a "Single Row" philosophy for the main controls to ensure compactness and speed.

#### **Row 1: Header & Information**
*   **Symbol Selector:** A dropdown menu to switch between active trading symbols (e.g., NIFTY, BANKNIFTY).
*   **Underlying LTP Display:**
    *   Shows the Last Traded Price (LTP) of the underlying asset.
    *   **Change Indicator:** Includes an arrow (↑/↓), point change (+/-), and percentage change inside braces `(%)`.
    *   **Color Coding:** 
        *   **Green:** If LTP > Prev Close.
        *   **Red:** If LTP < Prev Close.
*   **Funds Display:**
    *   **Available:** Shows `availablecash`.
    *   **Today P/L:** Shows Net Profit/Loss (`m2mrealized` + `m2munrealized`). Color-coded (Green for profit, Red for loss).

#### **Row 2: Trading Controls**
*   **Action Toggle (B/S):** Switches between **BUY** (Green) and **SELL** (Red).
*   **Option Type Toggle (CE/PE):** Switches between **Call (CE)** and **Put (PE)**. Shows loading animation during fetch.
*   **Strike/ATM Selector:**
    *   **Moneyness Mode:** Shows "ATM" (or offset).
    *   **Strike Mode:** Shows "Strike" or selected strike value.
    *   Clicking opens the **Strike Selection Dropdown**.
*   **Lots Input:**
    *   Text input for number of lots.
    *   Includes `+` and `-` increment/decrement buttons.
    *   **Update Button (↻):** Inside input box to refresh margin calculation manually.
    *   Label "LOTS" displayed next to input.
    *   *Implementation Note:* Actual quantity sent to API is `Lot Size * Number of Lots`.
*   **Order Type Toggle:** Cycles through: `MARKET` → `LIMIT` → `SL` → `SL-M`.
*   **Price Input:**
    *   Shows the LTP of the selected option strike.
    *   **Update Button (↻):** Inside input box to refresh price manually.
    *   Updates dynamically on blur (clicking outside).
    *   **Editable** only when Order Type is `LIMIT` or `SL`.
    *   **Disabled** (greyed out) when Order Type is `MARKET`.
*   **Order Button:**
    *   Dynamic Text: Shows precise action, price, and **Margin Required** (e.g., "BUY @ 250.50 [₹1,234]").
    *   Color changes based on Action (Green for Buy, Red for Sell).

### C. Strike Selection System
**Requirement:** A slide-out/dropdown interface for selecting specific option strikes based on Expiry and Moneyness.

*   **Expiry Slider:** Horizontal scrollable list of expiry dates.
    *   **Loading:** Shows animations on UI elements when expiry is clicked.
    *   **Auto-Fetch:** Automatically loads strikes for the selected expiry.
*   **Strike Chain List:**
    *   Columns: **Moneyness** | **Strike** | **LTP**.
    *   **Range:** Shows 5 **ITM**, **ATM**, and 5 **OTM**. EXTENDABLE via "+ More".
    *   **Loading Animations:** Shows shimmer/loading state on columns during API calls.
    *   **Interaction:**
        *   Clicking **ATM** triggers Moneyness-based order.
        *   Clicking **Strike** triggers Symbol-based order.
*   **Refresh Controls:**
    *   **Update:** Refreshes the entire list.
    *   **Mode Toggle:** Switch between Moneyness and Strike modes.

### D. Settings & Symbol Management
**Requirement:** Manage watchlists and configurations without manual JSON editing.
*   **Host URL & API Key:** Connection details for the local OpenAlgo server.
*   **Rate Limit:** Configurable delay (ms) between API calls to prevent throttling.
*   **UI Mode:** Toggle between Scalping and Quick Orders.
*   **Symbol Management:**
    *   **Add Symbol:** User inputs Symbol Name (e.g., NIFTY), Exchange (NSE_INDEX/NSE/etc.), and Product (MIS/NRML).
    *   **Auto-Detection:**
        *   If Exchange is `NSE_INDEX` or `NSE`, Option Exchange auto-sets to `NFO`.
        *   If Exchange is `BSE_INDEX` or `BSE`, Option Exchange auto-sets to `BFO`.
    *   **Remove Symbol:** One-click removal from the list.
*   **Persistence:** Saved to Chrome Storage (`chrome.storage.sync`).
*   **Dynamic Updates:** Settings apply immediately without page reload.

### E. Refresh Panel (Compact)
*   **Compact Design:** Right-aligned, width 200px.
*   **Inline Data Options:** Checkboxes for Funds, Underlying, and **Selected Strike** side-by-side.
*   **Modes:** Manual or Auto (Interval-based).

---

## 3. Order of Events & API Sequence

This section details exactly how the extension interacts with the backend APIs for different user events.

### 1. Initialization (Extension Load)
When the extension loads or injects into a page:
1.  **Load Settings:** Retrieves `hostUrl`, `apiKey`, `symbols`, `rateLimit`, and `activeSymbolId`.
2.  **Fetch Expiry:** `POST /api/v1/expiry` (Only on load/symbol change).
3.  **Auto-Fetch Strikes:** Automatically calls `fetchStrikeChain()` after expiry load.
4.  **Start Refresh Loop:** Starts a timer (default 5s) if Auto Mode is on.
    *   **Call 1:** `POST /api/v1/quotes` → Fetches Underlying LTP.
    *   **Call 2:** `POST /api/v1/funds` → Fetches Funds & P/L.
    *   **Call 3:** `refreshSelectedStrike()` → Checks latest strike price. Updates LTPs for the currently loaded strike chain.

### 2. Symbol Selection
When a user selects a new underlying symbol (e.g., changing NIFTY to BANKNIFTY):
1.  **Display Update:** UI updates immediately.
2.  **API Call:** `POST /api/v1/expiry`
    *   **Outcome:** Populates Expiry Slider.
    *   **Auto-Select:** Selects nearest expiry and triggers `fetchStrikeChain()`.

### 3. Strike Chain Loading
Triggered when Expiry is selected, Symbol is changed, or Update button is clicked:
1.  **Parallel API Calls:** Iterates through offsets `ITM5`...`ATM`...`OTM5`.
    *   **Call:** `POST /api/v1/optionsymbol`.
    *   **Outcome:** Resolves specific symbols and Lot Size.
2.  **LTP Fetch:** `POST /api/v1/multiquotes` for all resolved symbols.
3.  **Visuals:** Loading animations on Strike/LTP columns.

### 4. Refresh Logic (Selected Strike)
**Optimized Refresh:** Updates only the relevant data.
*   **Moneyness Mode:**
    1.  `POST /api/v1/optionsymbol` (Resolve latest strike for current offset).
    2.  `POST /api/v1/quotes` (Get LTP for that strike).
*   **Strike Mode:**
    1.  `POST /api/v1/quotes` (Get LTP for selected symbol).

### 5. Order Placement
A. **Moneyness-Based (M Mode)**
   *   **API:** `POST /api/v1/optionsorder`
   *   **Payload:** `{ offset: "ATM", underlying: "NIFTY", ... }`
   *   **Logic:** The backend automatically resolves the current ATM strike based on live spot price and places the order.
B. **Strike-Based (S Mode)**
   *   **Trigger:** User explicitly clicks a strike price (e.g., "26300") in the dropdown, then clicks BUY/SELL.
   *   **API:** `POST /api/v1/placeorder`
   *   **Payload:** `{ symbol: "NIFTY...26300CE", exchange: "NFO", ... }`
   *   **Logic:** Places an order for that specific contract, regardless of where the underlying moves.
C. **Margin Calculation**
   *   **Trigger:** Price change, Lots change, Action toggle.
   *   **API:** `POST /api/v1/margin`
   *   **Display:** Updates Order Button with required margin.
   
### 6. UI Updates (Event Driven)
*   **B/S Toggle:** Updates `action` state → Changes Order Button Color (Green/Red) → Updates Order Button Text (Action & Margin).
*   **CE/PE Toggle:** Updates `optionType` state → Re-triggers "Strike Chain Loading" to fetch new symbols (Calls vs Puts).
*   **Lot Change:** Updates global `lots` state → Recalculates total quantity → Triggers Margin Update.
*   **Price Change:** Updates `price` state on blur/update → Triggers Margin Update → Updates Order Button Text.

---

## 4. Implementation Logic

### A. API Endpoints Used
1.  **Fund Fetching:** `/api/v1/funds`
2.  **Underlying Quotes:** `/api/v1/quotes`
3.  **Expiry Dates:** `/api/v1/expiry`
4.  **Option Symbols:** `/api/v1/optionsymbol`
5.  **Multi-Quotes:** `/api/v1/multiquotes`
6.  **Place Option Order:** `/api/v1/optionsorder`
7.  **Place Regular Order:** `/api/v1/placeorder`
8.  **Margin Check:** `/api/v1/margin`

### B. Event Handling Logic
*   **Rate Limiter:** `rateLimitedApiCall()` ensures `state.rateLimit` delay (default 100ms) between calls.
*   **Input Blur:** Price/Lot updates trigger on blur (unfocus) or "Update" button click.
*   **Change Detection:** `Change = LTP - Prev_Close`.

### C. Architecture
*   **Manifest V3:** Updated to `manifest_version: 3`.
*   **Storage:** Persisted via `chrome.storage.sync`.
*   **Content Script:** Injects floating UI overlay.
