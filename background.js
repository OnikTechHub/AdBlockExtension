"use strict";
(() => {
  // src/background.ts
  var RULESET_ID = "ruleset_1";
  var TAB_STATS = /* @__PURE__ */ new Map();
  var inMemoryTotalBlocked = 0;
  var inMemoryTodayBlocked = 0;
  var inMemoryLastResetDate = (/* @__PURE__ */ new Date()).toDateString();
  var isEnabledState = true;
  var inMemoryWhitelistedDomains = [];
  var saveStorageTimeout = null;
  chrome.runtime.onInstalled.addListener(async () => {
    const current = await chrome.storage.local.get([
      "isEnabled",
      "totalBlocked",
      "todayBlocked",
      "lastResetDate",
      "whitelistedDomains"
    ]);
    const today = (/* @__PURE__ */ new Date()).toDateString();
    isEnabledState = current.isEnabled !== void 0 ? Boolean(current.isEnabled) : true;
    inMemoryTotalBlocked = current.totalBlocked || 0;
    inMemoryTodayBlocked = current.lastResetDate === today ? current.todayBlocked || 0 : 0;
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
      console.warn("Chrome Blocks: Ruleset update error:", error.message);
    }
  }
  async function syncWhitelistDynamicRules(domains = []) {
    try {
      const existingRules = await chrome.declarativeNetRequest.getDynamicRules();
      const removeRuleIds = existingRules.map((r) => r.id);
      const addRules = domains.map((domain, index) => ({
        id: 1e4 + index + 1,
        priority: 100,
        // High priority to override block rules
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
      console.warn("Chrome Blocks: Dynamic whitelist update notice:", error.message);
    }
  }
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
      } catch {
      }
    }, 2500);
  }
  function recordBlockedOccurrence(count = 1, tabId = null) {
    if (count <= 0 || !isEnabledState) return;
    const today = (/* @__PURE__ */ new Date()).toDateString();
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
  chrome.tabs.onRemoved.addListener((tabId) => {
    TAB_STATS.delete(tabId);
  });
  chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
    if (changeInfo.status === "loading") {
      TAB_STATS.set(tabId, 0);
      updateTabBadge(tabId, 0);
    }
  });
  chrome.tabs.onActivated.addListener((activeInfo) => {
    const count = TAB_STATS.get(activeInfo.tabId) || 0;
    updateTabBadge(activeInfo.tabId, count);
  });
  async function updateBadgeState(enabled) {
    try {
      if (!enabled) {
        await chrome.action.setBadgeText({ text: "OFF" });
        await chrome.action.setBadgeBackgroundColor({ color: "#64748b" });
      } else {
        const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
        if (tabs.length > 0 && tabs[0].id) {
          const count = TAB_STATS.get(tabs[0].id) || 0;
          updateTabBadge(tabs[0].id, count);
        } else {
          await chrome.action.setBadgeText({ text: "" });
        }
      }
    } catch {
    }
  }
  async function updateTabBadge(tabId, count) {
    if (!tabId || tabId <= 0) return;
    try {
      if (!isEnabledState) {
        await chrome.action.setBadgeText({ tabId, text: "OFF" });
        await chrome.action.setBadgeBackgroundColor({ tabId, color: "#64748b" });
      } else if (count > 0) {
        const text = count > 999 ? "999+" : String(count);
        await chrome.action.setBadgeText({ tabId, text });
        await chrome.action.setBadgeBackgroundColor({ tabId, color: "#00d2ff" });
      } else {
        await chrome.action.setBadgeText({ tabId, text: "" });
      }
    } catch {
    }
  }
  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (!message || !message.type) return;
    (async () => {
      switch (message.type) {
        case "GET_STATS": {
          const response = {
            isEnabled: isEnabledState,
            totalBlocked: inMemoryTotalBlocked,
            todayBlocked: inMemoryTodayBlocked,
            whitelistedDomains: inMemoryWhitelistedDomains
          };
          sendResponse(response);
          break;
        }
        case "TOGGLE_ENABLE": {
          isEnabledState = !isEnabledState;
          await chrome.storage.local.set({ isEnabled: isEnabledState });
          await syncRuleset(isEnabledState);
          updateBadgeState(isEnabledState);
          const response = { isEnabled: isEnabledState };
          sendResponse(response);
          break;
        }
        case "TOGGLE_WHITELIST_DOMAIN": {
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
          const response = {
            success: true,
            isWhitelisted: isNowWhitelisted,
            whitelistedDomains: inMemoryWhitelistedDomains
          };
          sendResponse(response);
          break;
        }
        case "ADD_CUSTOM_FILTER": {
          const { domain, selector } = message;
          if (!domain || !selector) {
            sendResponse({ success: false });
            break;
          }
          const data = await chrome.storage.local.get(["customFilters"]);
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
        case "RESET_STATS": {
          const today = (/* @__PURE__ */ new Date()).toDateString();
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
        case "AD_BLOCKED": {
          const tabId = sender.tab ? sender.tab.id || null : null;
          recordBlockedOccurrence(message.count || 1, tabId);
          sendResponse({ success: true });
          break;
        }
        default:
          sendResponse({ error: "Unknown message type" });
      }
    })();
    return true;
  });
})();
