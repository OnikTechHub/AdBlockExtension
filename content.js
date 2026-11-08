"use strict";
(() => {
  // src/content.ts
  (() => {
    "use strict";
    let isEnabled = true;
    let whitelistedDomains = [];
    let customFilters = {};
    let moduleSettings = {
      blockYouTubeAds: true,
      blockSocialAds: true,
      blockCookieBanners: true
    };
    let blockedCountOnPage = 0;
    let pendingCountToSync = 0;
    let syncTimer = null;
    let domObserver = null;
    let youtubeSafetyTimer = null;
    let isPickerActive = false;
    let hoveredElement = null;
    let pickerHud = null;
    const hostname = window.location.hostname.toLowerCase();
    const isYouTubeSite = hostname.includes("youtube.com");
    function isSiteWhitelisted() {
      return whitelistedDomains.some((domain) => {
        const d = domain.toLowerCase().trim();
        return hostname === d || hostname.endsWith("." + d);
      });
    }
    function isProtectionActive() {
      return isEnabled && !isSiteWhitelisted();
    }
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
              type: "AD_BLOCKED",
              count,
              domain: hostname
            }).catch(() => {
            });
          }
        } catch {
        }
      }
    }
    function updateCosmeticClass() {
      if (isProtectionActive()) {
        document.documentElement.classList.remove("cb-disabled");
        applyCustomFilters();
      } else {
        document.documentElement.classList.add("cb-disabled");
        removeCustomFilters();
      }
    }
    function applyCustomFilters() {
      if (!isProtectionActive()) return;
      let styleEl = document.getElementById("cb-custom-filters-style");
      const domainFilters = [];
      for (const [domain, selectors] of Object.entries(customFilters)) {
        if (domain === "*" || hostname === domain || hostname.endsWith("." + domain)) {
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
        styleEl = document.createElement("style");
        styleEl.id = "cb-custom-filters-style";
        (document.head || document.documentElement).appendChild(styleEl);
      }
      styleEl.textContent = domainFilters.map((sel) => `${sel} { display: none !important; visibility: hidden !important; }`).join("\n");
    }
    function removeCustomFilters() {
      const styleEl = document.getElementById("cb-custom-filters-style");
      if (styleEl) styleEl.remove();
    }
    const YOUTUBE_SKIP_SELECTORS = [
      ".ytp-ad-skip-button",
      ".ytp-ad-skip-button-modern",
      ".ytp-skip-ad-button",
      ".ytp-ad-skip-button-slot button",
      ".ytp-ad-skip-button-container button",
      "button.ytp-ad-skip-button",
      "button.ytp-ad-skip-button-modern",
      ".videoAdUiSkipButton",
      '[id^="skip-button:"] button',
      'button[class*="ytp-ad-skip-button"]',
      'button[class*="ytp-skip-ad-button"]',
      ".ytp-ad-overlay-close-button"
    ];
    const YOUTUBE_COMPANION_AD_SELECTORS = [
      "#player-ads",
      ".ytp-ad-overlay-container",
      ".ytp-ad-message-container",
      ".ytp-ad-action-interstitial",
      "ytd-ad-slot-renderer",
      "#secondary ytd-ad-slot-renderer",
      "ytd-in-feed-ad-layout-renderer",
      "#masthead-ad",
      "ytd-banner-promo-renderer"
    ];
    function triggerSkipButtons(container = document) {
      for (const selector of YOUTUBE_SKIP_SELECTORS) {
        try {
          const btn = container.querySelector(selector);
          if (btn) {
            btn.click();
            recordAdBlocked(1);
            return true;
          }
        } catch {
        }
      }
      return false;
    }
    function handleYouTubeAds() {
      if (!isProtectionActive() || !moduleSettings.blockYouTubeAds) return;
      const player = document.getElementById("movie_player") || document.querySelector(".html5-video-player");
      if (!player) return;
      const isAdActive = Boolean(
        player.classList.contains("ad-showing") || player.classList.contains("ad-interrupting")
      );
      const video = document.querySelector("video.html5-main-video") || player.querySelector("video");
      if (isAdActive) {
        if (video && !video.muted) {
          video.dataset.cbWasMuted = "true";
          video.muted = true;
          recordAdBlocked(1);
        }
        triggerSkipButtons(player);
      } else {
        if (video && video.dataset.cbWasMuted === "true") {
          delete video.dataset.cbWasMuted;
          video.muted = false;
        }
      }
      for (const selector of YOUTUBE_COMPANION_AD_SELECTORS) {
        try {
          const matches = document.querySelectorAll(selector);
          for (const el of matches) {
            if (!el.dataset.cbProcessed) {
              el.dataset.cbProcessed = "true";
              el.style.setProperty("display", "none", "important");
              recordAdBlocked(1);
            }
          }
        } catch {
        }
      }
      try {
        const modal = document.querySelector("tp-yt-paper-dialog:has(ytd-enforcement-message-view-model), ytd-enforcement-message-view-model");
        if (modal) {
          modal.remove();
          if (video && video.paused) {
            video.play().catch(() => {
            });
          }
        }
      } catch {
      }
    }
    function processFacebook() {
      if (!isProtectionActive() || !moduleSettings.blockSocialAds) return;
      const feedUnits = document.querySelectorAll('div[data-pagelet^="FeedUnit"]:not([data-cb-processed]), div[role="feed"] > div:not([data-cb-processed])');
      for (const post of feedUnits) {
        if (!post) continue;
        post.dataset.cbProcessed = "true";
        let isSponsored = false;
        if (post.querySelector('a[href*="/ads/about"], a[href*="ads/about"]')) {
          isSponsored = true;
        } else if (post.querySelector('[aria-label="Sponsored"], [aria-label="Gesponsert"], [aria-label="Publicidad"], [aria-label="Sponsoris\xE9"]')) {
          isSponsored = true;
        } else {
          const textElements = post.querySelectorAll("span, a");
          for (const el of textElements) {
            const text = (el?.textContent || "").trim().toLowerCase();
            if (text === "sponsored" || text === "gesponsert" || text === "publicidad" || text.startsWith("sponsored \xB7")) {
              isSponsored = true;
              break;
            }
          }
        }
        if (isSponsored) {
          post.classList.add("cb-hidden-ad");
          post.style.setProperty("display", "none", "important");
          recordAdBlocked(1);
        }
      }
      const sidebarAds = document.querySelectorAll('div[role="complementary"] div:has(a[href*="/ads/about"]):not([data-cb-processed]), div[aria-label="Advertiser"]:not([data-cb-processed])');
      for (const ad of sidebarAds) {
        if (ad) {
          ad.dataset.cbProcessed = "true";
          ad.classList.add("cb-hidden-ad");
          ad.style.setProperty("display", "none", "important");
          recordAdBlocked(1);
        }
      }
    }
    function processInstagram() {
      if (!isProtectionActive() || !moduleSettings.blockSocialAds) return;
      const articles = document.querySelectorAll("article:not([data-cb-processed])");
      for (const article of articles) {
        if (!article) continue;
        article.dataset.cbProcessed = "true";
        const text = (article.textContent || "").toLowerCase();
        if (text.includes("sponsored") || text.includes("paid partnership with")) {
          article.classList.add("cb-hidden-ad");
          article.style.setProperty("display", "none", "important");
          recordAdBlocked(1);
        }
      }
    }
    function processTwitter() {
      if (!isProtectionActive() || !moduleSettings.blockSocialAds) return;
      const tweets = document.querySelectorAll("article:not([data-cb-processed])");
      for (const tweet of tweets) {
        if (!tweet) continue;
        tweet.dataset.cbProcessed = "true";
        if (tweet.querySelector('[data-testid="placementTracking"]') || tweet.innerText?.includes("Ad\n") || tweet.innerText?.includes("Promoted")) {
          tweet.style.setProperty("display", "none", "important");
          recordAdBlocked(1);
        }
      }
    }
    function processReddit() {
      if (!isProtectionActive() || !moduleSettings.blockSocialAds) return;
      const posts = document.querySelectorAll('shreddit-post[is-promoted="true"]:not([data-cb-processed]), .promotedlink:not([data-cb-processed])');
      for (const post of posts) {
        if (post) {
          post.dataset.cbProcessed = "true";
          post.style.setProperty("display", "none", "important");
          recordAdBlocked(1);
        }
      }
    }
    const COMMON_WEB_AD_SELECTORS = [
      "ins.adsbygoogle",
      'iframe[id^="aswift_"]',
      'iframe[id^="google_ads_frame"]',
      'div[id^="google_ads_iframe"]',
      'div[id^="div-gpt-ad"]',
      '[class*="gpt-ad"]',
      "[data-ad-unit]",
      "[data-ad-slot]",
      "[data-ad-client]",
      "[data-ad-zone]",
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
      "[data-google-query-id]",
      ".OUTBRAIN",
      '[id^="outbrain_widget"]',
      ".trc_related_container",
      ".trc_rbox_div",
      '[id^="taboola-"]',
      ".tbl-feed-container",
      ".revcontent",
      ".mgid",
      '[class*="popup-ad"]',
      '[class*="ad-popup"]',
      '[id*="ad-modal"]',
      '[id*="ad_popup"]'
    ];
    const COOKIE_BANNER_SELECTORS = [
      "#onetrust-consent-sdk",
      "#CybotCookiebotDialog",
      ".cc-banner",
      ".cc-window",
      "#cookie-law-info-bar",
      ".cookie-notice-container"
    ];
    function processGeneralWeb() {
      if (!isProtectionActive()) return;
      for (const selector of COMMON_WEB_AD_SELECTORS) {
        try {
          const matches = document.querySelectorAll(selector + ":not([data-cb-processed])");
          for (const el of matches) {
            if (el) {
              el.dataset.cbProcessed = "true";
              el.style.setProperty("display", "none", "important");
              recordAdBlocked(1);
            }
          }
        } catch {
        }
      }
      if (moduleSettings.blockCookieBanners) {
        for (const selector of COOKIE_BANNER_SELECTORS) {
          try {
            const matches = document.querySelectorAll(selector + ":not([data-cb-processed])");
            for (const el of matches) {
              if (el) {
                el.dataset.cbProcessed = "true";
                el.style.setProperty("display", "none", "important");
                recordAdBlocked(1);
              }
            }
          } catch {
          }
        }
      }
    }
    function processGenericVideoAds() {
      triggerSkipButtons(document);
      const videoAdContainers = document.querySelectorAll('.video-ads, [class*="video-ad"], [class*="ad-player"], .ima-ad-container');
      for (const container of videoAdContainers) {
        const video = container.querySelector("video");
        if (video && !video.muted) {
          video.dataset.cbWasMuted = "true";
          video.muted = true;
        }
        triggerSkipButtons(container);
      }
    }
    function runScan() {
      if (!isProtectionActive()) return;
      if (isYouTubeSite) {
        handleYouTubeAds();
      } else {
        if (hostname.includes("facebook.com")) {
          processFacebook();
        } else if (hostname.includes("instagram.com")) {
          processInstagram();
        } else if (hostname.includes("twitter.com") || hostname.includes("x.com")) {
          processTwitter();
        } else if (hostname.includes("reddit.com")) {
          processReddit();
        } else {
          processGeneralWeb();
        }
        processGenericVideoAds();
      }
    }
    function computeUniqueSelector(element) {
      if (!element || element === document.body || element === document.documentElement) return "";
      if (element.id && !element.id.match(/\d{4,}/)) {
        return `#${CSS.escape(element.id)}`;
      }
      const cleanClasses = Array.from(element.classList).filter((c) => !c.startsWith("cb-") && !c.match(/\d{4,}/));
      if (cleanClasses.length > 0) {
        return `${element.tagName.toLowerCase()}.${cleanClasses.map((c) => CSS.escape(c)).join(".")}`;
      }
      const parent = element.parentElement;
      if (!parent) return element.tagName.toLowerCase();
      const sameTagSiblings = Array.from(parent.children).filter((child) => child.tagName === element.tagName);
      if (sameTagSiblings.length === 1) {
        return `${computeUniqueSelector(parent)} > ${element.tagName.toLowerCase()}`;
      }
      const childIndex = sameTagSiblings.indexOf(element) + 1;
      return `${computeUniqueSelector(parent)} > ${element.tagName.toLowerCase()}:nth-of-type(${childIndex})`;
    }
    function onPickerMouseOver(event) {
      if (!isPickerActive) return;
      const target = event.target;
      if (!target || target.closest(".cb-picker-hud")) return;
      if (hoveredElement) {
        hoveredElement.classList.remove("cb-picker-highlight");
      }
      hoveredElement = target;
      hoveredElement.classList.add("cb-picker-highlight");
    }
    function onPickerMouseOut() {
      if (!isPickerActive) return;
      if (hoveredElement) {
        hoveredElement.classList.remove("cb-picker-highlight");
        hoveredElement = null;
      }
    }
    function onPickerClick(event) {
      if (!isPickerActive) return;
      const target = event.target;
      if (target && target.closest(".cb-picker-hud")) return;
      event.preventDefault();
      event.stopPropagation();
      const selected = hoveredElement || target;
      if (!selected) return;
      const selector = computeUniqueSelector(selected);
      if (selector) {
        selected.style.setProperty("display", "none", "important");
        recordAdBlocked(1);
        chrome.runtime.sendMessage({
          type: "ADD_CUSTOM_FILTER",
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
    function onPickerKeyDown(event) {
      if (event.key === "Escape" && isPickerActive) {
        stopElementPicker();
      }
    }
    function startElementPicker() {
      if (isPickerActive) return;
      isPickerActive = true;
      pickerHud = document.createElement("div");
      pickerHud.className = "cb-picker-hud";
      pickerHud.innerHTML = `
      <div class="cb-picker-hud-info">
        <span class="cb-picker-hud-title">Chrome Blocks Picker</span>
        <span class="cb-picker-hud-sub">Click any element to permanently block it (Esc to cancel)</span>
      </div>
      <button class="cb-picker-hud-btn" id="cb-cancel-picker">Cancel</button>
    `;
      document.body.appendChild(pickerHud);
      document.getElementById("cb-cancel-picker")?.addEventListener("click", stopElementPicker);
      document.addEventListener("mouseover", onPickerMouseOver, true);
      document.addEventListener("mouseout", onPickerMouseOut, true);
      document.addEventListener("click", onPickerClick, true);
      document.addEventListener("keydown", onPickerKeyDown, true);
    }
    function stopElementPicker() {
      if (!isPickerActive) return;
      isPickerActive = false;
      if (hoveredElement) {
        hoveredElement.classList.remove("cb-picker-highlight");
        hoveredElement = null;
      }
      if (pickerHud) {
        pickerHud.remove();
        pickerHud = null;
      }
      document.removeEventListener("mouseover", onPickerMouseOver, true);
      document.removeEventListener("mouseout", onPickerMouseOut, true);
      document.removeEventListener("click", onPickerClick, true);
      document.removeEventListener("keydown", onPickerKeyDown, true);
    }
    function startProtection() {
      updateCosmeticClass();
      runScan();
      if (!domObserver && (document.body || document.documentElement)) {
        let rAF = null;
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
          attributeFilter: ["class"]
        });
      }
      if (isYouTubeSite && !youtubeSafetyTimer) {
        youtubeSafetyTimer = setInterval(() => {
          if (isProtectionActive()) {
            handleYouTubeAds();
          }
        }, 500);
      }
    }
    function stopProtection() {
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
      const hiddenElements = document.querySelectorAll(".cb-hidden-ad, [data-cb-processed]");
      for (const el of hiddenElements) {
        el.style.removeProperty("display");
      }
    }
    function init() {
      if (!chrome.storage || !chrome.storage.local) {
        startProtection();
        return;
      }
      chrome.storage.local.get(["isEnabled", "whitelistedDomains", "customFilters", "moduleSettings"], (res) => {
        if (chrome.runtime.lastError) {
          startProtection();
          return;
        }
        if (res.isEnabled !== void 0) isEnabled = Boolean(res.isEnabled);
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
        if (areaName !== "local") return;
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
        if (changes.moduleSettings && typeof changes.moduleSettings.newValue === "object") {
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
      chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
        if (message.type === "GET_TAB_STATS") {
          const response = {
            domain: hostname,
            blockedOnPage: blockedCountOnPage,
            isWhitelisted: isSiteWhitelisted(),
            isEnabled: isProtectionActive()
          };
          sendResponse(response);
        } else if (message.type === "START_ELEMENT_PICKER") {
          startElementPicker();
          sendResponse({ success: true });
        }
        return true;
      });
      if (isYouTubeSite) {
        window.addEventListener("yt-navigate-finish", () => {
          handleYouTubeAds();
        }, { passive: true });
        window.addEventListener("spfdone", () => {
          handleYouTubeAds();
        }, { passive: true });
      } else {
        window.addEventListener("popstate", runScan, { passive: true });
      }
    }
    if (document.readyState === "loading") {
      document.addEventListener("DOMContentLoaded", init, { once: true });
    } else {
      init();
    }
    window.addEventListener("beforeunload", flushPendingBlockedCount);
  })();
})();
