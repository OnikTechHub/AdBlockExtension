/**
 * Chrome Blocks - Content Script
 * High-performance, glitch-free ad, tracker, social sponsored post, and element picker engine.
 * Advanced YouTube ad bypass with instant skip-clicking, 16x fast-forward, and sidebar/feed sponsored ad removal.
 */

(() => {
  'use strict';

  // State management
  let isEnabled = true;
  let whitelistedDomains = [];
  let customFilters = {}; // { hostname: [selectors...] }
  let moduleSettings = {
    blockYouTubeAds: true,
    blockSocialAds: true,
    blockCookieBanners: true
  };

  let blockedCountOnPage = 0;
  let pendingCountToSync = 0;
  let isProcessing = false;
  let syncTimer = null;
  let observer = null;
  let youtubeInterval = null;
  let youtubeObserver = null;
  let isYouTubeAdPlaying = false;

  // Element Picker State
  let isPickerActive = false;
  let hoveredElement = null;
  let pickerHud = null;

  const hostname = window.location.hostname.toLowerCase();

  /**
   * Check if current site is whitelisted
   */
  function isSiteWhitelisted() {
    return whitelistedDomains.some(domain => {
      const d = domain.toLowerCase().trim();
      return hostname === d || hostname.endsWith('.' + d);
    });
  }

  /**
   * Determine if protection should be active on current page
   */
  function isProtectionActive() {
    return isEnabled && !isSiteWhitelisted();
  }

  /**
   * Queue ad block count to be synchronized with background script
   */
  function recordAdBlocked(count = 1) {
    if (count <= 0) return;
    blockedCountOnPage += count;
    pendingCountToSync += count;

    if (!syncTimer) {
      syncTimer = setTimeout(flushPendingBlockedCount, 1200);
    }
  }

  /**
   * Flush pending blocked count to background script
   */
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
   * Update root CSS class to control cosmetic rules
   */
  function updateCosmeticClass() {
    const active = isProtectionActive();
    if (active) {
      document.documentElement.classList.remove('cb-disabled');
      applyCustomFilters();
    } else {
      document.documentElement.classList.add('cb-disabled');
      removeCustomFilters();
    }
  }

  /**
   * Apply user custom cosmetic filters for this domain
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
     Bulletproof YouTube Ad Bypass & Sidebar Sponsored Cleaner
     ========================================================================== */

  // Modern YouTube Skip Button Selectors
  const YOUTUBE_SKIP_SELECTORS = [
    '.ytp-ad-skip-button',
    '.ytp-ad-skip-button-modern',
    'button.ytp-ad-skip-button',
    'button.ytp-ad-skip-button-modern',
    '.ytp-skip-ad-button',
    '.ytp-ad-skip-button-slot button',
    '.ytp-ad-skip-button-container button',
    '[id^="skip-button:"] button',
    'button[class*="ytp-ad-skip-button"]',
    'button[class*="ytp-skip-ad-button"]',
    '.videoAdUiSkipButton',
    '.ytp-ad-skip-button-text'
  ];

  // YouTube Banner & Companion Selectors
  const YT_BANNER_SELECTORS = [
    '#player-ads',
    '.ytp-ad-overlay-container',
    '.ytp-ad-message-container',
    '.ytp-ad-action-interstitial',
    '.ytp-ad-image-overlay',
    '.ytp-ad-text-overlay',
    'ytd-promoted-sparkles-web-renderer',
    'ytd-promoted-video-renderer',
    'ytd-compact-promoted-video-renderer',
    'ytd-display-ad-renderer',
    'ytd-statement-banner-renderer',
    'ytd-in-feed-ad-layout-renderer',
    'ytd-banner-promo-renderer',
    '#masthead-ad',
    'ytd-video-masthead-ad-v3-renderer',
    'ytd-primetime-promo-renderer',
    'ytd-ad-slot-renderer',
    'ytd-action-companion-ad-renderer',
    'ytd-engagement-panel-section-list-renderer[target-id="engagement-panel-ads"]',
    '#secondary ytd-ad-slot-renderer',
    '#secondary-inner ytd-ad-slot-renderer',
    '.ytd-merch-shelf-renderer'
  ];

  /**
   * Synthetically triggers click and pointer events on skip button
   */
  function clickButtonSafely(el) {
    if (!el) return;
    try {
      el.click();
    } catch (e) {}

    try {
      ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click'].forEach(type => {
        el.dispatchEvent(new MouseEvent(type, {
          bubbles: true,
          cancelable: true,
          view: window
        }));
      });
    } catch (e) {}
  }

  /**
   * Find and click any skip buttons available in the DOM
   */
  function triggerSkipButtons() {
    for (const selector of YOUTUBE_SKIP_SELECTORS) {
      try {
        const buttons = document.querySelectorAll(selector);
        for (const btn of buttons) {
          clickButtonSafely(btn);
          recordAdBlocked(1);
          return true;
        }
      } catch (e) {}
    }
    return false;
  }

  /**
   * Remove sidebar sponsored videos, companion boxes, and items with "Sponsored" or "বিজ্ঞাপন"
   */
  function removeYouTubeSidebarAndBanners() {
    // 1. Selector-based instant removal
    for (const selector of YT_BANNER_SELECTORS) {
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

    // 2. Inspection of right-hand recommendation column and feeds for "Sponsored" or "বিজ্ঞাপন" badges
    const recommendationCards = document.querySelectorAll(
      '#secondary ytd-compact-video-renderer:not([data-cb-processed]), ' +
      '#related ytd-compact-video-renderer:not([data-cb-processed]), ' +
      'ytd-compact-video-renderer:not([data-cb-processed]), ' +
      'ytd-rich-item-renderer:not([data-cb-processed]), ' +
      'ytd-reel-video-renderer:not([data-cb-processed])'
    );

    for (const card of recommendationCards) {
      if (!card) continue;

      let isAd = false;

      // Check for nested ad slot or ad badge classes
      if (card.querySelector('ytd-ad-slot-renderer, [class*="badge-style-type-ad"], [aria-label*="Sponsored" i], [aria-label*="বিজ্ঞাপন"]')) {
        isAd = true;
      }

      // Check text content of badges inside the card
      if (!isAd) {
        const badges = card.querySelectorAll('.ytd-badge-supported-renderer, .badge-shape-wiz__text, #badges span, ytd-badge-supported-renderer span');
        for (const badge of badges) {
          const text = (badge.textContent || '').trim().toLowerCase();
          if (text === 'sponsored' || text === 'বিজ্ঞাপন' || text.includes('sponsored') || text.includes('বিজ্ঞাপন') || text === 'ad') {
            isAd = true;
            break;
          }
        }
      }

      if (isAd) {
        card.dataset.cbProcessed = 'true';
        card.style.setProperty('display', 'none', 'important');
        recordAdBlocked(1);
      }
    }

    // 3. Dismiss Anti-Adblock modal dialog if triggered
    try {
      const dialog = document.querySelector('tp-yt-paper-dialog:has(ytd-enforcement-message-view-model), ytd-enforcement-message-view-model');
      if (dialog) {
        dialog.remove();
        const video = document.querySelector('video');
        if (video && video.paused) {
          video.play().catch(() => {});
        }
      }
    } catch (e) {}
  }

  /**
   * Main YouTube Ad Neutralization Pass
   */
  function handleYouTubeAds() {
    if (!isProtectionActive() || !moduleSettings.blockYouTubeAds) return;

    const player = document.querySelector('#movie_player') || document.querySelector('.html5-video-player');
    const video = player ? player.querySelector('video') : document.querySelector('video');

    // Find any visible skip button in the DOM
    let skipBtn = null;
    for (const sel of YOUTUBE_SKIP_SELECTORS) {
      const found = document.querySelector(sel);
      if (found) {
        skipBtn = found;
        break;
      }
    }

    // Check whether an in-stream video ad is currently active
    const isAdShowing = Boolean(
      (player && (player.classList.contains('ad-showing') || player.classList.contains('ad-interrupting'))) ||
      document.querySelector('.ytp-ad-player-overlay, .ytp-ad-player-overlay-layout') ||
      skipBtn
    );

    if (isAdShowing) {
      isYouTubeAdPlaying = true;

      // 1. Immediately click any skip button available
      if (skipBtn) {
        clickButtonSafely(skipBtn);
        recordAdBlocked(1);
      } else {
        triggerSkipButtons();
      }

      // 2. Mute audio and fast-forward through ad video
      if (video) {
        if (!video.muted) {
          video.dataset.cbMuted = 'true';
          video.muted = true;
        }

        video.dataset.cbSpeedUp = 'true';
        video.playbackRate = 16.0;

        // Jump straight to the end of the ad stream
        if (isFinite(video.duration) && video.duration > 0) {
          if (video.currentTime < video.duration - 0.1) {
            video.currentTime = video.duration;
          }
        }

        if (video.paused) {
          video.play().catch(() => {});
        }

        recordAdBlocked(1);
      }

      // 3. Invoke internal player skipAd API if exposed
      if (player && typeof player.skipAd === 'function') {
        try {
          player.skipAd();
        } catch (e) {}
      }
    } else if (isYouTubeAdPlaying) {
      // Ad stream has ended! Cleanly restore normal video settings
      isYouTubeAdPlaying = false;

      if (video) {
        if (video.dataset.cbSpeedUp === 'true' || video.playbackRate > 2.0) {
          delete video.dataset.cbSpeedUp;
          video.playbackRate = 1.0;
        }
        if (video.dataset.cbMuted === 'true') {
          delete video.dataset.cbMuted;
          video.muted = false;
        }
        if (video.paused) {
          video.play().catch(() => {});
        }
      }
    }

    // 4. Eliminate sidebar, companion, and banner ads
    removeYouTubeSidebarAndBanners();
  }

  /**
   * Set up high-performance, throttled observer for YouTube
   */
  function setupYouTubeEngine() {
    if (!hostname.includes('youtube.com')) return;

    // Run immediate check
    handleYouTubeAds();

    // Throttled MutationObserver (coalesced via requestAnimationFrame)
    if (!youtubeObserver) {
      let rafPending = false;
      youtubeObserver = new MutationObserver(() => {
        if (!rafPending && isProtectionActive()) {
          rafPending = true;
          requestAnimationFrame(() => {
            rafPending = false;
            handleYouTubeAds();
          });
        }
      });

      // Observe the page for injected ad elements, skip buttons, and banners
      const target = document.querySelector('#content') || document.querySelector('ytd-app') || document.body || document.documentElement;
      if (target) {
        youtubeObserver.observe(target, {
          childList: true,
          subtree: true
        });
      }
    }

    // Steady heartbeat check (every 150ms)
    if (!youtubeInterval) {
      youtubeInterval = setInterval(() => {
        if (isProtectionActive()) {
          handleYouTubeAds();
        }
      }, 150);
    }
  }

  /* ==========================================================================
     Social Media Sponsored Removal Engines (FB, IG, X, Reddit)
     ========================================================================== */

  function processFacebook() {
    if (!isProtectionActive() || !moduleSettings.blockSocialAds) return;

    const posts = document.querySelectorAll('div[data-pagelet^="FeedUnit"], div[role="feed"] > div');
    for (const post of posts) {
      if (!post || post.dataset.cbProcessed) continue;

      let isSponsored = false;
      if (post.querySelector('a[href*="/ads/about"], a[href*="ads/about"]')) {
        isSponsored = true;
      }

      if (!isSponsored && post.querySelector('[aria-label="Sponsored"], [aria-label="Gesponsert"], [aria-label="Publicidad"], [aria-label="Sponsorisé"]')) {
        isSponsored = true;
      }

      if (!isSponsored) {
        const subSpans = post.querySelectorAll('span, a');
        for (const span of subSpans) {
          const text = (span.textContent || '').trim().toLowerCase();
          if (text === 'sponsored' || text === 'gesponsert' || text === 'publicidad' || text.startsWith('sponsored ·')) {
            isSponsored = true;
            break;
          }
        }
      }

      if (isSponsored) {
        post.dataset.cbProcessed = 'true';
        post.classList.add('cb-hidden-ad');
        post.style.setProperty('display', 'none', 'important');
        recordAdBlocked(1);
      }
    }

    const sideAds = document.querySelectorAll('div[role="complementary"] div:has(a[href*="/ads/about"]), div[aria-label="Advertiser"]');
    for (const ad of sideAds) {
      if (ad && !ad.dataset.cbProcessed) {
        ad.dataset.cbProcessed = 'true';
        ad.classList.add('cb-hidden-ad');
        ad.style.setProperty('display', 'none', 'important');
        recordAdBlocked(1);
      }
    }
  }

  function processInstagram() {
    if (!isProtectionActive() || !moduleSettings.blockSocialAds) return;

    const articles = document.querySelectorAll('article');
    for (const article of articles) {
      if (!article || article.dataset.cbProcessed) continue;

      let isSponsored = false;
      const text = (article.textContent || '').toLowerCase();
      if (text.includes('sponsored') || text.includes('paid partnership with')) {
        isSponsored = true;
      }

      if (isSponsored) {
        article.dataset.cbProcessed = 'true';
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
      if (tweet.querySelector('[data-testid="placementTracking"]') || tweet.innerText?.includes('Ad\n') || tweet.innerText?.includes('Promoted')) {
        tweet.dataset.cbProcessed = 'true';
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
     General Web & Cookie Banners
     ========================================================================== */

  const GENERAL_AD_SELECTORS = [
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
    '[class*="ad_wrapper"]',
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

    for (const selector of GENERAL_AD_SELECTORS) {
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

  function runScan() {
    if (!isProtectionActive() || isProcessing) return;
    isProcessing = true;

    try {
      if (hostname.includes('youtube.com')) {
        handleYouTubeAds();
      } else if (hostname.includes('facebook.com')) {
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
    } finally {
      isProcessing = false;
    }
  }

  /* ==========================================================================
     Interactive Element Picker Engine
     ========================================================================== */

  function getUniqueSelector(el) {
    if (!el || el === document.body || el === document.documentElement) return '';

    if (el.id && !el.id.match(/\d{4,}/)) {
      return `#${CSS.escape(el.id)}`;
    }

    const classes = Array.from(el.classList).filter(c => !c.startsWith('cb-') && !c.match(/\d{4,}/));
    if (classes.length > 0) {
      return `${el.tagName.toLowerCase()}.${classes.map(c => CSS.escape(c)).join('.')}`;
    }

    const parent = el.parentElement;
    if (!parent) return el.tagName.toLowerCase();

    const siblings = Array.from(parent.children).filter(child => child.tagName === el.tagName);
    if (siblings.length === 1) {
      return `${getUniqueSelector(parent)} > ${el.tagName.toLowerCase()}`;
    }

    const index = siblings.indexOf(el) + 1;
    return `${getUniqueSelector(parent)} > ${el.tagName.toLowerCase()}:nth-of-type(${index})`;
  }

  function onPickerMouseOver(e) {
    if (!isPickerActive) return;
    const target = e.target;
    if (!target || target.closest('.cb-picker-hud')) return;

    if (hoveredElement) {
      hoveredElement.classList.remove('cb-picker-highlight');
    }
    hoveredElement = target;
    hoveredElement.classList.add('cb-picker-highlight');
  }

  function onPickerMouseOut(e) {
    if (!isPickerActive) return;
    if (hoveredElement) {
      hoveredElement.classList.remove('cb-picker-highlight');
      hoveredElement = null;
    }
  }

  function onPickerClick(e) {
    if (!isPickerActive) return;
    if (e.target && e.target.closest('.cb-picker-hud')) return;

    e.preventDefault();
    e.stopPropagation();

    const target = hoveredElement || e.target;
    if (!target) return;

    const selector = getUniqueSelector(target);

    if (selector) {
      target.style.setProperty('display', 'none', 'important');
      recordAdBlocked(1);

      chrome.runtime.sendMessage({
        type: 'ADD_CUSTOM_FILTER',
        domain: hostname,
        selector: selector
      }, (res) => {
        if (res?.customFilters) {
          customFilters = res.customFilters;
          applyCustomFilters();
        }
      });
    }

    stopElementPicker();
  }

  function onPickerKeyDown(e) {
    if (e.key === 'Escape' && isPickerActive) {
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
     Lifecycle & Init
     ========================================================================== */

  function startProtection() {
    updateCosmeticClass();
    runScan();

    if (!observer && (document.body || document.documentElement)) {
      let rAF = null;
      observer = new MutationObserver(() => {
        if (!rAF) {
          rAF = requestAnimationFrame(() => {
            rAF = null;
            runScan();
          });
        }
      });

      observer.observe(document.body || document.documentElement, {
        childList: true,
        subtree: true
      });
    }

    if (hostname.includes('youtube.com')) {
      setupYouTubeEngine();
    }
  }

  function stopProtection() {
    updateCosmeticClass();
    flushPendingBlockedCount();

    if (observer) {
      observer.disconnect();
      observer = null;
    }

    if (youtubeObserver) {
      youtubeObserver.disconnect();
      youtubeObserver = null;
    }

    if (youtubeInterval) {
      clearInterval(youtubeInterval);
      youtubeInterval = null;
    }

    const hiddenEls = document.querySelectorAll('.cb-hidden-ad, [data-cb-processed]');
    for (const el of hiddenEls) {
      el.style.removeProperty('display');
    }
  }

  function init() {
    if (!chrome.storage || !chrome.storage.local) {
      startProtection();
      return;
    }

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

    // YouTube SPA navigation events
    if (hostname.includes('youtube.com')) {
      window.addEventListener('yt-navigate-finish', setupYouTubeEngine, { passive: true });
      window.addEventListener('spfdone', setupYouTubeEngine, { passive: true });
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init, { once: true });
  } else {
    init();
  }

  window.addEventListener('beforeunload', () => {
    flushPendingBlockedCount();
  });
})();
