/**
 * Chrome Blocks - Core Content Script
 * 
 * Production-ready DOM interceptor and ad destroyer.
 * Resilient multi-layer detection for YouTube, Facebook, social feeds, and general web ads.
 */

(() => {
  'use strict';

  // --- Core State & Preferences ---
  let isEnabled = true;
  let whitelistedDomains = [];
  let customFilters = {};
  let moduleSettings = {
    blockYouTubeAds: true,
    blockSocialAds: true,
    blockCookieBanners: true
  };

  // --- Telemetry & Sync Queuing ---
  let blockedOnPageCount = 0;
  let pendingSyncCount = 0;
  let syncTimer = null;

  // --- Execution & Observer State ---
  let domObserver = null;
  let youtubeSafetyTimer = null;
  let isScanScheduled = false;
  let isYouTubeAdActiveState = false;

  // --- Interactive Element Picker State ---
  let isPickerEnabled = false;
  let activeHoveredElement = null;
  let pickerHudElement = null;

  const currentHost = window.location.hostname.toLowerCase();

  /**
   * Check if current website is on the user's whitelist
   */
  function isCurrentSiteWhitelisted() {
    return whitelistedDomains.some(domain => {
      const clean = domain.toLowerCase().trim();
      return currentHost === clean || currentHost.endsWith('.' + clean);
    });
  }

  /**
   * Returns true if protection is enabled and site is not whitelisted
   */
  function isProtectionActive() {
    return isEnabled && !isCurrentSiteWhitelisted();
  }

  /**
   * Queue ad block occurrences and batch-persist to background worker
   */
  function trackBlockedAd(count = 1) {
    if (count <= 0) return;
    blockedOnPageCount += count;
    pendingSyncCount += count;

    if (!syncTimer) {
      syncTimer = setTimeout(flushBlockedAdCount, 1200);
    }
  }

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
          }).catch(() => {});
        }
      } catch (err) {}
    }
  }

  /**
   * Update cosmetic styling class on the root HTML element
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
   * Inject user-defined cosmetic filters for this domain
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
      .map(sel => `${sel} { display: none !important; visibility: hidden !important; }`)
      .join('\n');
  }

  function removeCustomFilters() {
    const styleTag = document.getElementById('cb-custom-filters-style');
    if (styleTag) styleTag.remove();
  }

  /* ==========================================================================
     1. Multi-Layer YouTube Ad Destroyer & Instant Bypass Engine
     ========================================================================== */

  // Modern YouTube skip button selectors
  const YT_SKIP_BUTTON_SELECTORS = [
    '.ytp-ad-skip-button',
    '.ytp-ad-skip-button-modern',
    'button.ytp-ad-skip-button',
    'button.ytp-ad-skip-button-modern',
    '.ytp-skip-ad-button',
    '.ytp-ad-skip-button-slot button',
    '.ytp-ad-skip-button-slot',
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
   * Reliably clicks skip buttons via both `.click()` and synthetic mouse events
   */
  function clickSkipElement(element) {
    if (!element) return;
    try {
      element.click();
    } catch (e) {}

    try {
      const events = ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click'];
      for (const evt of events) {
        element.dispatchEvent(new MouseEvent(evt, {
          bubbles: true,
          cancelable: true,
          view: window
        }));
      }
    } catch (e) {}
  }

  /**
   * Resilient Multi-Layer YouTube Ad Detection
   * Evaluates player classes, overlay nodes, skip buttons, and container attributes.
   */
  function detectYouTubeAd(player) {
    if (!player) player = document.getElementById('movie_player') || document.querySelector('.html5-video-player');
    if (!player) return { isAd: false, skipBtn: null };

    // Layer 1: Player Class Identifiers
    const hasPlayerAdClass = (
      player.classList.contains('ad-showing') ||
      player.classList.contains('ad-interrupting') ||
      player.classList.contains('ad-created')
    );

    // Layer 2: Player Overlay and Ad Layout Nodes
    const hasOverlayNode = Boolean(
      player.querySelector('.ytp-ad-player-overlay, .ytp-ad-player-overlay-layout, .ytp-ad-text, .ytp-ad-preview-container')
    );

    // Layer 3: Watch Container Attribute Flags
    const hasWatchAttr = Boolean(
      document.querySelector('ytd-watch-flexy[ad-active], ytd-player-legacy-desktop-watch-renderer[ad-active], [ad-showing]')
    );

    // Layer 4: Skip Button Presence anywhere in DOM
    let skipBtn = null;
    for (const selector of YT_SKIP_BUTTON_SELECTORS) {
      const match = document.querySelector(selector);
      if (match) {
        skipBtn = match;
        break;
      }
    }

    // Layer 5: Video Ads Container Non-Empty Check
    const videoAdsContainer = player.querySelector('.video-ads');
    const hasVideoAds = Boolean(videoAdsContainer && videoAdsContainer.children.length > 0);

    const isAd = Boolean(hasPlayerAdClass || hasOverlayNode || hasWatchAttr || skipBtn || hasVideoAds);
    return { isAd, skipBtn };
  }

  /**
   * Scrub sidebar sponsored units, promotional video cards, and companion banners
   * Supports both English ("Sponsored", "Ad") and Bengali ("বিজ্ঞাপন") localizations.
   */
  function scrubYouTubeSidebarAndCompanionAds() {
    // 1. Selector-based instant removal
    for (const selector of YT_AD_CONTAINER_SELECTORS) {
      try {
        const matches = document.querySelectorAll(selector);
        for (const el of matches) {
          if (!el?.dataset?.cbProcessed) {
            el.dataset.cbProcessed = 'true';
            el.style.setProperty('display', 'none', 'important');
            trackBlockedAd(1);
          }
        }
      } catch (e) {}
    }

    // 2. Multilingual badge & container inspection
    const recommendationContainers = document.querySelectorAll(
      '#secondary ytd-compact-video-renderer:not([data-cb-processed]), ' +
      '#related ytd-compact-video-renderer:not([data-cb-processed]), ' +
      'ytd-compact-video-renderer:not([data-cb-processed]), ' +
      'ytd-rich-item-renderer:not([data-cb-processed]), ' +
      'ytd-reel-video-renderer:not([data-cb-processed]), ' +
      'yt-lockup-view-model:not([data-cb-processed]), ' +
      'ytd-ad-slot-renderer:not([data-cb-processed])'
    );

    for (const card of recommendationContainers) {
      if (!card) continue;

      let isSponsored = false;

      // Check ad slot children or ad badge attributes
      if (card.querySelector('ytd-ad-slot-renderer, [class*="badge-style-type-ad"], [aria-label*="Sponsored" i], [aria-label*="বিজ্ঞাপন"]')) {
        isSponsored = true;
      }

      // Check text in badge elements
      if (!isSponsored) {
        const badges = card.querySelectorAll('.ytd-badge-supported-renderer, .badge-shape-wiz__text, #badges span, ytd-badge-supported-renderer span');
        for (const b of badges) {
          const text = (b?.textContent || '').trim().toLowerCase();
          if (
            text === 'sponsored' ||
            text === 'বিজ্ঞাপন' ||
            text.includes('sponsored') ||
            text.includes('বিজ্ঞাপন') ||
            text === 'ad'
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
      const modal = document.querySelector('tp-yt-paper-dialog:has(ytd-enforcement-message-view-model), ytd-enforcement-message-view-model');
      if (modal) {
        modal.remove();
        const mainVideo = document.querySelector('video');
        if (mainVideo && mainVideo.paused) {
          mainVideo.play().catch(() => {});
        }
      }
    } catch (e) {}
  }

  /**
   * Main YouTube ad handling routine:
   * Instantly fast-forwards, mutes, skips ads, and restores normal video seamlessly.
   */
  function handleYouTubeAds() {
    if (!isProtectionActive() || !moduleSettings.blockYouTubeAds) return;

    const player = document.getElementById('movie_player') || document.querySelector('.html5-video-player');
    const video = player ? player.querySelector('video') : document.querySelector('video');

    const { isAd, skipBtn } = detectYouTubeAd(player);

    if (isAd) {
      isYouTubeAdActiveState = true;

      // 1. Instantly trigger skip button with zero human delay
      if (skipBtn) {
        clickSkipElement(skipBtn);
        trackBlockedAd(1);
      }

      // Also click overlay close buttons
      const overlayCloseBtn = document.querySelector('.ytp-ad-overlay-close-button');
      if (overlayCloseBtn) {
        clickSkipElement(overlayCloseBtn);
      }

      // 2. High-speed fast-forward & audio mute
      if (video) {
        if (!video.muted) {
          video.dataset.cbMuted = 'true';
          video.muted = true;
        }

        video.dataset.cbSpeedUp = 'true';
        video.playbackRate = 16.0;

        // Force jump straight past the ad
        if (isFinite(video.duration) && video.duration > 0) {
          if (video.currentTime < video.duration - 0.1) {
            video.currentTime = video.duration;
          }
        } else {
          // If duration is streaming or unavailable, advance current time
          video.currentTime += 500;
        }

        if (video.paused) {
          video.play().catch(() => {});
        }

        trackBlockedAd(1);
      }

      // 3. Native player skip hook
      if (player && typeof player.skipAd === 'function') {
        try {
          player.skipAd();
        } catch (e) {}
      }
    } else if (isYouTubeAdActiveState) {
      // Ad has completed: cleanly restore normal audio and playback rate
      isYouTubeAdActiveState = false;

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

    // 4. Scrub sidebar and overlay ads
    scrubYouTubeSidebarAndCompanionAds();
  }

  /* ==========================================================================
     2. Facebook & Social Feed Sponsored Scrubbers
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
   * Main scan routine - routes to domain-specific handlers
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
   * Schedules a scan coalesced via requestAnimationFrame
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

    // High-performance MutationObserver attached to DOM root
    if (!domObserver && (document.body || document.documentElement)) {
      domObserver = new MutationObserver(() => {
        scheduleScan();
      });

      domObserver.observe(document.body || document.documentElement, {
        childList: true,
        subtree: true
      });
    }

    // Safety loop: high-frequency (50ms) for YouTube to destroy ads within 1 frame
    if (!youtubeSafetyTimer) {
      const intervalMs = currentHost.includes('youtube.com') ? 50 : 250;
      youtubeSafetyTimer = setInterval(() => {
        if (isProtectionActive()) {
          executeDomScan();
        }
      }, intervalMs);
    }
  }

  function stopAdBlockEngine() {
    updateCosmeticClass();
    flushBlockedAdCount();

    if (domObserver) {
      domObserver.disconnect();
      domObserver = null;
    }

    if (youtubeSafetyTimer) {
      clearInterval(youtubeSafetyTimer);
      youtubeSafetyTimer = null;
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
