/**
 * Chrome Blocks - Type-Safe Popup Controller (Manifest V3)
 * Redesigned for Tailwind CSS Dark-Mode UI.
 */

import { StatsResponse, ToggleEnableResponse, WhitelistResponse } from './types';

document.addEventListener('DOMContentLoaded', async () => {
  // DOM Elements
  const masterToggle = document.getElementById('masterToggle') as HTMLInputElement | null;
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
  const moduleBadges = document.querySelectorAll<HTMLElement>('.module-badge');

  let currentTabDomain = '';
  let isCurrentSiteWhitelisted = false;

  /**
   * Format numbers with commas (e.g., 1,420)
   */
  function formatNumber(num: number): string {
    return new Intl.NumberFormat().format(num || 0);
  }

  /**
   * Calculate human-readable data saved from blocked count (avg ~145 KB / ad)
   */
  function formatDataSaved(blockedCount: number): string {
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
  function formatTimeSaved(blockedCount: number): string {
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
  function updateStatsDisplay(total: number, today: number): void {
    if (totalBlockedCountEl) totalBlockedCountEl.textContent = formatNumber(total);
    if (todayBlockedCountEl) todayBlockedCountEl.textContent = formatNumber(today);
    if (dataSavedCountEl) dataSavedCountEl.textContent = formatDataSaved(total);
    if (timeSavedCountEl) timeSavedCountEl.textContent = formatTimeSaved(total);
  }

  /**
   * Update master protection state in Tailwind UI
   */
  function updateProtectionStateUI(isEnabled: boolean): void {
    if (masterToggle) masterToggle.checked = isEnabled;

    if (isEnabled) {
      if (statusPill) {
        statusPill.className = 'flex items-center gap-1.5 px-2.5 py-1 rounded-full text-[11px] font-semibold tracking-wider bg-emerald-500/10 text-emerald-400 border border-emerald-500/20';
      }
      if (statusText) statusText.textContent = 'ACTIVE';
      if (heroStatusText) {
        heroStatusText.textContent = 'Shield is Active';
        heroStatusText.className = 'text-base font-semibold text-slate-100';
      }

      moduleBadges.forEach(badge => {
        badge.classList.remove('opacity-40');
      });
    } else {
      if (statusPill) {
        statusPill.className = 'flex items-center gap-1.5 px-2.5 py-1 rounded-full text-[11px] font-semibold tracking-wider bg-slate-800 text-slate-400 border border-slate-700';
      }
      if (statusText) statusText.textContent = 'PAUSED';
      if (heroStatusText) {
        heroStatusText.textContent = 'Shield is Paused';
        heroStatusText.className = 'text-base font-semibold text-slate-400';
      }

      moduleBadges.forEach(badge => {
        badge.classList.add('opacity-40');
      });
    }
  }

  /**
   * Update site-specific card status in Tailwind UI
   */
  function updateSiteUI(): void {
    if (!currentDomainEl || !siteStatusBadge || !whitelistBtn || !whitelistBtnText) return;

    if (!currentTabDomain) {
      currentDomainEl.textContent = 'Non-web page';
      siteStatusBadge.textContent = 'Protection idle';
      siteStatusBadge.className = 'text-xs text-slate-400';
      whitelistBtn.style.display = 'none';
      return;
    }

    currentDomainEl.textContent = currentTabDomain;

    if (isCurrentSiteWhitelisted) {
      siteStatusBadge.textContent = 'Whitelisted (Ads Allowed)';
      siteStatusBadge.className = 'text-xs text-amber-400 font-medium';
      whitelistBtnText.textContent = 'Resume on Site';
      whitelistBtn.className = 'flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold rounded-lg bg-amber-500/10 text-amber-300 border border-amber-500/30 hover:bg-amber-500/20 transition-all';
    } else {
      siteStatusBadge.textContent = 'Protected on this site';
      siteStatusBadge.className = 'text-xs text-emerald-400 font-medium';
      whitelistBtnText.textContent = 'Pause on Site';
      whitelistBtn.className = 'flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold rounded-lg bg-slate-800 text-slate-300 border border-slate-700 hover:bg-slate-700/80 hover:text-white transition-all';
    }
  }

  /**
   * Extract hostname cleanly from tab URL
   */
  function getHostname(url?: string): string {
    try {
      if (!url || !url.startsWith('http')) return '';
      const parsed = new URL(url);
      return parsed.hostname.toLowerCase();
    } catch {
      return '';
    }
  }

  /**
   * Load initial state
   */
  async function loadData(): Promise<void> {
    try {
      const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
      if (tabs.length > 0 && tabs[0].url) {
        currentTabDomain = getHostname(tabs[0].url);
      }

      chrome.runtime.sendMessage({ type: 'GET_STATS' }, (response: StatsResponse) => {
        if (chrome.runtime.lastError || !response) return;

        updateProtectionStateUI(response.isEnabled);
        updateStatsDisplay(response.totalBlocked, response.todayBlocked);

        const list = response.whitelistedDomains || [];
        isCurrentSiteWhitelisted = list.includes(currentTabDomain);
        updateSiteUI();
      });
    } catch (e) {
      console.warn('Chrome Blocks: Initialization notice:', e);
    }
  }

  // Event: Master Toggle Switch
  if (masterToggle) {
    masterToggle.addEventListener('change', () => {
      chrome.runtime.sendMessage({ type: 'TOGGLE_ENABLE' }, (res: ToggleEnableResponse) => {
        if (res && res.isEnabled !== undefined) {
          updateProtectionStateUI(res.isEnabled);
        }
      });
    });
  }

  // Event: Toggle Whitelist for Current Domain
  if (whitelistBtn) {
    whitelistBtn.addEventListener('click', () => {
      if (!currentTabDomain) return;

      chrome.runtime.sendMessage({
        type: 'TOGGLE_WHITELIST_DOMAIN',
        domain: currentTabDomain
      }, (res: WhitelistResponse) => {
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
  }

  // Event: Reset Stats
  if (resetStatsBtn) {
    resetStatsBtn.addEventListener('click', () => {
      if (confirm('Reset all blocked ad and tracker statistics?')) {
        chrome.runtime.sendMessage({ type: 'RESET_STATS' }, (res) => {
          if (res && res.success) {
            updateStatsDisplay(0, 0);
          }
        });
      }
    });
  }

  // Real-time synchronization
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return;

    if (changes.totalBlocked || changes.todayBlocked) {
      chrome.storage.local.get(['totalBlocked', 'todayBlocked'], (res) => {
        updateStatsDisplay(Number(res.totalBlocked) || 0, Number(res.todayBlocked) || 0);
      });
    }

    if (changes.isEnabled) {
      updateProtectionStateUI(Boolean(changes.isEnabled.newValue));
    }

    if (changes.whitelistedDomains && currentTabDomain) {
      const list = (changes.whitelistedDomains.newValue as string[]) || [];
      isCurrentSiteWhitelisted = list.includes(currentTabDomain);
      updateSiteUI();
    }
  });

  // Run initial load
  await loadData();
});
