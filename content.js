/**
 * Chrome Blocks - Core Content Script
 * 
 * High-performance universal ad destruction and auto-click engine.
 * - Universal auto-clicker with multi-event firing (pointerdown, mousedown, mouseup, click)
 * - Zero-display ad hiding (visual shield) across YouTube, Facebook, Instagram, and web portals
 * - Seamless video performance: instant mute, 16x speed-up, and end-of-ad seek
 */

(() => {
  'use strict';

  // --- Extension State & Preferences ---
  let isEnabled = true;
  let whitelistedDomains = [];
  let customFilters = {};
  let moduleSettings = {
    blockYouTubeAds: true,
    blockSocialAds: true,
    blockCookieBanners: true
  };

  // --- Telemetry Sync ---
  let blockedCountOnPage = 0;
  let pendingCountToSync = 0;
  let syncTimer = null;

  // --- Observers & Intervals ---
  let observer = null;
  let youtubeInterval = null;

  // --- Element Picker State ---
  let isPickerActive = false;
  let hoveredElement = null;
  let pickerHud = null;

  const hostname = window.location.hostname.toLowerCase();
  const isYouTubeSite = hostname.includes('youtube.com');

  /**
   * Check if current site is on user whitelist
   */
  function isSiteWhitelisted() {
    return whitelistedDomains.some(domain => {
      const d = domain.toLowerCase().trim();
      return hostname === d || hostname.endsWith('.' + d);
    });
  }

  /**
   * Determine if ad-blocking protection is currently active
   */
  function isProtectionActive() {
    return isEnabled && !isSiteWhitelisted();
  }

  /**
   * Queue ad block telemetry and flush with debounce to avoid IPC storms
   */
  function recordAdBlocked(count = 1) {
    if (count <= 0) return;
    blockedCountOnPage += count;
    pendingCountToSync += count;

    if (!syncTimer) {
      syncTimer = setTimeout(flushPendingBlockedCount, 1500);
    }
  }

  function flushPendingBlockedCount() {
    syncTimer = null;
    if (pendingCountToSync > 0) {
      const count = pendingCountToSync;
      pendingCountToSync = 0;
      try {
        if (chrome.runtime?.id) {
          chrome.runtime.sendMessage({
            type: 'AD_BLOCKED',
            count: count,
            domain: hostname
          }).catch(() => {});
        }
      } catch (e) {}
    }
  }

  /**
   * Toggle cosmetic suppression class on HTML root element
   */
  function updateCosmeticClass() {
    if (isProtectionActive()) {
      document.documentElement.classList.remove('cb-disabled');
      applyCustomFilters();
    } else {
      document.documentElement.classList.add('cb-disabled');
      removeCustomFilters();
    }
  }

  /**
   * Inject user-defined custom CSS filter rules
   */
  function applyCustomFilters() {
    if (!isProtectionActive()) return;

    let styleEl = document.getElementById('cb-custom-filters-style');
    const domainFilters = [];

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

  function removeCustomFilters() {
    const styleEl = document.getElementById('cb-custom-filters-style');
    if (styleEl) styleEl.remove();
  }

  /* ==========================================================================
     1. Universal Multi-Event Auto-Clicker & Skip Engine
     ========================================================================== */

  /**
   * Dispatches full multi-event sequence to bypass framework event listener gates
   */
  function forceClickElement(element) {
    if (!element) return;

    try {
      element.focus?.();
    } catch (e) {}

    // Dispatch full pointer and mouse sequences (mousedown, mouseup, click)
    const events = ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click'];
    for (const evt of events) {
      try {
        element.dispatchEvent(new MouseEvent(evt, {
          bubbles: true,
          cancelable: true,
          view: window
        }));
      } catch (e) {}
    }

    // Programmatically invoke .click()
    try {
      element.click();
    } catch (e) {}
  }

  // Universal skip button selectors across YouTube and streaming video platforms
  const UNIVERSAL_SKIP_SELECTORS = [
    // YouTube specific skip variants
    '.ytp-ad-skip-button',
    '.ytp-ad-skip-button-modern',
    '.ytp-skip-ad-button',
    '.ytp-ad-skip-button-slot button',
    '.ytp-ad-skip-button-slot',
    '.ytp-ad-skip-button-container button',
    'button.ytp-ad-skip-button',
    'button.ytp-ad-skip-button-modern',
    '.videoAdUiSkipButton',
    '[id^="skip-button:"] button',
    'button[class*="ytp-ad-skip-button"]',
    'button[class*="ytp-skip-ad-button"]',
    '.ytp-ad-overlay-close-button',
    // Universal HTML5 video player skip selectors (news sites, videojs, streaming platforms)
    '.video-ad-skip',
    '.video-ad-skip-button',
    '.skip-ad-button',
    '.skip-ad',
    '.ad-skip-btn',
    '.ad-skip-button',
    '.btn-skip-ad',
    'button.skip',
    'button[class*="skip-ad"]',
    'button[class*="skipAd"]',
    'button[class*="ad-skip"]',
    'div[class*="skip-button"]',
    'div[class*="ad-skip"]',
    '[aria-label*="Skip Ad" i]',
    '[aria-label*="Skip ad" i]',
    '[aria-label="Skip"]',
    '[aria-label*="skip" i]'
  ];

  /**
   * Scans a container or the document for any skip button variant and clicks it immediately
   */
  function scanAndClickSkipButtons(container = document) {
    let clicked = false;

    // 1. Selector-based instant matching
    for (const selector of UNIVERSAL_SKIP_SELECTORS) {
      try {
        const buttons = container.querySelectorAll(selector);
        for (const btn of buttons) {
          if (btn) {
            forceClickElement(btn);
            recordAdBlocked(1);
            clicked = true;
            break;
          }
        }
      } catch (e) {}
      if (clicked) return true;
    }

    // 2. Text-based scan in player overlays or buttons (supports multilingual "Skip" / "বিজ্ঞাপন এড়িয়ে যান")
    try {
      const candidateButtons = container.querySelectorAll('.video-ads button, .video-ads [role="button"], .ytp-ad-player-overlay button, .video-ad-container button, [class*="player"] button');
      for (const el of candidateButtons) {
        const text = (el.textContent || '').trim().toLowerCase();
        if (text === 'skip' || text === 'skip ad' || text === 'skip ads' || text.includes('skip ad') || text.includes('বিজ্ঞাপন এড়িয়ে যান')) {
          forceClickElement(el);
          recordAdBlocked(1);
          clicked = true;
          break;
        }
      }
    } catch (e) {}

    return clicked;
  }

  /* ==========================================================================
     2. Dedicated YouTube Ad Destroyer & Zero-Display Visual Shield
     ========================================================================== */

  const YOUTUBE_AD_CONTAINERS = [
    '#player-ads',
    '.ytp-ad-overlay-container',
    '.ytp-ad-message-container',
    '.ytp-ad-action-interstitial',
    'ytd-ad-slot-renderer',
    '#masthead-ad',
    'ytd-banner-promo-renderer'
  ];

  function processYouTube() {
    if (!isProtectionActive() || !moduleSettings.blockYouTubeAds) return;

    const player = document.getElementById('movie_player') || document.querySelector('.html5-video-player');
    const isAdShowing = player && (
      player.classList.contains('ad-showing') ||
      player.classList.contains('ad-interrupting')
    );

    const video = document.querySelector('video.html5-main-video') || (player ? player.querySelector('video') : document.querySelector('video'));

    if (isAdShowing) {
      // Zero-Display Visual Shield: Hide player ad overlays immediately so user sees nothing
      try {
        const overlays = player.querySelectorAll('.ytp-ad-player-overlay, .ytp-ad-player-overlay-layout, .ytp-ad-text-overlay, .ytp-ad-image-overlay, #player-ads');
        for (const ov of overlays) {
          ov.style.setProperty('display', 'none', 'important');
        }
      } catch (e) {}

      if (video) {
        // 1. Instantly mute audio so user never hears ad audio
        if (!video.muted) {
          video.dataset.cbWasMuted = 'true';
          video.muted = true;
        }

        // 2. Accelerate ad to 16x speed
        video.dataset.cbAdSpeedModified = 'true';
        video.playbackRate = 16.0;

        // 3. Jump to the end of the ad segment
        if (Number.isFinite(video.duration) && video.duration > 0) {
          video.currentTime = video.duration;
        }

        // Ensure video is playing so YouTube triggers ad conclusion
        if (video.paused) {
          video.play().catch(() => {});
        }

        recordAdBlocked(1);
      }

      // 4. Force-click any visible skip buttons with multi-events
      scanAndClickSkipButtons(player);

      // 5. Native player skip hook
      if (player && typeof player.skipAd === 'function') {
        try {
          player.skipAd();
        } catch (e) {}
      }
    } else if (video && video.dataset.cbAdSpeedModified) {
      // Ad has ended! Cleanly restore normal video playback speed and un-mute
      delete video.dataset.cbAdSpeedModified;
      video.playbackRate = 1.0;

      if (video.dataset.cbWasMuted === 'true') {
        delete video.dataset.cbWasMuted;
        video.muted = false;
      }

      if (video.paused) {
        video.play().catch(() => {});
      }
    }

    // Hide cosmetic companion ad containers (Zero-Display Shield)
    for (const selector of YOUTUBE_AD_CONTAINERS) {
      try {
        const elements = document.querySelectorAll(selector);
        for (const el of elements) {
          if (!el.dataset.cbProcessed) {
            el.dataset.cbProcessed = 'true';
            el.style.setProperty('display', 'none', 'important');
            recordAdBlocked(1);
          }
        }
      } catch (e) {}
    }

    // Dismiss Anti-Adblock modal dialog if triggered
    try {
      const modal = document.querySelector('tp-yt-paper-dialog:has(ytd-enforcement-message-view-model), ytd-enforcement-message-view-model');
      if (modal) {
        modal.remove();
        if (video && video.paused) {
          video.play().catch(() => {});
        }
      }
    } catch (e) {}
  }

  /* ==========================================================================
     3. Social Media Feed Scrubbers (Zero-Display Visual Shield)
     ========================================================================== */

  function processFacebook() {
    if (!isProtectionActive() || !moduleSettings.blockSocialAds) return;

    // Feed units & posts
    const feedUnits = document.querySelectorAll('div[data-pagelet^="FeedUnit"]:not([data-cb-processed]), div[role="feed"] > div:not([data-cb-processed])');
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

    // Right-column sidebar ads
    const sidebarAds = document.querySelectorAll('div[role="complementary"] div:has(a[href*="/ads/about"]):not([data-cb-processed]), div[aria-label="Advertiser"]:not([data-cb-processed])');
    for (const ad of sidebarAds) {
      if (ad) {
        ad.dataset.cbProcessed = 'true';
        ad.classList.add('cb-hidden-ad');
        ad.style.setProperty('display', 'none', 'important');
        recordAdBlocked(1);
      }
    }
  }

  function processInstagram() {
    if (!isProtectionActive() || !moduleSettings.blockSocialAds) return;

    const articles = document.querySelectorAll('article:not([data-cb-processed])');
    for (const article of articles) {
      if (!article) continue;
      article.dataset.cbProcessed = 'true';

      const text = (article?.textContent || '').toLowerCase();
      if (text.includes('sponsored') || text.includes('paid partnership with')) {
        article.classList.add('cb-hidden-ad');
        article.style.setProperty('display', 'none', 'important');
        recordAdBlocked(1);
      }
    }
  }

  function processTwitter() {
    if (!isProtectionActive() || !moduleSettings.blockSocialAds) return;

    const tweets = document.querySelectorAll('article:not([data-cb-processed])');
    for (const tweet of tweets) {
      if (!tweet) continue;
      tweet.dataset.cbProcessed = 'true';

      if (tweet.querySelector('[data-testid="placementTracking"]') || tweet.innerText?.includes('Ad\n') || tweet.innerText?.includes('Promoted')) {
        tweet.style.setProperty('display', 'none', 'important');
        recordAdBlocked(1);
      }
    }
  }

  function processReddit() {
    if (!isProtectionActive() || !moduleSettings.blockSocialAds) return;

    const posts = document.querySelectorAll('shreddit-post[is-promoted="true"]:not([data-cb-processed]), .promotedlink:not([data-cb-processed])');
    for (const post of posts) {
      if (post) {
        post.dataset.cbProcessed = 'true';
        post.style.setProperty('display', 'none', 'important');
        recordAdBlocked(1);
      }
    }
  }

  /* ==========================================================================
     4. General Web Ads, Video Portals & Cookie Notices
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

  function processGeneralWeb() {
    if (!isProtectionActive()) return;

    for (const selector of COMMON_WEB_AD_SELECTORS) {
      try {
        const matches = document.querySelectorAll(selector + ':not([data-cb-processed])');
        for (const el of matches) {
          if (el) {
            el.dataset.cbProcessed = 'true';
            el.style.setProperty('display', 'none', 'important');
            recordAdBlocked(1);
          }
        }
      } catch (e) {}
    }

    if (moduleSettings.blockCookieBanners) {
      for (const selector of COOKIE_BANNER_SELECTORS) {
        try {
          const matches = document.querySelectorAll(selector + ':not([data-cb-processed])');
          for (const el of matches) {
            if (el) {
              el.dataset.cbProcessed = 'true';
              el.style.setProperty('display', 'none', 'important');
              recordAdBlocked(1);
            }
          }
        } catch (e) {}
      }
    }
  }

  /**
   * Universal HTML5 Video Player Ad Interceptor (for news sites & web video players)
   */
  function processGenericVideoAds() {
    // Scan and auto-click any visible skip buttons across the page
    scanAndClickSkipButtons(document);

    // Accelerate and skip video ads in generic video containers
    const videoAdContainers = document.querySelectorAll('.video-ads, [class*="video-ad"], [class*="ad-player"], .ima-ad-container');
    for (const container of videoAdContainers) {
      const video = container.querySelector('video');
      if (video) {
        if (!video.muted) {
          video.dataset.cbWasMuted = 'true';
          video.muted = true;
        }
        video.dataset.cbAdSpeedModified = 'true';
        video.playbackRate = 16.0;
        if (Number.isFinite(video.duration) && video.duration > 0) {
          video.currentTime = video.duration;
        }
        scanAndClickSkipButtons(container);
      }
    }
  }

  /**
   * Main scan router
   */
  function runScan() {
    if (!isProtectionActive()) return;

    if (isYouTubeSite) {
      processYouTube();
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
     5. Interactive Element Picker
     ========================================================================== */

  function computeUniqueSelector(element) {
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

  function onPickerMouseOver(event) {
    if (!isPickerActive) return;
    const target = event.target;
    if (!target || target.closest('.cb-picker-hud')) return;

    if (hoveredElement) {
      hoveredElement.classList.remove('cb-picker-highlight');
    }
    hoveredElement = target;
    hoveredElement.classList.add('cb-picker-highlight');
  }

  function onPickerMouseOut() {
    if (!isPickerActive) return;
    if (hoveredElement) {
      hoveredElement.classList.remove('cb-picker-highlight');
      hoveredElement = null;
    }
  }

  function onPickerClick(event) {
    if (!isPickerActive) return;
    if (event.target && event.target.closest('.cb-picker-hud')) return;

    event.preventDefault();
    event.stopPropagation();

    const selected = hoveredElement || event.target;
    if (!selected) return;

    const selector = computeUniqueSelector(selected);
    if (selector) {
      selected.style.setProperty('display', 'none', 'important');
      recordAdBlocked(1);

      chrome.runtime.sendMessage({
        type: 'ADD_CUSTOM_FILTER',
        domain: hostname,
        selector: selector
      }, (response) => {
        if (response?.customFilters) {
          customFilters = response.customFilters;
          applyCustomFilters();
        }
      });
    }

    stopElementPicker();
  }

  function onPickerKeyDown(event) {
    if (event.key === 'Escape' && isPickerActive) {
      stopElementPicker();
    }
  }

  function startElementPicker() {
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

  function stopElementPicker() {
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
     6. Lifecycle, Observers & Storage Sync
     ========================================================================== */

  function startProtection() {
    updateCosmeticClass();
    runScan();

    // High-performance MutationObserver watching for ad insertions and player class changes
    if (!observer && (document.body || document.documentElement)) {
      let rAF = null;
      observer = new MutationObserver(() => {
        if (isYouTubeSite) {
          processYouTube();
        } else {
          if (!rAF) {
            rAF = requestAnimationFrame(() => {
              rAF = null;
              runScan();
            });
          }
        }
      });

      observer.observe(document.body || document.documentElement, {
        childList: true,
        subtree: true,
        attributes: true,
        attributeFilter: ['class']
      });
    }

    // Safety fallback interval for YouTube (250ms)
    if (isYouTubeSite && !youtubeInterval) {
      youtubeInterval = setInterval(() => {
        if (isProtectionActive()) {
          processYouTube();
        }
      }, 250);
    }
  }

  function stopProtection() {
    updateCosmeticClass();
    flushPendingBlockedCount();

    if (observer) {
      observer.disconnect();
      observer = null;
    }

    if (youtubeInterval) {
      clearInterval(youtubeInterval);
      youtubeInterval = null;
    }

    const hiddenElements = document.querySelectorAll('.cb-hidden-ad, [data-cb-processed]');
    for (const el of hiddenElements) {
      el.style.removeProperty('display');
    }
  }

  function init() {
    if (!chrome.storage || !chrome.storage.local) {
      startProtection();
      return;
    }

    // Load user settings
    chrome.storage.local.get(['isEnabled', 'whitelistedDomains', 'customFilters', 'moduleSettings'], (res) => {
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
        whitelistedDomains = changes.whitelistedDomains.newValue || [];
        stateChanged = true;
      }

      if (changes.customFilters) {
        customFilters = changes.customFilters.newValue || {};
        applyCustomFilters();
      }

      if (changes.moduleSettings) {
        moduleSettings = { ...moduleSettings, ...changes.moduleSettings.newValue };
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
    chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
      if (message.type === 'GET_TAB_STATS') {
        sendResponse({
          domain: hostname,
          blockedOnPage: blockedCountOnPage,
          isWhitelisted: isSiteWhitelisted(),
          isEnabled: isProtectionActive()
        });
      } else if (message.type === 'START_ELEMENT_PICKER') {
        startElementPicker();
        sendResponse({ success: true });
      }
      return true;
    });

    // Re-trigger on SPA navigation
    if (isYouTubeSite) {
      window.addEventListener('yt-navigate-finish', () => {
        processYouTube();
      }, { passive: true });
      window.addEventListener('spfdone', () => {
        processYouTube();
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
