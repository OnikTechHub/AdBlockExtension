/**
 * Chrome Blocks - Content Script
 * High-performance ad, banner, tracker, social sponsored post, and element picker engine.
 * Advanced zero-delay YouTube ad neutralization, auto-skipping, and fast-forward engine.
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
  let youtubePlayerObserver = null;
  let youtubeRafId = null;

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
     Zero-Delay YouTube Ad Neutralization Engine
     ========================================================================== */

  // Modern YouTube Skip Button Selectors
  const YOUTUBE_SKIP_SELECTORS = [
    '.ytp-ad-skip-button',
    '.ytp-ad-skip-button-modern',
    '.ytp-skip-ad-button',
    '.ytp-ad-skip-button-slot button',
    '.ytp-ad-skip-button-slot',
    'button.ytp-ad-skip-button',
    'button.ytp-ad-skip-button-modern',
    '.ytp-ad-skip-button-container button',
    '.ytp-ad-preview-container ~ .ytp-ad-skip-button',
    '[id^="skip-button:"] button',
    '[id^="skip-button:"]',
    'button[class*="ytp-ad-skip-button"]',
    'button[class*="ytp-skip-ad-button"]',
    '.videoAdUiSkipButton',
    '.ytp-ad-overlay-close-button',
    '.ytp-ad-skip-button-text'
  ];

  // Ad Banners & Companion Renderers
  const YOUTUBE_AD_ELEMENT_SELECTORS = [
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
    'ytd-rich-item-renderer:has(ytd-ad-slot-renderer)',
    'ytd-reel-video-renderer:has(.ytd-ad-slot-renderer)',
    '.ytd-merch-shelf-renderer',
    'tp-yt-paper-dialog:has(ytd-enforcement-message-view-model)'
  ];

  /**
   * Synthetically trigger full pointer/mouse/click events on element
   */
  function triggerClick(el) {
    if (!el) return;
    try {
      const eventTypes = ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click'];
      for (const evtName of eventTypes) {
        el.dispatchEvent(new MouseEvent(evtName, {
          bubbles: true,
          cancelable: true,
          view: window
        }));
      }
      if (typeof el.click === 'function') {
        el.click();
      }
    } catch (e) {}
  }

  /**
   * Inspect player DOM to determine if a video ad is actively showing
   */
  function isYouTubeAdActive() {
    const player = document.querySelector('#movie_player') || document.querySelector('.html5-video-player');
    if (!player) return false;

    // Check player classes indicating an ad stream
    if (
      player.classList.contains('ad-showing') ||
      player.classList.contains('ad-interrupting') ||
      player.classList.contains('ad-created')
    ) {
      return true;
    }

    // Check presence of player ad overlays
    if (player.querySelector('.ytp-ad-player-overlay, .ytp-ad-player-overlay-layout, .ytp-ad-text')) {
      return true;
    }

    // Check video-ads container
    const videoAds = player.querySelector('.video-ads');
    if (videoAds && videoAds.children.length > 0) {
      return true;
    }

    // Check for any active skip button in the DOM
    for (const selector of YOUTUBE_SKIP_SELECTORS) {
      if (document.querySelector(selector)) {
        return true;
      }
    }

    return false;
  }

  /**
   * Main YouTube zero-delay neutralization pass
   */
  function processYouTube() {
    if (!isProtectionActive() || !moduleSettings.blockYouTubeAds) return;

    const isAd = isYouTubeAdActive();
    const video = document.querySelector('video.html5-main-video') || document.querySelector('video');

    if (isAd) {
      // 1. Instantly click all available skip buttons
      for (const selector of YOUTUBE_SKIP_SELECTORS) {
        try {
          const buttons = document.querySelectorAll(selector);
          for (const btn of buttons) {
            triggerClick(btn);
            recordAdBlocked(1);
          }
        } catch (e) {}
      }

      // 2. Accelerate and silence video ad playback
      if (video) {
        if (!video.muted) {
          video.dataset.cbWasMutedByAdBlock = 'true';
          video.muted = true;
        }

        video.dataset.cbAdSpeedModified = 'true';
        video.playbackRate = 16.0;

        if (isFinite(video.duration) && video.duration > 0) {
          // Fast-forward straight to the end of the ad
          video.currentTime = video.duration;
        }

        if (video.paused) {
          video.play().catch(() => {});
        }

        recordAdBlocked(1);
      }

      // 3. Invoke internal YouTube player skipAd API if exposed
      const moviePlayer = document.getElementById('movie_player') || document.querySelector('.html5-video-player');
      if (moviePlayer && typeof moviePlayer.skipAd === 'function') {
        try {
          moviePlayer.skipAd();
        } catch (e) {}
      }

      // 4. Start high-frequency requestAnimationFrame loop while ad is active
      if (!youtubeRafId) {
        youtubeRafId = requestAnimationFrame(stepYouTubeAdFast);
      }
    } else {
      youtubeRafId = null;

      // Ad ended - restore user's normal video playback speed and audio
      if (video && video.dataset.cbAdSpeedModified) {
        delete video.dataset.cbAdSpeedModified;
        video.playbackRate = 1.0;
        if (video.dataset.cbWasMutedByAdBlock) {
          delete video.dataset.cbWasMutedByAdBlock;
          video.muted = false;
        }
        if (video.paused) {
          video.play().catch(() => {});
        }
      }
    }

    // 5. Instantly hide cosmetic ad banners and promoted cards
    for (const selector of YOUTUBE_AD_ELEMENT_SELECTORS) {
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

    // 6. Dismiss Anti-Adblock modal dialog if presented
    try {
      const enforcementDialog = document.querySelector('ytd-enforcement-message-view-model') ||
        document.querySelector('tp-yt-paper-dialog:has(ytd-enforcement-message-view-model)');

      if (enforcementDialog) {
        enforcementDialog.remove();
        if (video && video.paused) {
          video.play().catch(() => {});
        }
      }
    } catch (e) {}
  }

  /**
   * requestAnimationFrame loop for sub-16ms ad destruction
   */
  function stepYouTubeAdFast() {
    if (isProtectionActive() && moduleSettings.blockYouTubeAds && isYouTubeAdActive()) {
      processYouTube();
      youtubeRafId = requestAnimationFrame(stepYouTubeAdFast);
    } else {
      youtubeRafId = null;
      processYouTube();
    }
  }

  /**
   * Attach high-priority MutationObserver and media listeners for zero delay
   */
  function setupYouTubeZeroDelayEngine() {
    if (!hostname.includes('youtube.com')) return;

    // 1. Observe player mutations directly (microtask-level response)
    const player = document.querySelector('#movie_player') || document.querySelector('.html5-video-player');
    if (player && !youtubePlayerObserver) {
      youtubePlayerObserver = new MutationObserver(() => {
        if (isProtectionActive()) {
          processYouTube();
        }
      });

      youtubePlayerObserver.observe(player, {
        childList: true,
        subtree: true,
        attributes: true,
        attributeFilter: ['class', 'src']
      });
    }

    // 2. Bind video element hardware events
    const video = document.querySelector('video.html5-main-video') || document.querySelector('video');
    if (video && !video.dataset.cbBound) {
      video.dataset.cbBound = 'true';
      video.addEventListener('timeupdate', () => {
        if (isProtectionActive() && isYouTubeAdActive()) {
          processYouTube();
        }
      }, { passive: true });
      video.addEventListener('loadeddata', () => {
        if (isProtectionActive()) processYouTube();
      }, { passive: true });
      video.addEventListener('play', () => {
        if (isProtectionActive()) processYouTube();
      }, { passive: true });
    }

    // 3. Fast fallback interval (100ms)
    if (!youtubeInterval) {
      youtubeInterval = setInterval(() => {
        if (isProtectionActive()) {
          processYouTube();
          // Ensure observer and video handlers are attached if player freshly mounted
          if (!youtubePlayerObserver || !document.querySelector('video[data-cb-bound]')) {
            setupYouTubeZeroDelayEngine();
          }
        }
      }, 100);
    }
  }

  /* ==========================================================================
     Social Media Sponsored Removal Engines (FB, IG, X, Reddit)
     ========================================================================== */

  function processFacebook() {
    if (!isProtectionActive() || !moduleSettings.blockSocialAds) return;

    const posts = document.querySelectorAll('div[data-pagelet^="FeedUnit"], div[role="feed"] > div');
    for (const post of posts) {
      if (post.dataset.cbProcessed) continue;

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
      if (!ad.dataset.cbProcessed) {
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
      if (article.dataset.cbProcessed) continue;

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
      post.dataset.cbProcessed = 'true';
      post.style.setProperty('display', 'none', 'important');
      recordAdBlocked(1);
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
          el.dataset.cbProcessed = 'true';
          el.style.setProperty('display', 'none', 'important');
          recordAdBlocked(1);
        }
      } catch (e) {}
    }

    if (moduleSettings.blockCookieBanners) {
      for (const selector of COOKIE_BANNER_SELECTORS) {
        try {
          const matches = document.querySelectorAll(selector + ':not([data-cb-processed])');
          for (const el of matches) {
            el.dataset.cbProcessed = 'true';
            el.style.setProperty('display', 'none', 'important');
            recordAdBlocked(1);
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
        processYouTube();
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
    if (target.closest('.cb-picker-hud')) return;

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
    if (e.target.closest('.cb-picker-hud')) return;

    e.preventDefault();
    e.stopPropagation();

    const target = hoveredElement || e.target;
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
      setupYouTubeZeroDelayEngine();
    }
  }

  function stopProtection() {
    updateCosmeticClass();
    flushPendingBlockedCount();

    if (observer) {
      observer.disconnect();
      observer = null;
    }

    if (youtubePlayerObserver) {
      youtubePlayerObserver.disconnect();
      youtubePlayerObserver = null;
    }

    if (youtubeInterval) {
      clearInterval(youtubeInterval);
      youtubeInterval = null;
    }

    if (youtubeRafId) {
      cancelAnimationFrame(youtubeRafId);
      youtubeRafId = null;
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

    // YouTube SPA navigation listeners
    if (hostname.includes('youtube.com')) {
      window.addEventListener('yt-navigate-finish', setupYouTubeZeroDelayEngine, { passive: true });
      window.addEventListener('spfdone', setupYouTubeZeroDelayEngine, { passive: true });
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
