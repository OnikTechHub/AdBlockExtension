/**
 * Chrome Blocks - Popup Controller
 * Manages real-time statistics, master toggle, site whitelisting,
 * and sleek glassmorphic UI updates.
 */

document.addEventListener('DOMContentLoaded', async () => {
  // DOM Elements
  const masterToggle = document.getElementById('masterToggle');
  const statusPill = document.getElementById('statusPill');
  const statusText = document.getElementById('statusText');
  const heroStatusText = document.getElementById('heroStatusText');

  const currentDomainEl = document.getElementById('currentDomain');
  const siteStatusBadge = document.getElementById('siteStatusBadge');
  const whitelistBtn = document.getElementById('whitelistBtn');
  const whitelistBtnText = document.getElementById('whitelistBtnText');

  const totalBlockedCountEl = document.getElementById('totalBlockedCount');
  const todayBlockedCountEl = document.getElementById('todayBlockedCount');
  const dataSavedCountEl = document.getElementById('dataSavedCount');
  const timeSavedCountEl = document.getElementById('timeSavedCount');

  const resetStatsBtn = document.getElementById('resetStatsBtn');
  const moduleBadges = document.querySelectorAll('.module-badge');

  let currentTabDomain = '';
  let isCurrentSiteWhitelisted = false;

  /**
   * Format numbers with commas (e.g., 1,420)
   */
  function formatNumber(num) {
    return new Intl.NumberFormat().format(num || 0);
  }

  /**
   * Calculate human-readable data saved from blocked count (avg ~145 KB / ad)
   */
  function formatDataSaved(blockedCount) {
    const totalKB = (blockedCount || 0) * 145;
    if (totalKB < 1024) {
      return `${totalKB} KB`;
    } else if (totalKB < 1024 * 1024) {
      return `${(totalKB / 1024).toFixed(1)} MB`;
    } else {
      return `${(totalKB / (1024 * 1024)).toFixed(2)} GB`;
    }
  }

  /**
   * Calculate estimated time saved (avg ~2.5s / ad request/video ad)
   */
  function formatTimeSaved(blockedCount) {
    const totalSeconds = Math.round((blockedCount || 0) * 2.5);
    if (totalSeconds < 60) {
      return `${totalSeconds} s`;
    } else if (totalSeconds < 3600) {
      return `${Math.round(totalSeconds / 60)} min`;
    } else {
      return `${(totalSeconds / 3600).toFixed(1)} hrs`;
    }
  }

  /**
   * Update all statistics in UI
   */
  function updateStatsDisplay(total, today) {
    totalBlockedCountEl.textContent = formatNumber(total);
    todayBlockedCountEl.textContent = formatNumber(today);
    dataSavedCountEl.textContent = formatDataSaved(total);
    timeSavedCountEl.textContent = formatTimeSaved(total);
  }

  /**
   * Update master protection state in UI
   */
  function updateProtectionStateUI(isEnabled) {
    masterToggle.checked = isEnabled;

    if (isEnabled) {
      statusPill.className = 'status-pill active';
      statusText.textContent = 'ACTIVE';
      heroStatusText.textContent = 'Shield is Active';
      heroStatusText.style.color = '#f8fafc';

      moduleBadges.forEach(badge => {
        badge.className = 'module-badge active';
      });
    } else {
      statusPill.className = 'status-pill paused';
      statusText.textContent = 'PAUSED';
      heroStatusText.textContent = 'Shield is Paused';
      heroStatusText.style.color = '#94a3b8';

      moduleBadges.forEach(badge => {
        badge.className = 'module-badge paused';
      });
    }
  }

  /**
   * Update site-specific card status in UI
   */
  function updateSiteUI() {
    if (!currentTabDomain) {
      currentDomainEl.textContent = 'Non-web page';
      siteStatusBadge.textContent = 'Protection idle';
      siteStatusBadge.className = 'site-status';
      whitelistBtn.style.display = 'none';
      return;
    }

    currentDomainEl.textContent = currentTabDomain;

    if (isCurrentSiteWhitelisted) {
      siteStatusBadge.textContent = 'Whitelisted (Ads Allowed)';
      siteStatusBadge.className = 'site-status whitelisted';
      whitelistBtnText.textContent = 'Resume on Site';
      whitelistBtn.classList.add('whitelisted');
    } else {
      siteStatusBadge.textContent = 'Protected on this site';
      siteStatusBadge.className = 'site-status';
      whitelistBtnText.textContent = 'Pause on Site';
      whitelistBtn.classList.remove('whitelisted');
    }
  }

  /**
   * Extract hostname cleanly from tab URL
   */
  function getHostname(url) {
    try {
      if (!url || !url.startsWith('http')) return '';
      const parsed = new URL(url);
      return parsed.hostname.toLowerCase();
    } catch {
      return '';
    }
  }

  /**
   * Load initial data from background & active tab
   */
  async function loadData() {
    try {
      // 1. Get active tab
      const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
      if (tabs.length > 0 && tabs[0].url) {
        currentTabDomain = getHostname(tabs[0].url);
      }

      // 2. Query stats from background
      chrome.runtime.sendMessage({ type: 'GET_STATS' }, (response) => {
        if (chrome.runtime.lastError || !response) return;

        updateProtectionStateUI(response.isEnabled);
        updateStatsDisplay(response.totalBlocked, response.todayBlocked);

        const list = response.whitelistedDomains || [];
        isCurrentSiteWhitelisted = list.includes(currentTabDomain);
        updateSiteUI();
      });
    } catch (e) {
      console.warn('Chrome Blocks: Could not load initial state:', e);
    }
  }

  // Event: Master Toggle Switch
  masterToggle.addEventListener('change', () => {
    chrome.runtime.sendMessage({ type: 'TOGGLE_ENABLE' }, (res) => {
      if (res && res.isEnabled !== undefined) {
        updateProtectionStateUI(res.isEnabled);
      }
    });
  });

  // Event: Toggle Whitelist for Current Domain
  whitelistBtn.addEventListener('click', () => {
    if (!currentTabDomain) return;

    chrome.runtime.sendMessage({
      type: 'TOGGLE_WHITELIST_DOMAIN',
      domain: currentTabDomain
    }, (res) => {
      if (res && res.success) {
        isCurrentSiteWhitelisted = res.isWhitelisted;
        updateSiteUI();

        // Reload the current active tab so changes reflect immediately
        chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
          if (tabs.length > 0 && tabs[0].id) {
            chrome.tabs.reload(tabs[0].id);
          }
        });
      }
    });
  });

  // Event: Reset Blocked Stats
  resetStatsBtn.addEventListener('click', () => {
    if (confirm('Reset all blocked ad and tracker statistics?')) {
      chrome.runtime.sendMessage({ type: 'RESET_STATS' }, (res) => {
        if (res && res.success) {
          updateStatsDisplay(0, 0);
        }
      });
    }
  });

  // Listen for background updates while popup is open
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return;

    if (changes.totalBlocked || changes.todayBlocked) {
      chrome.storage.local.get(['totalBlocked', 'todayBlocked'], (res) => {
        updateStatsDisplay(res.totalBlocked || 0, res.todayBlocked || 0);
      });
    }

    if (changes.isEnabled) {
      updateProtectionStateUI(Boolean(changes.isEnabled.newValue));
    }

    if (changes.whitelistedDomains && currentTabDomain) {
      const list = changes.whitelistedDomains.newValue || [];
      isCurrentSiteWhitelisted = list.includes(currentTabDomain);
      updateSiteUI();
    }
  });

  // Initial load
  await loadData();
});

