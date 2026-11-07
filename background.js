/**
 * Chrome Blocks - Streamlined Background Service Worker (Manifest V3)
 * 
 * Manages DeclarativeNetRequest rulesets, dynamic whitelist rules,
 * in-memory telemetry caching (preventing disk I/O thrashing), and tab badges.
 */

const RULESET_ID = 'ruleset_1';
const TAB_STATS = new Map(); // tabId -> count of ads blocked in this tab

// In-memory stats cache to completely eliminate disk I/O lockups and IPC thrashing
let inMemoryTotalBlocked = 0;
let inMemoryTodayBlocked = 0;
let inMemoryLastResetDate = new Date().toDateString();
let isEnabledState = true;
let inMemoryWhitelistedDomains = [];
let saveStorageTimeout = null;

/**
 * Initialize extension state and cache from storage on install/startup
 */
chrome.runtime.onInstalled.addListener(async () => {
  const current = await chrome.storage.local.get([
    'isEnabled',
    'totalBlocked',
    'todayBlocked',
    'lastResetDate',
    'whitelistedDomains'
  ]);

  const today = new Date().toDateString();

  isEnabledState = current.isEnabled !== undefined ? Boolean(current.isEnabled) : true;
  inMemoryTotalBlocked = current.totalBlocked || 0;
  inMemoryTodayBlocked = current.lastResetDate === today ? (current.todayBlocked || 0) : 0;
  inMemoryLastResetDate = today;
  inMemoryWhitelistedDomains = current.whitelistedDomains || [];

  await chrome.storage.local.set({
    isEnabled: isEnabledState,
    totalBlocked: inMemoryTotalBlocked,
    todayBlocked: inMemoryTodayBlocked,
    lastResetDate: today,
    whitelistedDomains: inMemoryWhitelistedDomains
  });

  await syncRuleset(isEnabledState);
  await syncWhitelistDynamicRules(inMemoryWhitelistedDomains);
  updateBadgeState(isEnabledState);
});

/**
 * Synchronize DeclarativeNetRequest static ruleset state
 */
async function syncRuleset(enabled) {
  try {
    if (enabled) {
      await chrome.declarativeNetRequest.updateEnabledRulesets({
        enableRulesetIds: [RULESET_ID]
      });
    } else {
      await chrome.declarativeNetRequest.updateEnabledRulesets({
        disableRulesetIds: [RULESET_ID]
      });
    }
  } catch (error) {
    console.warn('Chrome Blocks: Ruleset sync notice:', error.message);
  }
}

/**
 * Update dynamic rules for whitelisted domains to bypass blocking
 */
async function syncWhitelistDynamicRules(domains = []) {
  try {
    const existingRules = await chrome.declarativeNetRequest.getDynamicRules();
    const removeRuleIds = existingRules.map(r => r.id);

    const addRules = domains.map((domain, index) => ({
      id: 10000 + index + 1,
      priority: 100, // High priority to override block rules
      action: { type: 'allowAllRequests' },
      condition: {
        initiatorDomains: [domain.toLowerCase().trim()],
        resourceTypes: [
          'main_frame',
          'sub_frame',
          'stylesheet',
          'script',
          'image',
          'font',
          'object',
          'xmlhttprequest',
          'ping',
          'csp_report',
          'media',
          'websocket',
          'other'
        ]
      }
    }));

    await chrome.declarativeNetRequest.updateDynamicRules({
      removeRuleIds: removeRuleIds,
      addRules: addRules
    });
  } catch (error) {
    console.warn('Chrome Blocks: Dynamic whitelist update notice:', error.message);
  }
}

/**
 * Debounced persistence of in-memory telemetry to chrome.storage.local
 * Prevents writing to disk hundreds of times per second.
 */
function scheduleStorageSave() {
  if (saveStorageTimeout) return;
  saveStorageTimeout = setTimeout(async () => {
    saveStorageTimeout = null;
    try {
      await chrome.storage.local.set({
        totalBlocked: inMemoryTotalBlocked,
        todayBlocked: inMemoryTodayBlocked,
        lastResetDate: inMemoryLastResetDate
      });
    } catch (e) {}
  }, 3500);
}

/**
 * Increment telemetry in memory with zero disk delay
 */
function recordBlockedOccurrence(count = 1, tabId = null) {
  if (count <= 0 || !isEnabledState) return;

  const today = new Date().toDateString();
  if (inMemoryLastResetDate !== today) {
    inMemoryTodayBlocked = 0;
    inMemoryLastResetDate = today;
  }

  inMemoryTotalBlocked += count;
  inMemoryTodayBlocked += count;

  if (tabId && tabId > 0) {
    const currentTabCount = (TAB_STATS.get(tabId) || 0) + count;
    TAB_STATS.set(tabId, currentTabCount);
    updateTabBadge(tabId, currentTabCount);
  }

  scheduleStorageSave();
}

/**
 * Clean up tab tracking on tab closure
 */
chrome.tabs.onRemoved.addListener((tabId) => {
  TAB_STATS.delete(tabId);
});

/**
 * Reset per-tab counter when navigating to a new URL
 */
chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo.status === 'loading') {
    TAB_STATS.set(tabId, 0);
    updateTabBadge(tabId, 0);
  }
});

/**
 * Update badge text when switching active tabs
 */
chrome.tabs.onActivated.addListener((activeInfo) => {
  const count = TAB_STATS.get(activeInfo.tabId) || 0;
  updateTabBadge(activeInfo.tabId, count);
});

/**
 * Update global extension action badge
 */
async function updateBadgeState(enabled) {
  try {
    if (!enabled) {
      await chrome.action.setBadgeText({ text: 'OFF' });
      await chrome.action.setBadgeBackgroundColor({ color: '#64748b' });
    } else {
      const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
      if (tabs.length > 0 && tabs[0].id) {
        const count = TAB_STATS.get(tabs[0].id) || 0;
        updateTabBadge(tabs[0].id, count);
      } else {
        await chrome.action.setBadgeText({ text: '' });
      }
    }
  } catch (e) {}
}

async function updateTabBadge(tabId, count) {
  try {
    if (!isEnabledState) {
      await chrome.action.setBadgeText({ tabId, text: 'OFF' });
      await chrome.action.setBadgeBackgroundColor({ tabId, color: '#64748b' });
    } else if (count > 0) {
      const text = count > 999 ? '999+' : String(count);
      await chrome.action.setBadgeText({ tabId, text });
      await chrome.action.setBadgeBackgroundColor({ tabId, color: '#00d2ff' });
    } else {
      await chrome.action.setBadgeText({ tabId, text: '' });
    }
  } catch (e) {}
}

/**
 * Catch network-level blocks without triggering disk I/O storms
 */
if (chrome.declarativeNetRequest.onRuleMatchedDebug) {
  chrome.declarativeNetRequest.onRuleMatchedDebug.addListener((info) => {
    recordBlockedOccurrence(1, info.request?.tabId);
  });
}

/**
 * Unified Message Dispatcher for popup and content scripts
 */
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || !message.type) return;

  (async () => {
    switch (message.type) {
      case 'GET_STATS': {
        // Return immediately from memory cache (0ms latency, zero disk read)
        sendResponse({
          isEnabled: isEnabledState,
          totalBlocked: inMemoryTotalBlocked,
          todayBlocked: inMemoryTodayBlocked,
          whitelistedDomains: inMemoryWhitelistedDomains
        });
        break;
      }

      case 'TOGGLE_ENABLE': {
        isEnabledState = !isEnabledState;
        await chrome.storage.local.set({ isEnabled: isEnabledState });
        await syncRuleset(isEnabledState);
        updateBadgeState(isEnabledState);
        sendResponse({ isEnabled: isEnabledState });
        break;
      }

      case 'TOGGLE_WHITELIST_DOMAIN': {
        const { domain } = message;
        if (!domain) {
          sendResponse({ success: false });
          break;
        }

        const normDomain = domain.toLowerCase().trim();
        const index = inMemoryWhitelistedDomains.indexOf(normDomain);

        let isNowWhitelisted = false;
        if (index > -1) {
          inMemoryWhitelistedDomains.splice(index, 1);
          isNowWhitelisted = false;
        } else {
          inMemoryWhitelistedDomains.push(normDomain);
          isNowWhitelisted = true;
        }

        await chrome.storage.local.set({ whitelistedDomains: inMemoryWhitelistedDomains });
        await syncWhitelistDynamicRules(inMemoryWhitelistedDomains);
        sendResponse({ success: true, isWhitelisted: isNowWhitelisted, whitelistedDomains: inMemoryWhitelistedDomains });
        break;
      }

      case 'ADD_CUSTOM_FILTER': {
        const { domain, selector } = message;
        if (!domain || !selector) {
          sendResponse({ success: false });
          break;
        }

        const data = await chrome.storage.local.get(['customFilters']);
        const customFilters = data.customFilters || {};
        if (!Array.isArray(customFilters[domain])) {
          customFilters[domain] = [];
        }
        if (!customFilters[domain].includes(selector)) {
          customFilters[domain].push(selector);
        }

        await chrome.storage.local.set({ customFilters });
        sendResponse({ success: true, customFilters });
        break;
      }

      case 'RESET_STATS': {
        const today = new Date().toDateString();
        inMemoryTotalBlocked = 0;
        inMemoryTodayBlocked = 0;
        inMemoryLastResetDate = today;

        await chrome.storage.local.set({
          totalBlocked: 0,
          todayBlocked: 0,
          lastResetDate: today
        });

        TAB_STATS.clear();
        updateBadgeState(true);
        sendResponse({ success: true });
        break;
      }

      case 'AD_BLOCKED': {
        const tabId = sender.tab ? sender.tab.id : null;
        recordBlockedOccurrence(message.count || 1, tabId);
        sendResponse({ success: true });
        break;
      }

      default:
        sendResponse({ error: 'Unknown message type' });
    }
  })();

  return true; // Keep message channel open for async response
});
