/**
 * Chrome Blocks - Background Service Worker (Manifest V3)
 * Manages declarativeNetRequest rulesets, dynamic whitelist rules,
 * blocked count statistics, and extension badge status.
 */

const RULESET_ID = 'ruleset_1';
const TAB_STATS = new Map(); // tabId -> count of ads blocked in this tab

/**
 * Initialize default storage values if not already present
 */
chrome.runtime.onInstalled.addListener(async (details) => {
  const current = await chrome.storage.local.get([
    'isEnabled',
    'totalBlocked',
    'todayBlocked',
    'lastResetDate',
    'whitelistedDomains'
  ]);

  const today = new Date().toDateString();
  const defaults = {
    isEnabled: current.isEnabled !== undefined ? current.isEnabled : true,
    totalBlocked: current.totalBlocked || 0,
    todayBlocked: current.lastResetDate === today ? (current.todayBlocked || 0) : 0,
    lastResetDate: today,
    whitelistedDomains: current.whitelistedDomains || []
  };

  await chrome.storage.local.set(defaults);
  await syncRuleset(defaults.isEnabled);
  await syncWhitelistDynamicRules(defaults.whitelistedDomains);
  updateBadgeState(defaults.isEnabled);
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
    console.warn('Chrome Blocks: Ruleset update notice:', error.message);
  }
}

/**
 * Update dynamic rules for whitelisted domains to allow all requests
 */
async function syncWhitelistDynamicRules(domains = []) {
  try {
    const existingRules = await chrome.declarativeNetRequest.getDynamicRules();
    const removeRuleIds = existingRules.map(r => r.id);

    const addRules = domains.map((domain, index) => ({
      id: 10000 + index + 1,
      priority: 100, // High priority to override blocking rules
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
    console.warn('Chrome Blocks: Whitelist dynamic rules notice:', error.message);
  }
}

/**
 * Increment total and daily blocked statistics
 */
async function incrementBlockedStats(count = 1, tabId = null) {
  if (count <= 0) return;

  const data = await chrome.storage.local.get([
    'isEnabled',
    'totalBlocked',
    'todayBlocked',
    'lastResetDate'
  ]);

  if (data.isEnabled === false) return;

  const today = new Date().toDateString();
  const currentTotal = (data.totalBlocked || 0) + count;
  const currentDaily = (data.lastResetDate === today ? (data.todayBlocked || 0) : 0) + count;

  await chrome.storage.local.set({
    totalBlocked: currentTotal,
    todayBlocked: currentDaily,
    lastResetDate: today
  });

  // Track per-tab stats
  if (tabId && tabId > 0) {
    const tabCount = (TAB_STATS.get(tabId) || 0) + count;
    TAB_STATS.set(tabId, tabCount);
    updateTabBadge(tabId, tabCount);
  }
}

/**
 * Clean up tab tracking when tab is closed
 */
chrome.tabs.onRemoved.addListener((tabId) => {
  TAB_STATS.delete(tabId);
});

/**
 * Handle tab navigation / reload: reset tab counter
 */
chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo.status === 'loading') {
    TAB_STATS.set(tabId, 0);
    updateTabBadge(tabId, 0);
  }
});

/**
 * Handle tab activation: update badge for newly active tab
 */
chrome.tabs.onActivated.addListener(async (activeInfo) => {
  const count = TAB_STATS.get(activeInfo.tabId) || 0;
  updateTabBadge(activeInfo.tabId, count);
});

/**
 * Update extension action badge
 */
async function updateBadgeState(enabled) {
  try {
    if (!enabled) {
      await chrome.action.setBadgeText({ text: 'OFF' });
      await chrome.action.setBadgeBackgroundColor({ color: '#64748b' });
    } else {
      // Find active tab and show its blocked count
      const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
      if (tabs.length > 0 && tabs[0].id) {
        const count = TAB_STATS.get(tabs[0].id) || 0;
        updateTabBadge(tabs[0].id, count);
      } else {
        await chrome.action.setBadgeText({ text: '' });
      }
    }
  } catch (e) {
    // Ignore badge errors if action is unavailable
  }
}

async function updateTabBadge(tabId, count) {
  try {
    const data = await chrome.storage.local.get(['isEnabled']);
    if (data.isEnabled === false) {
      await chrome.action.setBadgeText({ tabId, text: 'OFF' });
      await chrome.action.setBadgeBackgroundColor({ tabId, color: '#64748b' });
    } else if (count > 0) {
      const text = count > 999 ? '999+' : String(count);
      await chrome.action.setBadgeText({ tabId, text });
      await chrome.action.setBadgeBackgroundColor({ tabId, color: '#00d2ff' });
    } else {
      await chrome.action.setBadgeText({ tabId, text: '' });
    }
  } catch (e) {
    // Tab might be closed
  }
}

/**
 * Listen for DeclarativeNetRequest matched events (Manifest V3 Debug API)
 */
if (chrome.declarativeNetRequest.onRuleMatchedDebug) {
  chrome.declarativeNetRequest.onRuleMatchedDebug.addListener((info) => {
    incrementBlockedStats(1, info.request?.tabId);
  });
}

/**
 * Message Dispatcher for popup and content scripts
 */
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || !message.type) return;

  (async () => {
    switch (message.type) {
      case 'GET_STATS': {
        const data = await chrome.storage.local.get([
          'isEnabled',
          'totalBlocked',
          'todayBlocked',
          'whitelistedDomains'
        ]);
        sendResponse({
          isEnabled: data.isEnabled !== false,
          totalBlocked: data.totalBlocked || 0,
          todayBlocked: data.todayBlocked || 0,
          whitelistedDomains: data.whitelistedDomains || []
        });
        break;
      }

      case 'TOGGLE_ENABLE': {
        const data = await chrome.storage.local.get(['isEnabled']);
        const newState = !(data.isEnabled !== false);
        await chrome.storage.local.set({ isEnabled: newState });
        await syncRuleset(newState);
        updateBadgeState(newState);
        sendResponse({ isEnabled: newState });
        break;
      }

      case 'TOGGLE_WHITELIST_DOMAIN': {
        const { domain } = message;
        if (!domain) {
          sendResponse({ success: false });
          break;
        }

        const data = await chrome.storage.local.get(['whitelistedDomains']);
        const list = data.whitelistedDomains || [];
        const normDomain = domain.toLowerCase().trim();
        const index = list.indexOf(normDomain);

        let isNowWhitelisted = false;
        if (index > -1) {
          list.splice(index, 1);
          isNowWhitelisted = false;
        } else {
          list.push(normDomain);
          isNowWhitelisted = true;
        }

        await chrome.storage.local.set({ whitelistedDomains: list });
        await syncWhitelistDynamicRules(list);
        sendResponse({ success: true, isWhitelisted: isNowWhitelisted, whitelistedDomains: list });
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
        incrementBlockedStats(message.count || 1, tabId);
        sendResponse({ success: true });
        break;
      }

      default:
        sendResponse({ error: 'Unknown message type' });
    }
  })();

  return true; // Keep message channel open for async response
});
