/**
 * Chrome Blocks - Core Content Script
 * 
 * Lightweight, target-focused DOM ad-destruction and playback engine.
 * Fast, non-blocking player interception for YouTube, social feeds, and general web.
 * Remains 100% idle during normal video playback to guarantee zero lag, zero stutter,
 * and instant video playback.
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

  // --- Telemetry & Batch Sync ---
  let blockedOnPageCount = 0;
  let pendingSyncCount = 0;
  let syncTimer = null;

  // --- Observers & Lifecycle State ---
  let domObserver = null;
  let youtubePlayerObserver = null;
  let isYouTubeAdActive = false;
  let youtubeActiveLoopRaf = null;
  let youtubeSidebarThrottleTimer = null;
  let generalScanThrottleTimer = null;

  // --- Interactive Element Picker State ---
  let isPickerEnabled = false;
  let activeHoveredElement = null;
  let pickerHudElement = null;

  const currentHost = window.location.hostname.toLowerCase();
  const isYouTubeSite = currentHost.includes('youtube.com');

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
   * Queue ad block occurrences and batch-persist to background service worker
   * Uses debouncing to prevent IPC spam and browser lagging.
   */
  function trackBlockedAd(count = 1) {
    if (count <= 0) return;
    blockedOnPageCount += count;
    pendingSyncCount += count;

    if (!syncTimer) {
      syncTimer = setTimeout(flushBlockedAdCount, 2000);
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
     1. Pinpoint YouTube DOM Ad Interceptor & Playback Engine
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
    '.ytp-ad-overlay-close-button'
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
   * Find any available skip button and trigger it immediately
   */
  function triggerAnySkipButton() {
    for (const selector of YT_SKIP_BUTTON_SELECTORS) {
      const btn = document.querySelector(selector);
      if (btn) {
        clickSkipElement(btn);
        return true;
      }
    }
    return false;
  }

  /**
   * Helper to retrieve active YouTube video player element
   */
  function getYouTubePlayer() {
    return document.getElementById('movie_player') || document.querySelector('.html5-video-player');
  }

  /**
   * Fast, pinpoint check for active in-stream ad states on YouTube.
   * Returns true ONLY if an ad is actively playing or interrupting playback.
   */
  function isYouTubeAdStateActive(player) {
    if (!player) return false;

    // Direct player class flags (applied natively by YouTube during in-stream ads)
    if (player.classList.contains('ad-showing') || player.classList.contains('ad-interrupting')) {
      return true;
    }

    // Active ad overlay elements inside the player
    if (player.querySelector('.ytp-ad-player-overlay, .ytp-ad-player-overlay-layout')) {
      return true;
    }

    // Skip button actively mounted in the DOM
    if (document.querySelector('.ytp-ad-skip-button, .ytp-ad-skip-button-modern, button.ytp-ad-skip-button')) {
      return true;
    }

    return false;
  }

  /**
   * Core YouTube Ad-Bypass Engine:
   * 1. The exact millisecond an ad appears: instantly mute, force 16x speed, jump to end, and click skip.
   * 2. The exact moment the ad ends: cleanly restore normal playback (1.0x, unmuted).
   * 3. When NO ad is present: remains completely idle to ensure normal videos play without lag.
   */
  function interceptYouTubeAd() {
    if (!isProtectionActive() || !moduleSettings.blockYouTubeAds) return;

    const player = getYouTubePlayer();
    if (!player) return;

    const adActive = isYouTubeAdStateActive(player);
    const video = player.querySelector('video') || document.querySelector('video');

    if (adActive) {
      // First millisecond an ad is detected
      if (!isYouTubeAdActive) {
        isYouTubeAdActive = true;
        trackBlockedAd(1); // Track ad block once per ad
      }

      // Fast-forward, mute and jump past the ad immediately
      if (video) {
        // Mute ad audio so user never hears jarring ads
        if (!video.muted) {
          video.dataset.cbAdMuted = 'true';
          video.muted = true;
        }

        // Set playback rate to maximum
        video.dataset.cbAdSpeed = 'true';
        video.playbackRate = 16.0;

        // Instantly jump to the end of the ad segment
        if (Number.isFinite(video.duration) && video.duration > 0) {
          if (video.currentTime < video.duration - 0.1) {
            video.currentTime = video.duration;
          }
        } else {
          // If live/streaming or duration pending, advance current time
          video.currentTime += 500;
        }

        // Ensure video is playing so skip transition triggers
        if (video.paused) {
          video.play().catch(() => {});
        }
      }

      // Click skip button immediately
      triggerAnySkipButton();

      // Invoke native player skip API if exposed
      if (typeof player.skipAd === 'function') {
        try {
          player.skipAd();
        } catch (e) {}
      }

      // Schedule next frame check ONLY while ad is still active
      if (!youtubeActiveLoopRaf) {
        youtubeActiveLoopRaf = requestAnimationFrame(() => {
          youtubeActiveLoopRaf = null;
          interceptYouTubeAd();
        });
      }
    } else if (isYouTubeAdActive) {
      // Ad has completely ended! Cleanly restore normal video playback state
      isYouTubeAdActive = false;

      if (youtubeActiveLoopRaf) {
        cancelAnimationFrame(youtubeActiveLoopRaf);
        youtubeActiveLoopRaf = null;
      }

      if (video) {
        // Restore standard 1.0x speed
        if (video.dataset.cbAdSpeed === 'true' || video.playbackRate > 2.0) {
          delete video.dataset.cbAdSpeed;
          video.playbackRate = 1.0;
        }

        // Restore sound
        if (video.dataset.cbAdMuted === 'true') {
          delete video.dataset.cbAdMuted;
          video.muted = false;
        }

        // Resume playback if it was paused during skip transition
        if (video.paused) {
          video.play().catch(() => {});
        }
      }
    }
  }

  /**
   * Lightweight, throttled scrubber for YouTube recommendations and sidebar
   * Runs only on navigation or throttled to once every 3s to avoid main-thread lag.
   */
  function scrubYouTubeSponsoredContent() {
    if (!isProtectionActive() || !moduleSettings.blockYouTubeAds) return;

    // 1. Selector-based check for sponsored recommendation cards
    const sponsoredCards = document.querySelectorAll(
      '#secondary ytd-compact-video-renderer:not([data-cb-scanned]), ' +
      'ytd-rich-item-renderer:not([data-cb-scanned]), ' +
      'yt-lockup-view-model:not([data-cb-scanned]), ' +
      'ytd-ad-slot-renderer:not([data-cb-scanned])'
    );

    for (const card of sponsoredCards) {
      if (!card) continue;
      card.dataset.cbScanned = 'true';

      let isSponsored = false;

      // Check ad slot children or ad badge attributes
      if (card.tagName.toLowerCase() === 'ytd-ad-slot-renderer' ||
          card.querySelector('ytd-ad-slot-renderer, [class*="badge-style-type-ad"], [aria-label*="Sponsored" i], [aria-label*="বিজ্ঞাপন"]')) {
        isSponsored = true;
      }

      // Check text in badge elements (supports English "Sponsored" and Bengali "বিজ্ঞাপন")
      if (!isSponsored) {
        const badges = card.querySelectorAll('.ytd-badge-supported-renderer, .badge-shape-wiz__text, #badges span');
        for (const b of badges) {
          const text = (b?.textContent || '').trim().toLowerCase();
          if (text === 'sponsored' || text === 'বিজ্ঞাপন' || text.includes('sponsored') || text.includes('বিজ্ঞাপন') || text === 'ad') {
            isSponsored = true;
            break;
          }
        }
      }

      if (isSponsored) {
        card.style.setProperty('display', 'none', 'important');
        trackBlockedAd(1);
      }
    }

    // 2. Dismiss anti-adblock modal dialog if triggered
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
   * Throttled trigger for YouTube sidebar and feed scrubber
   */
  function scheduleYouTubeSidebarScrub() {
    if (youtubeSidebarThrottleTimer) return;
    youtubeSidebarThrottleTimer = setTimeout(() => {
      youtubeSidebarThrottleTimer = null;
      scrubYouTubeSponsoredContent();
    }, 2500);
  }

  /**
   * Attach targeted observer directly to YouTube's player container
   */
  function setupYouTubePlayerObserver() {
    if (!isYouTubeSite) return;

    const player = getYouTubePlayer();
    if (!player) {
      // If player not loaded yet, retry briefly
      setTimeout(setupYouTubePlayerObserver, 300);
      return;
    }

    if (youtubePlayerObserver) {
      youtubePlayerObserver.disconnect();
    }

    // Targeted observer watching class attribute changes on the player (0ms latency, zero polling)
    youtubePlayerObserver = new MutationObserver(() => {
      interceptYouTubeAd();
    });

    youtubePlayerObserver.observe(player, {
      attributes: true,
      attributeFilter: ['class'],
      childList: true // To catch skip button mounts inside the player
    });

    // Run initial intercept check in case page opened directly onto an ad
    interceptYouTubeAd();
    scrubYouTubeSponsoredContent();
  }

  /* ==========================================================================
     2. Facebook & Social Media Sponsored Feed Scrubbers
     ========================================================================== */

  function processFacebookSponsoredPosts() {
    if (!isProtectionActive() || !moduleSettings.blockSocialAds) return;

    const feedUnits = document.querySelectorAll('div[data-pagelet^="FeedUnit"]:not([data-cb-scanned]), div[role="feed"] > div:not([data-cb-scanned])');
    for (const post of feedUnits) {
      if (!post) continue;
      post.dataset.cbScanned = 'true';

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
        trackBlockedAd(1);
      }
    }

    // Right-column sidebar sponsored widgets
    const sidebarAds = document.querySelectorAll('div[role="complementary"] div:has(a[href*="/ads/about"]):not([data-cb-scanned]), div[aria-label="Advertiser"]:not([data-cb-scanned])');
    for (const ad of sidebarAds) {
      if (ad) {
        ad.dataset.cbScanned = 'true';
        ad.classList.add('cb-hidden-ad');
        ad.style.setProperty('display', 'none', 'important');
        trackBlockedAd(1);
      }
    }
  }

  function processInstagramSponsoredPosts() {
    if (!isProtectionActive() || !moduleSettings.blockSocialAds) return;

    const articles = document.querySelectorAll('article:not([data-cb-scanned])');
    for (const article of articles) {
      if (!article) continue;
      article.dataset.cbScanned = 'true';

      const text = (article?.textContent || '').toLowerCase();
      if (text.includes('sponsored') || text.includes('paid partnership with')) {
        article.classList.add('cb-hidden-ad');
        article.style.setProperty('display', 'none', 'important');
        trackBlockedAd(1);
      }
    }
  }

  function processTwitterPromotedTweets() {
    if (!isProtectionActive() || !moduleSettings.blockSocialAds) return;

    const tweets = document.querySelectorAll('article:not([data-cb-scanned])');
    for (const tweet of tweets) {
      if (!tweet) continue;
      tweet.dataset.cbScanned = 'true';

      if (tweet.querySelector('[data-testid="placementTracking"]') || tweet.innerText?.includes('Ad\n') || tweet.innerText?.includes('Promoted')) {
        tweet.style.setProperty('display', 'none', 'important');
        trackBlockedAd(1);
      }
    }
  }

  function processRedditPromotedPosts() {
    if (!isProtectionActive() || !moduleSettings.blockSocialAds) return;

    const posts = document.querySelectorAll('shreddit-post[is-promoted="true"]:not([data-cb-scanned]), .promotedlink:not([data-cb-scanned])');
    for (const post of posts) {
      if (post) {
        post.dataset.cbScanned = 'true';
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
        const matches = document.querySelectorAll(selector + ':not([data-cb-scanned])');
        for (const el of matches) {
          if (el) {
            el.dataset.cbScanned = 'true';
            el.style.setProperty('display', 'none', 'important');
            trackBlockedAd(1);
          }
        }
      } catch (err) {}
    }

    if (moduleSettings.blockCookieBanners) {
      for (const selector of COOKIE_BANNER_SELECTORS) {
        try {
          const matches = document.querySelectorAll(selector + ':not([data-cb-scanned])');
          for (const el of matches) {
            if (el) {
              el.dataset.cbScanned = 'true';
              el.style.setProperty('display', 'none', 'important');
              trackBlockedAd(1);
            }
          }
        } catch (err) {}
      }
    }
  }

  /**
   * Debounced general scan for social feeds and standard websites
   */
  function scheduleGeneralScan() {
    if (generalScanThrottleTimer || !isProtectionActive()) return;
    generalScanThrottleTimer = setTimeout(() => {
      generalScanThrottleTimer = null;
      if (currentHost.includes('facebook.com')) {
        processFacebookSponsoredPosts();
      } else if (currentHost.includes('instagram.com')) {
        processInstagramSponsoredPosts();
      } else if (currentHost.includes('twitter.com') || currentHost.includes('x.com')) {
        processTwitterPromotedTweets();
      } else if (currentHost.includes('reddit.com')) {
        processRedditPromotedPosts();
      } else if (!isYouTubeSite) {
        processGeneralWebAds();
      }
    }, 350);
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

    if (isYouTubeSite) {
      // Dedicated, lightweight YouTube player observer
      setupYouTubePlayerObserver();
      // Schedule throttled recommendation scrub
      scheduleYouTubeSidebarScrub();
    } else {
      // General websites and social feeds: debounced MutationObserver
      scheduleGeneralScan();

      if (!domObserver && (document.body || document.documentElement)) {
        domObserver = new MutationObserver(() => {
          scheduleGeneralScan();
        });

        domObserver.observe(document.body || document.documentElement, {
          childList: true,
          subtree: true
        });
      }
    }
  }

  function stopAdBlockEngine() {
    updateCosmeticClass();
    flushBlockedAdCount();

    if (domObserver) {
      domObserver.disconnect();
      domObserver = null;
    }

    if (youtubePlayerObserver) {
      youtubePlayerObserver.disconnect();
      youtubePlayerObserver = null;
    }

    if (youtubeActiveLoopRaf) {
      cancelAnimationFrame(youtubeActiveLoopRaf);
      youtubeActiveLoopRaf = null;
    }

    if (youtubeSidebarThrottleTimer) {
      clearTimeout(youtubeSidebarThrottleTimer);
      youtubeSidebarThrottleTimer = null;
    }

    if (generalScanThrottleTimer) {
      clearTimeout(generalScanThrottleTimer);
      generalScanThrottleTimer = null;
    }

    const hiddenElements = document.querySelectorAll('.cb-hidden-ad, [data-cb-scanned]');
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

    // Re-trigger player hook on SPA navigation events (YouTube watch page changes)
    if (isYouTubeSite) {
      window.addEventListener('yt-navigate-finish', () => {
        isYouTubeAdActive = false;
        setupYouTubePlayerObserver();
        scheduleYouTubeSidebarScrub();
      }, { passive: true });

      window.addEventListener('spfdone', () => {
        isYouTubeAdActive = false;
        setupYouTubePlayerObserver();
      }, { passive: true });
    } else {
      window.addEventListener('popstate', scheduleGeneralScan, { passive: true });
    }
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
