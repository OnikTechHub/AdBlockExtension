/**
 * Chrome Blocks - Type-Safe Content Script (Manifest V3)
 * 
 * Safe & Non-Crashing YouTube Ad Handler:
 * - NO currentTime seeking (eliminates black screen / decoder crash completely)
 * - Safe natural acceleration (16x speed + mute) so ads end in milliseconds
 * - Active instant skip-button auto-clicker
 * - Clean restoration of 1.0x playback rate and un-mute on ad finish
 * - Zero-display DOM stripping for companion banners & sponsored boxes
 */

import { StorageData, ModuleSettings, CustomFilters, TabStatsResponse } from './types';

(() => {
  'use strict';

  // --- State & Preferences ---
  let isEnabled = true;
  let whitelistedDomains: string[] = [];
  let customFilters: CustomFilters = {};
  let moduleSettings: ModuleSettings = {
    blockYouTubeAds: true,
    blockSocialAds: true,
    blockCookieBanners: true
  };

  // --- Telemetry Sync ---
  let blockedCountOnPage = 0;
  let pendingCountToSync = 0;
  let syncTimer: ReturnType<typeof setTimeout> | null = null;

  // --- Observers & Timers ---
  let domObserver: MutationObserver | null = null;
  let youtubeSafetyTimer: ReturnType<typeof setInterval> | null = null;

  // --- Interactive Element Picker State ---
  let isPickerActive = false;
  let hoveredElement: HTMLElement | null = null;
  let pickerHud: HTMLElement | null = null;

  const hostname = window.location.hostname.toLowerCase();
  const isYouTubeSite = hostname.includes('youtube.com');

  /**
   * Check if current site is on user whitelist
   */
  function isSiteWhitelisted(): boolean {
    return whitelistedDomains.some(domain => {
      const d = domain.toLowerCase().trim();
      return hostname === d || hostname.endsWith('.' + d);
    });
  }

  /**
   * Determine if protection is active
   */
  function isProtectionActive(): boolean {
    return isEnabled && !isSiteWhitelisted();
  }

  /**
   * Queue ad block occurrences and batch-persist to background worker
   */
  function recordAdBlocked(count = 1): void {
    if (count <= 0) return;
    blockedCountOnPage += count;
    pendingCountToSync += count;

    if (!syncTimer) {
      syncTimer = setTimeout(flushPendingBlockedCount, 1500);
    }
  }

  function flushPendingBlockedCount(): void {
    syncTimer = null;
    if (pendingCountToSync > 0) {
      const count = pendingCountToSync;
      pendingCountToSync = 0;
      try {
        if (chrome.runtime?.id) {
          chrome.runtime.sendMessage({
            type: 'AD_BLOCKED',
            count,
            domain: hostname
          }).catch(() => {});
        }
      } catch {}
    }
  }

  /**
   * Update cosmetic styling class on the root HTML element
   */
  function updateCosmeticClass(): void {
    if (isProtectionActive()) {
      document.documentElement.classList.remove('cb-disabled');
      applyCustomFilters();
    } else {
      document.documentElement.classList.add('cb-disabled');
      removeCustomFilters();
    }
  }

  /**
   * Apply user-defined custom CSS filter rules
   */
  function applyCustomFilters(): void {
    if (!isProtectionActive()) return;

    let styleEl = document.getElementById('cb-custom-filters-style');
    const domainFilters: string[] = [];

    for (const [domain, selectors] of Object.entries(customFilters)) {
      if (domain === '*' || hostname === domain || hostname.endsWith('.' + domain)) {
        if (Array.isArray(selectors)) {
          domainFilters.push(...selectors);
        }
      }
    }

    if (domainFilters.length === 0) {
      if (styleEl) styleEl.remove();
      return;
    }

    if (!styleEl) {
      styleEl = document.createElement('style');
      styleEl.id = 'cb-custom-filters-style';
      (document.head || document.documentElement).appendChild(styleEl);
    }

    styleEl.textContent = domainFilters
      .map(sel => `${sel} { display: none !important; visibility: hidden !important; }`)
      .join('\n');
  }

  function removeCustomFilters(): void {
    const styleEl = document.getElementById('cb-custom-filters-style');
    if (styleEl) styleEl.remove();
  }

  /* ==========================================================================
     1. Safe & Non-Crashing YouTube Ad Handler
     ========================================================================== */

  const YOUTUBE_SKIP_SELECTORS = [
    '.ytp-ad-skip-button',
    '.ytp-ad-skip-button-modern',
    '.ytp-skip-ad-button',
    '.ytp-ad-skip-button-slot button',
    '.ytp-ad-skip-button-container button',
    'button.ytp-ad-skip-button',
    'button.ytp-ad-skip-button-modern',
    '.videoAdUiSkipButton',
    '[id^="skip-button:"] button',
    'button[class*="ytp-ad-skip-button"]',
    'button[class*="ytp-skip-ad-button"]',
    '.ytp-ad-overlay-close-button'
  ];

  const YOUTUBE_COMPANION_AD_SELECTORS = [
    '#player-ads',
    '.ytp-ad-overlay-container',
    '.ytp-ad-message-container',
    '.ytp-ad-action-interstitial',
    'ytd-ad-slot-renderer',
    '#secondary ytd-ad-slot-renderer',
    'ytd-in-feed-ad-layout-renderer',
    '#masthead-ad',
    'ytd-banner-promo-renderer'
  ];

  /**
   * Safe skip button trigger:
   * Uses standard .click() directly on the skip button.
   * Does NOT dispatch bubbling synthetic pointer/mouse events that cause
   * YouTube's player container to interpret the click as a play/pause toggle.
   */
  function triggerSkipButtons(container: Document | HTMLElement = document): boolean {
    for (const selector of YOUTUBE_SKIP_SELECTORS) {
      try {
        const btn = container.querySelector(selector) as HTMLElement | null;
        if (btn) {
          btn.click();
          recordAdBlocked(1);
          return true;
        }
      } catch {}
    }

    return false;
  }

  /**
   * Safe, Non-Freezing YouTube Ad Handler:
   * - No currentTime seeking (prevents MSE pipeline crash & black screen)
   * - No playbackRate speed modification (lets YouTube player stream naturally)
   * - Simply mutes audio when an ad is active so the user never hears ads
   * - Safely clicks skip buttons (.ytp-ad-skip-button) without triggering video pauses
   * - Cleanly un-mutes audio as soon as the ad finishes (.ad-showing disappears)
   * - Hides overlay banners & companion ad slots cleanly from DOM
   */
  function handleYouTubeAds(): void {
    if (!isProtectionActive() || !moduleSettings.blockYouTubeAds) return;

    const player = (document.getElementById('movie_player') || document.querySelector('.html5-video-player')) as HTMLElement | null;
    if (!player) return;

    const isAdActive = Boolean(
      player.classList.contains('ad-showing') ||
      player.classList.contains('ad-interrupting')
    );

    const video = (document.querySelector('video.html5-main-video') || player.querySelector('video')) as HTMLVideoElement | null;

    if (isAdActive) {
      // 1. Simply mute the audio while the ad is showing
      if (video && !video.muted) {
        video.dataset.cbWasMuted = 'true';
        video.muted = true;
        recordAdBlocked(1);
      }

      // 2. Click any available skip button safely the instant it appears
      triggerSkipButtons(player);
    } else {
      // 3. Ad has ended naturally or was skipped! Cleanly un-mute
      if (video && video.dataset.cbWasMuted === 'true') {
        delete video.dataset.cbWasMuted;
        video.muted = false;
      }
    }

    // 4. Cleanly hide companion ads and sidebar sponsored boxes from the DOM
    for (const selector of YOUTUBE_COMPANION_AD_SELECTORS) {
      try {
        const matches = document.querySelectorAll<HTMLElement>(selector);
        for (const el of matches) {
          if (!el.dataset.cbProcessed) {
            el.dataset.cbProcessed = 'true';
            el.style.setProperty('display', 'none', 'important');
            recordAdBlocked(1);
          }
        }
      } catch {}
    }

    // 5. Dismiss Anti-Adblock modal if triggered
    try {
      const modal = document.querySelector('tp-yt-paper-dialog:has(ytd-enforcement-message-view-model), ytd-enforcement-message-view-model');
      if (modal) {
        modal.remove();
        if (video && video.paused) {
          video.play().catch(() => {});
        }
      }
    } catch {}
  }

  /* ==========================================================================
     2. Social Media Feed Scrubbers (Facebook, Instagram, Twitter, Reddit)
     ========================================================================== */

  function processFacebook(): void {
    if (!isProtectionActive() || !moduleSettings.blockSocialAds) return;

    const feedUnits = document.querySelectorAll<HTMLElement>('div[data-pagelet^="FeedUnit"]:not([data-cb-processed]), div[role="feed"] > div:not([data-cb-processed])');
    for (const post of feedUnits) {
      if (!post) continue;
      post.dataset.cbProcessed = 'true';

      let isSponsored = false;
      if (post.querySelector('a[href*="/ads/about"], a[href*="ads/about"]')) {
        isSponsored = true;
      } else if (post.querySelector('[aria-label="Sponsored"], [aria-label="Gesponsert"], [aria-label="Publicidad"], [aria-label="Sponsorisé"]')) {
        isSponsored = true;
      } else {
        const textElements = post.querySelectorAll('span, a');
        for (const el of textElements) {
          const text = (el?.textContent || '').trim().toLowerCase();
          if (text === 'sponsored' || text === 'gesponsert' || text === 'publicidad' || text.startsWith('sponsored ·')) {
            isSponsored = true;
            break;
          }
        }
      }

      if (isSponsored) {
        post.classList.add('cb-hidden-ad');
        post.style.setProperty('display', 'none', 'important');
        recordAdBlocked(1);
      }
    }

    // Right-rail sponsored widgets
    const sidebarAds = document.querySelectorAll<HTMLElement>('div[role="complementary"] div:has(a[href*="/ads/about"]):not([data-cb-processed]), div[aria-label="Advertiser"]:not([data-cb-processed])');
    for (const ad of sidebarAds) {
      if (ad) {
        ad.dataset.cbProcessed = 'true';
        ad.classList.add('cb-hidden-ad');
        ad.style.setProperty('display', 'none', 'important');
        recordAdBlocked(1);
      }
    }
  }

  function processInstagram(): void {
    if (!isProtectionActive() || !moduleSettings.blockSocialAds) return;

    const articles = document.querySelectorAll<HTMLElement>('article:not([data-cb-processed])');
    for (const article of articles) {
      if (!article) continue;
      article.dataset.cbProcessed = 'true';

      const text = (article.textContent || '').toLowerCase();
      if (text.includes('sponsored') || text.includes('paid partnership with')) {
        article.classList.add('cb-hidden-ad');
        article.style.setProperty('display', 'none', 'important');
        recordAdBlocked(1);
      }
    }
  }

  function processTwitter(): void {
    if (!isProtectionActive() || !moduleSettings.blockSocialAds) return;

    const tweets = document.querySelectorAll<HTMLElement>('article:not([data-cb-processed])');
    for (const tweet of tweets) {
      if (!tweet) continue;
      tweet.dataset.cbProcessed = 'true';

      if (tweet.querySelector('[data-testid="placementTracking"]') || tweet.innerText?.includes('Ad\n') || tweet.innerText?.includes('Promoted')) {
        tweet.style.setProperty('display', 'none', 'important');
        recordAdBlocked(1);
      }
    }
  }

  function processReddit(): void {
    if (!isProtectionActive() || !moduleSettings.blockSocialAds) return;

    const posts = document.querySelectorAll<HTMLElement>('shreddit-post[is-promoted="true"]:not([data-cb-processed]), .promotedlink:not([data-cb-processed])');
    for (const post of posts) {
      if (post) {
        post.dataset.cbProcessed = 'true';
        post.style.setProperty('display', 'none', 'important');
        recordAdBlocked(1);
      }
    }
  }

  /* ==========================================================================
     3. General Web Ads, Streaming Video & Cookie Notices
     ========================================================================== */

  const COMMON_WEB_AD_SELECTORS = [
    'ins.adsbygoogle',
    'iframe[id^="aswift_"]',
    'iframe[id^="google_ads_frame"]',
    'div[id^="google_ads_iframe"]',
    'div[id^="div-gpt-ad"]',
    '[class*="gpt-ad"]',
    '[data-ad-unit]',
    '[data-ad-slot]',
    '[data-ad-client]',
    '[data-ad-zone]',
    '[class*="ad-container"]',
    '[class*="ad-wrapper"]',
    '[class*="ad-banner"]',
    '[class*="ad_banner"]',
    '[class*="ad-placement"]',
    '[class*="ad-slot"]',
    '[class*="ad_slot"]',
    '[class*="ad_container"]',
    '[class*="advertisement"]',
    '[id*="advertisement"]',
    '[class*="sponsor-banner"]',
    '[class*="sponsored-post"]',
    '[data-google-query-id]',
    '.OUTBRAIN',
    '[id^="outbrain_widget"]',
    '.trc_related_container',
    '.trc_rbox_div',
    '[id^="taboola-"]',
    '.tbl-feed-container',
    '.revcontent',
    '.mgid',
    '[class*="popup-ad"]',
    '[class*="ad-popup"]',
    '[id*="ad-modal"]',
    '[id*="ad_popup"]'
  ];

  const COOKIE_BANNER_SELECTORS = [
    '#onetrust-consent-sdk',
    '#CybotCookiebotDialog',
    '.cc-banner',
    '.cc-window',
    '#cookie-law-info-bar',
    '.cookie-notice-container'
  ];

  function processGeneralWeb(): void {
    if (!isProtectionActive()) return;

    for (const selector of COMMON_WEB_AD_SELECTORS) {
      try {
        const matches = document.querySelectorAll<HTMLElement>(selector + ':not([data-cb-processed])');
        for (const el of matches) {
          if (el) {
            el.dataset.cbProcessed = 'true';
            el.style.setProperty('display', 'none', 'important');
            recordAdBlocked(1);
          }
        }
      } catch {}
    }

    if (moduleSettings.blockCookieBanners) {
      for (const selector of COOKIE_BANNER_SELECTORS) {
        try {
          const matches = document.querySelectorAll<HTMLElement>(selector + ':not([data-cb-processed])');
          for (const el of matches) {
            if (el) {
              el.dataset.cbProcessed = 'true';
              el.style.setProperty('display', 'none', 'important');
              recordAdBlocked(1);
            }
          }
        } catch {}
      }
    }
  }

  function processGenericVideoAds(): void {
    triggerSkipButtons(document);

    const videoAdContainers = document.querySelectorAll<HTMLElement>('.video-ads, [class*="video-ad"], [class*="ad-player"], .ima-ad-container');
    for (const container of videoAdContainers) {
      const video = container.querySelector('video');
      if (video && !video.muted) {
        video.dataset.cbWasMuted = 'true';
        video.muted = true;
      }
      triggerSkipButtons(container);
    }
  }

  /**
   * Main scan routine - routes according to current website
   */
  function runScan(): void {
    if (!isProtectionActive()) return;

    if (isYouTubeSite) {
      handleYouTubeAds();
    } else {
      if (hostname.includes('facebook.com')) {
        processFacebook();
      } else if (hostname.includes('instagram.com')) {
        processInstagram();
      } else if (hostname.includes('twitter.com') || hostname.includes('x.com')) {
        processTwitter();
      } else if (hostname.includes('reddit.com')) {
        processReddit();
      } else {
        processGeneralWeb();
      }
      processGenericVideoAds();
    }
  }

  /* ==========================================================================
     4. Interactive Element Picker
     ========================================================================== */

  function computeUniqueSelector(element: HTMLElement): string {
    if (!element || element === document.body || element === document.documentElement) return '';

    if (element.id && !element.id.match(/\d{4,}/)) {
      return `#${CSS.escape(element.id)}`;
    }

    const cleanClasses = Array.from(element.classList).filter(c => !c.startsWith('cb-') && !c.match(/\d{4,}/));
    if (cleanClasses.length > 0) {
      return `${element.tagName.toLowerCase()}.${cleanClasses.map(c => CSS.escape(c)).join('.')}`;
    }

    const parent = element.parentElement;
    if (!parent) return element.tagName.toLowerCase();

    const sameTagSiblings = Array.from(parent.children).filter(child => child.tagName === element.tagName);
    if (sameTagSiblings.length === 1) {
      return `${computeUniqueSelector(parent)} > ${element.tagName.toLowerCase()}`;
    }

    const childIndex = sameTagSiblings.indexOf(element) + 1;
    return `${computeUniqueSelector(parent)} > ${element.tagName.toLowerCase()}:nth-of-type(${childIndex})`;
  }

  function onPickerMouseOver(event: MouseEvent): void {
    if (!isPickerActive) return;
    const target = event.target as HTMLElement | null;
    if (!target || target.closest('.cb-picker-hud')) return;

    if (hoveredElement) {
      hoveredElement.classList.remove('cb-picker-highlight');
    }
    hoveredElement = target;
    hoveredElement.classList.add('cb-picker-highlight');
  }

  function onPickerMouseOut(): void {
    if (!isPickerActive) return;
    if (hoveredElement) {
      hoveredElement.classList.remove('cb-picker-highlight');
      hoveredElement = null;
    }
  }

  function onPickerClick(event: MouseEvent): void {
    if (!isPickerActive) return;
    const target = event.target as HTMLElement | null;
    if (target && target.closest('.cb-picker-hud')) return;

    event.preventDefault();
    event.stopPropagation();

    const selected = hoveredElement || target;
    if (!selected) return;

    const selector = computeUniqueSelector(selected);
    if (selector) {
      selected.style.setProperty('display', 'none', 'important');
      recordAdBlocked(1);

      chrome.runtime.sendMessage({
        type: 'ADD_CUSTOM_FILTER',
        domain: hostname,
        selector
      }, (response) => {
        if (response?.customFilters) {
          customFilters = response.customFilters;
          applyCustomFilters();
        }
      });
    }

    stopElementPicker();
  }

  function onPickerKeyDown(event: KeyboardEvent): void {
    if (event.key === 'Escape' && isPickerActive) {
      stopElementPicker();
    }
  }

  function startElementPicker(): void {
    if (isPickerActive) return;
    isPickerActive = true;

    pickerHud = document.createElement('div');
    pickerHud.className = 'cb-picker-hud';
    pickerHud.innerHTML = `
      <div class="cb-picker-hud-info">
        <span class="cb-picker-hud-title">Chrome Blocks Picker</span>
        <span class="cb-picker-hud-sub">Click any element to permanently block it (Esc to cancel)</span>
      </div>
      <button class="cb-picker-hud-btn" id="cb-cancel-picker">Cancel</button>
    `;
    document.body.appendChild(pickerHud);

    document.getElementById('cb-cancel-picker')?.addEventListener('click', stopElementPicker);

    document.addEventListener('mouseover', onPickerMouseOver, true);
    document.addEventListener('mouseout', onPickerMouseOut, true);
    document.addEventListener('click', onPickerClick, true);
    document.addEventListener('keydown', onPickerKeyDown, true);
  }

  function stopElementPicker(): void {
    if (!isPickerActive) return;
    isPickerActive = false;

    if (hoveredElement) {
      hoveredElement.classList.remove('cb-picker-highlight');
      hoveredElement = null;
    }

    if (pickerHud) {
      pickerHud.remove();
      pickerHud = null;
    }

    document.removeEventListener('mouseover', onPickerMouseOver, true);
    document.removeEventListener('mouseout', onPickerMouseOut, true);
    document.removeEventListener('click', onPickerClick, true);
    document.removeEventListener('keydown', onPickerKeyDown, true);
  }

  /* ==========================================================================
     5. Lifecycle, Observers & Storage Sync
     ========================================================================== */

  function startProtection(): void {
    updateCosmeticClass();
    runScan();

    if (!domObserver && (document.body || document.documentElement)) {
      let rAF: number | null = null;
      domObserver = new MutationObserver(() => {
        if (!rAF) {
          rAF = requestAnimationFrame(() => {
            rAF = null;
            if (isYouTubeSite) {
              handleYouTubeAds();
            } else {
              runScan();
            }
          });
        }
      });

      domObserver.observe(document.body || document.documentElement, {
        childList: true,
        subtree: true,
        attributes: true,
        attributeFilter: ['class']
      });
    }

    // Lightweight safety interval for YouTube (500ms)
    if (isYouTubeSite && !youtubeSafetyTimer) {
      youtubeSafetyTimer = setInterval(() => {
        if (isProtectionActive()) {
          handleYouTubeAds();
        }
      }, 500);
    }
  }

  function stopProtection(): void {
    updateCosmeticClass();
    flushPendingBlockedCount();

    if (domObserver) {
      domObserver.disconnect();
      domObserver = null;
    }

    if (youtubeSafetyTimer) {
      clearInterval(youtubeSafetyTimer);
      youtubeSafetyTimer = null;
    }

    const hiddenElements = document.querySelectorAll<HTMLElement>('.cb-hidden-ad, [data-cb-processed]');
    for (const el of hiddenElements) {
      el.style.removeProperty('display');
    }
  }

  function init(): void {
    if (!chrome.storage || !chrome.storage.local) {
      startProtection();
      return;
    }

    // Load user settings
    chrome.storage.local.get(['isEnabled', 'whitelistedDomains', 'customFilters', 'moduleSettings'], (res: StorageData) => {
      if (chrome.runtime.lastError) {
        startProtection();
        return;
      }

      if (res.isEnabled !== undefined) isEnabled = Boolean(res.isEnabled);
      if (Array.isArray(res.whitelistedDomains)) whitelistedDomains = res.whitelistedDomains;
      if (res.customFilters) customFilters = res.customFilters;
      if (res.moduleSettings) moduleSettings = { ...moduleSettings, ...res.moduleSettings };

      if (isProtectionActive()) {
        startProtection();
      } else {
        stopProtection();
      }
    });

    // Real-time synchronization when user toggles settings
    chrome.storage.onChanged.addListener((changes, areaName) => {
      if (areaName !== 'local') return;

      let stateChanged = false;

      if (changes.isEnabled) {
        isEnabled = Boolean(changes.isEnabled.newValue);
        stateChanged = true;
      }

      if (changes.whitelistedDomains) {
        whitelistedDomains = (changes.whitelistedDomains.newValue as string[]) || [];
        stateChanged = true;
      }

      if (changes.customFilters) {
        customFilters = (changes.customFilters.newValue as CustomFilters) || {};
        applyCustomFilters();
      }

      if (changes.moduleSettings && typeof changes.moduleSettings.newValue === 'object') {
        moduleSettings = { ...moduleSettings, ...(changes.moduleSettings.newValue as Partial<ModuleSettings>) };
      }

      if (stateChanged) {
        if (isProtectionActive()) {
          startProtection();
        } else {
          stopProtection();
        }
      }
    });

    // Handle messages from popup
    chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
      if (message.type === 'GET_TAB_STATS') {
        const response: TabStatsResponse = {
          domain: hostname,
          blockedOnPage: blockedCountOnPage,
          isWhitelisted: isSiteWhitelisted(),
          isEnabled: isProtectionActive()
        };
        sendResponse(response);
      } else if (message.type === 'START_ELEMENT_PICKER') {
        startElementPicker();
        sendResponse({ success: true });
      }
      return true;
    });

    // Re-trigger on SPA navigation
    if (isYouTubeSite) {
      window.addEventListener('yt-navigate-finish', () => {
        handleYouTubeAds();
      }, { passive: true });
      window.addEventListener('spfdone', () => {
        handleYouTubeAds();
      }, { passive: true });
    } else {
      window.addEventListener('popstate', runScan, { passive: true });
    }
  }

  // Ensure DOM is ready before initial execution
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init, { once: true });
  } else {
    init();
  }

  // Flush metrics on tab unload
  window.addEventListener('beforeunload', flushPendingBlockedCount);
})();
