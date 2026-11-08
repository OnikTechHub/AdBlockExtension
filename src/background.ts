/**
 * Chrome Blocks - Type-Safe Background Service Worker (Manifest V3)
 * 
 * Manages DeclarativeNetRequest ruleset, dynamic domain whitelisting,
 * and high-performance in-memory telemetry caching.
 */

import { StorageData, StatsResponse, ToggleEnableResponse, WhitelistResponse } from './types';

const RULESET_ID = 'ruleset_1';
const TAB_STATS = new Map<number, number>(); // tabId -> count of ads blocked

// In-memory stats cache to avoid disk I/O lockups and IPC thrashing
let inMemoryTotalBlocked = 0;
let inMemoryTodayBlocked = 0;
let inMemoryLastResetDate = new Date().toDateString();
let isEnabledState = true;
let inMemoryWhitelistedDomains: string[] = [];
let saveStorageTimeout: ReturnType<typeof setTimeout> | null = null;

/**
 * Initialize default storage values and sync DNR ruleset on startup/install
 */
chrome.runtime.onInstalled.addListener(async () => {
  const current = (await chrome.storage.local.get([
    'isEnabled',
    'totalBlocked',
    'todayBlocked',
    'lastResetDate',
    'whitelistedDomains'
  ])) as StorageData;

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
async function syncRuleset(enabled: boolean): Promise<void> {
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
    console.warn('Chrome Blocks: Ruleset update error:', (error as Error).message);
  }
}

/**
 * Update dynamic rules for whitelisted domains to allow requests without blocking
 */
async function syncWhitelistDynamicRules(domains: string[] = []): Promise<void> {
  try {
    const existingRules = await chrome.declarativeNetRequest.getDynamicRules();
    const removeRuleIds = existingRules.map(r => r.id);

    const addRules: chrome.declarativeNetRequest.Rule[] = domains.map((domain, index) => ({
      id: 10000 + index + 1,
      priority: 100, // High priority to override block rules
      action: { type: chrome.declarativeNetRequest.RuleActionType.ALLOW_ALL_REQUESTS },
      condition: {
        initiatorDomains: [domain.toLowerCase().trim()],
        resourceTypes: [
          chrome.declarativeNetRequest.ResourceType.MAIN_FRAME,
          chrome.declarativeNetRequest.ResourceType.SUB_FRAME,
          chrome.declarativeNetRequest.ResourceType.STYLESHEET,
          chrome.declarativeNetRequest.ResourceType.SCRIPT,
          chrome.declarativeNetRequest.ResourceType.IMAGE,
          chrome.declarativeNetRequest.ResourceType.FONT,
          chrome.declarativeNetRequest.ResourceType.OBJECT,
          chrome.declarativeNetRequest.ResourceType.XMLHTTPREQUEST,
          chrome.declarativeNetRequest.ResourceType.PING,
          chrome.declarativeNetRequest.ResourceType.CSP_REPORT,
          chrome.declarativeNetRequest.ResourceType.MEDIA,
          chrome.declarativeNetRequest.ResourceType.WEBSOCKET,
          chrome.declarativeNetRequest.ResourceType.OTHER
        ]
      }
    }));

    await chrome.declarativeNetRequest.updateDynamicRules({
      removeRuleIds,
      addRules
    });
  } catch (error) {
    console.warn('Chrome Blocks: Dynamic whitelist update notice:', (error as Error).message);
  }
}

/**
 * Debounced persistence of in-memory telemetry to chrome.storage.local
 */
function scheduleStorageSave(): void {
  if (saveStorageTimeout) return;
  saveStorageTimeout = setTimeout(async () => {
    saveStorageTimeout = null;
    try {
      await chrome.storage.local.set({
        totalBlocked: inMemoryTotalBlocked,
        todayBlocked: inMemoryTodayBlocked,
        lastResetDate: inMemoryLastResetDate
      });
    } catch {}
  }, 2500);
}

/**
 * Record blocked ad occurrences in memory with zero disk delay
 */
function recordBlockedOccurrence(count = 1, tabId: number | null = null): void {
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
 * Tab cleanup on removal
 */
chrome.tabs.onRemoved.addListener((tabId: number) => {
  TAB_STATS.delete(tabId);
});

/**
 * Reset per-tab counter on URL navigation
 */
chrome.tabs.onUpdated.addListener((tabId: number, changeInfo) => {
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
 * Update extension action badge
 */
async function updateBadgeState(enabled: boolean): Promise<void> {
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
  } catch {}
}

async function updateTabBadge(tabId: number, count: number): Promise<void> {
  if (!tabId || tabId <= 0) return;
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
  } catch {}
}

/**
 * Message Dispatcher for popup and content scripts
 */
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || !message.type) return;

  (async () => {
    switch (message.type) {
      case 'GET_STATS': {
        const response: StatsResponse = {
          isEnabled: isEnabledState,
          totalBlocked: inMemoryTotalBlocked,
          todayBlocked: inMemoryTodayBlocked,
          whitelistedDomains: inMemoryWhitelistedDomains
        };
        sendResponse(response);
        break;
      }

      case 'TOGGLE_ENABLE': {
        isEnabledState = !isEnabledState;
        await chrome.storage.local.set({ isEnabled: isEnabledState });
        await syncRuleset(isEnabledState);
        updateBadgeState(isEnabledState);
        const response: ToggleEnableResponse = { isEnabled: isEnabledState };
        sendResponse(response);
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
        const response: WhitelistResponse = {
          success: true,
          isWhitelisted: isNowWhitelisted,
          whitelistedDomains: inMemoryWhitelistedDomains
        };
        sendResponse(response);
        break;
      }

      case 'ADD_CUSTOM_FILTER': {
        const { domain, selector } = message;
        if (!domain || !selector) {
          sendResponse({ success: false });
          break;
        }

        const data = (await chrome.storage.local.get(['customFilters'])) as StorageData;
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
        const tabId = sender.tab ? sender.tab.id || null : null;
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
