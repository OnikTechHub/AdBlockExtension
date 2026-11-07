/**
 * Chrome Blocks - Core Content Script
 * 
 * Provides automated ad neutralization, instant video skipping, social media
 * sponsored post filtering, and cosmetic DOM cleaning across all web pages.
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

  // --- Statistics & Sync Queuing ---
  let blockedOnPageCount = 0;
  let pendingSyncCount = 0;
  let syncTimer = null;

  // --- Execution & Observer State ---
  let domObserver = null;
  let heartbeatTimer = null;
  let isScanScheduled = false;
  let wasYouTubeAdActive = false;

  // --- Interactive Element Picker State ---
  let isPickerEnabled = false;
  let activeHoveredElement = null;
  let pickerHudElement = null;

  const currentHost = window.location.hostname.toLowerCase();

  /**
   * Returns true if the current site has been whitelisted by the user.
   */
  function isCurrentSiteWhitelisted() {
    return whitelistedDomains.some(domain => {
      const cleanDomain = domain.toLowerCase().trim();
      return currentHost === cleanDomain || currentHost.endsWith('.' + cleanDomain);
    });
  }

  /**
   * Determines if ad-blocking rules should actively apply to this page.
   */
  function isProtectionActive() {
    return isEnabled && !isCurrentSiteWhitelisted();
  }

  /**
   * Queues blocked ad occurrences and batches updates to background service worker.
   */
  function trackBlockedAd(count = 1) {
    if (count <= 0) return;
    blockedOnPageCount += count;
    pendingSyncCount += count;

    if (!syncTimer) {
      syncTimer = setTimeout(flushBlockedAdCount, 1200);
    }
  }

  /**
   * Sends queued ad block counts to the background service worker.
   */
  function flushBlockedAdCount() {
    syncTimer = null;
    if (pendingSyncCount > 0) {
      const countToSend = pendingSyncCount;
      pendingSyncCount = 0;
      try {
        if (chrome.runtime?.id) {
          chrome.runtime.sendMessage({
            type: 'AD_BLOCKED',
            count: countToSend,
            domain: currentHost
          }).catch(() => {
            // Context may be invalidated if extension was reloaded; safe to ignore
          });
        }
      } catch (err) {
        // Safe fallback
      }
    }
  }

  /**
   * Toggles cosmetic CSS hiding class on the document root element.
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
   * Injects user-defined cosmetic CSS rules for the current website.
   */
  function applyCustomFilters() {
    if (!isProtectionActive()) return;

    let styleTag = document.getElementById('cb-custom-filters-style');
    const matchedSelectors = [];

    for (const [domain, selectors] of Object.entries(customFilters)) {
      if (domain === '*' || currentHost === domain || currentHost.endsWith('.' + domain)) {
        if (Array.isArray(selectors)) {
          matchedSelectors.push(...selectors);
        }
      }
    }

    if (matchedSelectors.length === 0) {
      if (styleTag) styleTag.remove();
      return;
    }

    if (!styleTag) {
      styleTag = document.createElement('style');
      styleTag.id = 'cb-custom-filters-style';
      (document.head || document.documentElement).appendChild(styleTag);
    }

    styleTag.textContent = matchedSelectors
      .map(selector => `${selector} { display: none !important; visibility: hidden !important; }`)
      .join('\n');
  }

  function removeCustomFilters() {
    const styleTag = document.getElementById('cb-custom-filters-style');
    if (styleTag) styleTag.remove();
  }

  /* ==========================================================================
     1. YouTube Ad Fast-Forward, Auto-Skipper & Sponsored Cleaner
     ========================================================================== */

  // Modern YouTube skip button selectors
  const YT_SKIP_BUTTON_SELECTORS = [
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

  // Static YouTube ad slots, companion banners, and overlay containers
  const YT_AD_CONTAINER_SELECTORS = [
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
   * Dispatches synthetic pointer/mouse events and triggers `.click()`
   * so modern Polymer/React components register the click reliably.
   */
  function safelyClickElement(element) {
    if (!element) return;

    try {
      element.click();
    } catch (err) {}

    try {
      const eventSequence = ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click'];
      for (const eventType of eventSequence) {
        element.dispatchEvent(new MouseEvent(eventType, {
          bubbles: true,
          cancelable: true,
          view: window
        }));
      }
    } catch (err) {}
  }

  /**
   * Locates and clicks any visible skip button on the YouTube video player.
   */
  function clickAvailableSkipButton() {
    for (const selector of YT_SKIP_BUTTON_SELECTORS) {
      try {
        const skipButtons = document.querySelectorAll(selector);
        for (const button of skipButtons) {
          safelyClickElement(button);
          trackBlockedAd(1);
          return true;
        }
      } catch (err) {}
    }
    return false;
  }

  /**
   * Cleans YouTube companion ad slots, sidebar promotional banners,
   * and recommendation items containing "Sponsored" or "বিজ্ঞাপন" badges.
   */
  function cleanYouTubeSidebarAndBanners() {
    // 1. Selector-based instant removal
    for (const selector of YT_AD_CONTAINER_SELECTORS) {
      try {
        const elements = document.querySelectorAll(selector);
        for (const el of elements) {
          if (!el?.dataset?.cbProcessed) {
            el.dataset.cbProcessed = 'true';
            el.style.setProperty('display', 'none', 'important');
            trackBlockedAd(1);
          }
        }
      } catch (err) {}
    }

    // 2. Multilingual inspection for sidebar recommendations (English "Sponsored", Bengali "বিজ্ঞাপন")
    const recommendationCards = document.querySelectorAll(
      '#secondary ytd-compact-video-renderer:not([data-cb-processed]), ' +
      '#related ytd-compact-video-renderer:not([data-cb-processed]), ' +
      'ytd-compact-video-renderer:not([data-cb-processed]), ' +
      'ytd-rich-item-renderer:not([data-cb-processed]), ' +
      'ytd-reel-video-renderer:not([data-cb-processed])'
    );

    for (const card of recommendationCards) {
      if (!card) continue;

      let isSponsored = false;

      // Check ad slot children or ad badge classes
      if (card.querySelector('ytd-ad-slot-renderer, [class*="badge-style-type-ad"], [aria-label*="Sponsored" i], [aria-label*="বিজ্ঞাপন"]')) {
        isSponsored = true;
      }

      // Check text content inside badge tags
      if (!isSponsored) {
        const badges = card.querySelectorAll('.ytd-badge-supported-renderer, .badge-shape-wiz__text, #badges span, ytd-badge-supported-renderer span');
        for (const badge of badges) {
          const badgeText = (badge?.textContent || '').trim().toLowerCase();
          if (
            badgeText === 'sponsored' ||
            badgeText === 'বিজ্ঞাপন' ||
            badgeText.includes('sponsored') ||
            badgeText.includes('বিজ্ঞাপন') ||
            badgeText === 'ad'
          ) {
            isSponsored = true;
            break;
          }
        }
      }

      if (isSponsored) {
        card.dataset.cbProcessed = 'true';
        card.style.setProperty('display', 'none', 'important');
        trackBlockedAd(1);
      }
    }

    // 3. Dismiss Anti-Adblock modal dialog if triggered
    try {
      const antiAdblockModal = document.querySelector('tp-yt-paper-dialog:has(ytd-enforcement-message-view-model), ytd-enforcement-message-view-model');
      if (antiAdblockModal) {
        antiAdblockModal.remove();
        const mainVideo = document.querySelector('video');
        if (mainVideo && mainVideo.paused) {
          mainVideo.play().catch(() => {});
        }
      }
    } catch (err) {}
  }

  /**
   * Main YouTube ad handling routine:
   * - Immediately mutes, speeds up to 16x, and fast-forwards in-stream ads
   * - Clicks skip buttons without hesitation
   * - Restores normal playback volume and speed the exact millisecond the ad ends
   */
  function handleYouTubeAds() {
    if (!isProtectionActive() || !moduleSettings.blockYouTubeAds) return;

    const player = document.querySelector('#movie_player') || document.querySelector('.html5-video-player');
    const video = player ? player.querySelector('video') : document.querySelector('video');

    // Find any visible skip button in the DOM
    let skipButton = null;
    for (const sel of YT_SKIP_BUTTON_SELECTORS) {
      const candidate = document.querySelector(sel);
      if (candidate) {
        skipButton = candidate;
        break;
      }
    }

    // Verify whether an ad is actively playing
    const isAdPlaying = Boolean(
      (player && (player.classList.contains('ad-showing') || player.classList.contains('ad-interrupting'))) ||
      document.querySelector('.ytp-ad-player-overlay, .ytp-ad-player-overlay-layout') ||
      skipButton
    );

    if (isAdPlaying) {
      wasYouTubeAdActive = true;

      // 1. Auto-click skip button if present
      if (skipButton) {
        safelyClickElement(skipButton);
        trackBlockedAd(1);
      } else {
        clickAvailableSkipButton();
      }

      // 2. Mute audio and fast-forward the video ad
      if (video) {
        // Prevent audio burst
        if (!video.muted) {
          video.dataset.cbMuted = 'true';
          video.muted = true;
        }

        video.dataset.cbFastForwarded = 'true';
        video.playbackRate = 16.0;

        // Jump to end of ad stream once
        if (isFinite(video.duration) && video.duration > 0) {
          if (video.currentTime < video.duration - 0.1) {
            video.currentTime = video.duration;
          }
        }

        if (video.paused) {
          video.play().catch(() => {});
        }

        trackBlockedAd(1);
      }

      // 3. Fallback to YouTube player internal skipAd API
      if (player && typeof player.skipAd === 'function') {
        try {
          player.skipAd();
        } catch (err) {}
      }
    } else if (wasYouTubeAdActive) {
      // Ad has ended! Cleanly restore normal video settings
      wasYouTubeAdActive = false;

      if (video) {
        if (video.dataset.cbFastForwarded === 'true' || video.playbackRate > 2.0) {
          delete video.dataset.cbFastForwarded;
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

    // 4. Clean sidebar ads, companion banners, and promotional tiles
    cleanYouTubeSidebarAndBanners();
  }

  /* ==========================================================================
     2. Facebook & Social Media Sponsored Post Remover
     ========================================================================== */

  function processFacebookSponsoredPosts() {
    if (!isProtectionActive() || !moduleSettings.blockSocialAds) return;

    // Feed units & post cards
    const feedUnits = document.querySelectorAll('div[data-pagelet^="FeedUnit"], div[role="feed"] > div');
    for (const post of feedUnits) {
      if (!post || post.dataset?.cbProcessed) continue;

      let isSponsored = false;

      // Check ad destination anchor links
      if (post.querySelector('a[href*="/ads/about"], a[href*="ads/about"]')) {
        isSponsored = true;
      }

      // Check multilingual aria-labels
      if (!isSponsored && post.querySelector('[aria-label="Sponsored"], [aria-label="Gesponsert"], [aria-label="Publicidad"], [aria-label="Sponsorisé"]')) {
        isSponsored = true;
      }

      // Check visible text content
      if (!isSponsored) {
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
        post.dataset.cbProcessed = 'true';
        post.classList.add('cb-hidden-ad');
        post.style.setProperty('display', 'none', 'important');
        trackBlockedAd(1);
      }
    }

    // Right-column sidebar sponsored widgets
    const sidebarAds = document.querySelectorAll('div[role="complementary"] div:has(a[href*="/ads/about"]), div[aria-label="Advertiser"]');
    for (const ad of sidebarAds) {
      if (ad && !ad.dataset?.cbProcessed) {
        ad.dataset.cbProcessed = 'true';
        ad.classList.add('cb-hidden-ad');
        ad.style.setProperty('display', 'none', 'important');
        trackBlockedAd(1);
      }
    }
  }

  function processInstagramSponsoredPosts() {
    if (!isProtectionActive() || !moduleSettings.blockSocialAds) return;

    const articles = document.querySelectorAll('article');
    for (const article of articles) {
      if (!article || article.dataset?.cbProcessed) continue;

      let isSponsored = false;
      const text = (article?.textContent || '').toLowerCase();
      if (text.includes('sponsored') || text.includes('paid partnership with')) {
        isSponsored = true;
      }

      if (isSponsored) {
        article.dataset.cbProcessed = 'true';
        article.classList.add('cb-hidden-ad');
        article.style.setProperty('display', 'none', 'important');
        trackBlockedAd(1);
      }
    }
  }

  function processTwitterPromotedTweets() {
    if (!isProtectionActive() || !moduleSettings.blockSocialAds) return;

    const tweets = document.querySelectorAll('article:not([data-cb-processed])');
    for (const tweet of tweets) {
      if (!tweet) continue;
      if (tweet.querySelector('[data-testid="placementTracking"]') || tweet.innerText?.includes('Ad\n') || tweet.innerText?.includes('Promoted')) {
        tweet.dataset.cbProcessed = 'true';
        tweet.style.setProperty('display', 'none', 'important');
        trackBlockedAd(1);
      }
    }
  }

  function processRedditPromotedPosts() {
    if (!isProtectionActive() || !moduleSettings.blockSocialAds) return;

    const posts = document.querySelectorAll('shreddit-post[is-promoted="true"]:not([data-cb-processed]), .promotedlink:not([data-cb-processed])');
    for (const post of posts) {
      if (post) {
        post.dataset.cbProcessed = 'true';
        post.style.setProperty('display', 'none', 'important');
        trackBlockedAd(1);
      }
    }
  }

  /* ==========================================================================
     3. General Web Ads & Cookie Consent Overlays
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

  function processGeneralWebAds() {
    if (!isProtectionActive()) return;

    for (const selector of COMMON_WEB_AD_SELECTORS) {
      try {
        const matches = document.querySelectorAll(selector + ':not([data-cb-processed])');
        for (const el of matches) {
          if (el) {
            el.dataset.cbProcessed = 'true';
            el.style.setProperty('display', 'none', 'important');
            trackBlockedAd(1);
          }
        }
      } catch (err) {}
    }

    if (moduleSettings.blockCookieBanners) {
      for (const selector of COOKIE_BANNER_SELECTORS) {
        try {
          const matches = document.querySelectorAll(selector + ':not([data-cb-processed])');
          for (const el of matches) {
            if (el) {
              el.dataset.cbProcessed = 'true';
              el.style.setProperty('display', 'none', 'important');
              trackBlockedAd(1);
            }
          }
        } catch (err) {}
      }
    }
  }

  /**
   * Routes the DOM scan to domain-specific handlers
   */
  function executeDomScan() {
    if (!isProtectionActive() || isScanScheduled) return;

    try {
      if (currentHost.includes('youtube.com')) {
        handleYouTubeAds();
      } else if (currentHost.includes('facebook.com')) {
        processFacebookSponsoredPosts();
      } else if (currentHost.includes('instagram.com')) {
        processInstagramSponsoredPosts();
      } else if (currentHost.includes('twitter.com') || currentHost.includes('x.com')) {
        processTwitterPromotedTweets();
      } else if (currentHost.includes('reddit.com')) {
        processRedditPromotedPosts();
      } else {
        processGeneralWebAds();
      }
    } catch (err) {}
  }

  /**
   * Schedules a scan coalesced via requestAnimationFrame for 60fps performance
   */
  function scheduleScan() {
    if (isScanScheduled || !isProtectionActive()) return;
    isScanScheduled = true;
    requestAnimationFrame(() => {
      isScanScheduled = false;
      executeDomScan();
    });
  }

  /* ==========================================================================
     4. Interactive Element Picker Engine
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

  function handlePickerHover(event) {
    if (!isPickerEnabled) return;
    const target = event.target;
    if (!target || target.closest('.cb-picker-hud')) return;

    if (activeHoveredElement) {
      activeHoveredElement.classList.remove('cb-picker-highlight');
    }
    activeHoveredElement = target;
    activeHoveredElement.classList.add('cb-picker-highlight');
  }

  function handlePickerUnhover() {
    if (!isPickerEnabled) return;
    if (activeHoveredElement) {
      activeHoveredElement.classList.remove('cb-picker-highlight');
      activeHoveredElement = null;
    }
  }

  function handlePickerSelection(event) {
    if (!isPickerEnabled) return;
    if (event.target && event.target.closest('.cb-picker-hud')) return;

    event.preventDefault();
    event.stopPropagation();

    const selectedTarget = activeHoveredElement || event.target;
    if (!selectedTarget) return;

    const selector = computeUniqueSelector(selectedTarget);

    if (selector) {
      selectedTarget.style.setProperty('display', 'none', 'important');
      trackBlockedAd(1);

      chrome.runtime.sendMessage({
        type: 'ADD_CUSTOM_FILTER',
        domain: currentHost,
        selector: selector
      }, (response) => {
        if (response?.customFilters) {
          customFilters = response.customFilters;
          applyCustomFilters();
        }
      });
    }

    disableElementPicker();
  }

  function handlePickerKey(event) {
    if (event.key === 'Escape' && isPickerEnabled) {
      disableElementPicker();
    }
  }

  function enableElementPicker() {
    if (isPickerEnabled) return;
    isPickerEnabled = true;

    pickerHudElement = document.createElement('div');
    pickerHudElement.className = 'cb-picker-hud';
    pickerHudElement.innerHTML = `
      <div class="cb-picker-hud-info">
        <span class="cb-picker-hud-title">Chrome Blocks Picker</span>
        <span class="cb-picker-hud-sub">Click any element to permanently block it (Esc to cancel)</span>
      </div>
      <button class="cb-picker-hud-btn" id="cb-cancel-picker">Cancel</button>
    `;
    document.body.appendChild(pickerHudElement);

    document.getElementById('cb-cancel-picker')?.addEventListener('click', disableElementPicker);

    document.addEventListener('mouseover', handlePickerHover, true);
    document.addEventListener('mouseout', handlePickerUnhover, true);
    document.addEventListener('click', handlePickerSelection, true);
    document.addEventListener('keydown', handlePickerKey, true);
  }

  function disableElementPicker() {
    if (!isPickerEnabled) return;
    isPickerEnabled = false;

    if (activeHoveredElement) {
      activeHoveredElement.classList.remove('cb-picker-highlight');
      activeHoveredElement = null;
    }

    if (pickerHudElement) {
      pickerHudElement.remove();
      pickerHudElement = null;
    }

    document.removeEventListener('mouseover', handlePickerHover, true);
    document.removeEventListener('mouseout', handlePickerUnhover, true);
    document.removeEventListener('click', handlePickerSelection, true);
    document.removeEventListener('keydown', handlePickerKey, true);
  }

  /* ==========================================================================
     5. Lifecycle, Observers & Storage Sync
     ========================================================================== */

  function startAdBlockEngine() {
    updateCosmeticClass();
    scheduleScan();

    // Attach high-performance, non-blocking MutationObserver
    if (!domObserver && (document.body || document.documentElement)) {
      domObserver = new MutationObserver(() => {
        scheduleScan();
      });

      domObserver.observe(document.body || document.documentElement, {
        childList: true,
        subtree: true
      });
    }

    // Steady heartbeat check (150ms) to catch stream updates
    if (!heartbeatTimer) {
      heartbeatTimer = setInterval(() => {
        if (isProtectionActive()) {
          executeDomScan();
        }
      }, 150);
    }
  }

  function stopAdBlockEngine() {
    updateCosmeticClass();
    flushBlockedAdCount();

    if (domObserver) {
      domObserver.disconnect();
      domObserver = null;
    }

    if (heartbeatTimer) {
      clearInterval(heartbeatTimer);
      heartbeatTimer = null;
    }

    const hiddenElements = document.querySelectorAll('.cb-hidden-ad, [data-cb-processed]');
    for (const el of hiddenElements) {
      el.style.removeProperty('display');
    }
  }

  function initializeContentScript() {
    if (!chrome.storage || !chrome.storage.local) {
      startAdBlockEngine();
      return;
    }

    // Load initial preferences
    chrome.storage.local.get(['isEnabled', 'whitelistedDomains', 'customFilters', 'moduleSettings'], (res) => {
      if (chrome.runtime.lastError) {
        startAdBlockEngine();
        return;
      }

      if (res.isEnabled !== undefined) isEnabled = Boolean(res.isEnabled);
      if (Array.isArray(res.whitelistedDomains)) whitelistedDomains = res.whitelistedDomains;
      if (res.customFilters) customFilters = res.customFilters;
      if (res.moduleSettings) moduleSettings = { ...moduleSettings, ...res.moduleSettings };

      if (isProtectionActive()) {
        startAdBlockEngine();
      } else {
        stopAdBlockEngine();
      }
    });

    // Real-time synchronization when user toggles settings in popup
    chrome.storage.onChanged.addListener((changes, areaName) => {
      if (areaName !== 'local') return;

      let stateNeedsRefresh = false;

      if (changes.isEnabled) {
        isEnabled = Boolean(changes.isEnabled.newValue);
        stateNeedsRefresh = true;
      }

      if (changes.whitelistedDomains) {
        whitelistedDomains = changes.whitelistedDomains.newValue || [];
        stateNeedsRefresh = true;
      }

      if (changes.customFilters) {
        customFilters = changes.customFilters.newValue || {};
        applyCustomFilters();
      }

      if (changes.moduleSettings) {
        moduleSettings = { ...moduleSettings, ...changes.moduleSettings.newValue };
      }

      if (stateNeedsRefresh) {
        if (isProtectionActive()) {
          startAdBlockEngine();
        } else {
          stopAdBlockEngine();
        }
      }
    });

    // Handle messages from popup
    chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
      if (message.type === 'GET_TAB_STATS') {
        sendResponse({
          domain: currentHost,
          blockedOnPage: blockedOnPageCount,
          isWhitelisted: isCurrentSiteWhitelisted(),
          isEnabled: isProtectionActive()
        });
      } else if (message.type === 'START_ELEMENT_PICKER') {
        enableElementPicker();
        sendResponse({ success: true });
      }
      return true;
    });

    // Re-trigger scan on SPA navigation events (YouTube, Facebook, Twitter)
    window.addEventListener('yt-navigate-finish', scheduleScan, { passive: true });
    window.addEventListener('spfdone', scheduleScan, { passive: true });
    window.addEventListener('popstate', scheduleScan, { passive: true });
  }

  // Ensure DOM is ready before initial execution
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initializeContentScript, { once: true });
  } else {
    initializeContentScript();
  }

  // Ensure pending metrics are persisted on tab closure
  window.addEventListener('beforeunload', flushBlockedAdCount);
})();
