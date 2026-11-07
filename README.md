# Chrome Blocks - Next-Gen Ad & Tracker Shield (Manifest V3)

**Chrome Blocks** is a high-performance, production-ready Google Chrome extension engineered strictly under **Manifest V3** standards. It blocks network ads, trackers, analytics beacons, video ad injections, sponsored social posts, banners, and aggressive popups across the web — with dedicated accelerators for **YouTube**, **Facebook**, and **Instagram**.

---

## 🚀 Key Features

- **Chrome DeclarativeNetRequest Engine**:
  - Preloaded with 114+ high-priority rules intercepting top ad networks (Google DoubleClick, AdSense, AdServices, Facebook Pixel, AppNexus, Taboola, Outbrain, Criteo, Amazon AdSystem, PopAds, etc.).
  - Zero-latency network request cancellation before payloads reach the browser.
  - Full support for dynamic whitelisting via Chrome's dynamic rule priorities.

- **Instant YouTube Ad Skipper & Fast-Forwarder**:
  - Automatically identifies pre-roll, mid-roll, and overlay ads.
  - Automatically silences ad audio and accelerates ad video playback (16x fast-forward) to the finish line in milliseconds.
  - Auto-clicks skip buttons (`.ytp-ad-skip-button`, `.ytp-ad-skip-button-modern`, etc.).
  - Removes sponsored mastheads, companion banners, and dismisses anti-adblock enforcement dialogs.

- **Social Media Sponsored Post Eliminator**:
  - Automatically cleans Facebook and Instagram feeds by detecting obfuscated "Sponsored" indicators, tracking anchors, and right-rail promotional units.

- **Cosmetic Zero-Flicker Style Suppression**:
  - Built-in `content.css` stylesheet instantly collapses ad slots, GPT iframes, Outbrain/Taboola widgets, and popup overlays before DOM rendering.

- **Developer Aesthetic Dark-Themed Popup UI**:
  - Deep slate/navy glassmorphic design (`#070a12`, backdrop blur, electric cyan glow).
  - Smooth ON/OFF master toggle switch.
  - Real-time statistics counters: **Total Ads Blocked**, **Blocked Today**, **Est. Data Saved**, and **Est. Time Saved**.
  - Site-specific toggle to pause/resume ad blocking on any individual domain.
  - Live extension badge counter showing blocked ads on the current tab.

---

## 📂 Project Structure

```
AdBlockExtension/
├── .gitignore            # Git exclusion rules for OS, IDE & build caches
├── LICENSE               # MIT License file
├── README.md             # Project documentation & Git instructions
├── manifest.json         # Manifest V3 configuration & permission declarations
├── rules.json            # DeclarativeNetRequest network blocking ruleset (114+ rules)
├── background.js         # Service worker: DNR ruleset controller, stats tracker, badge sync
├── content.js            # Content script: YouTube skipper, Facebook cleaner, DOM mutation observer
├── content.css           # Zero-flicker cosmetic ad suppression stylesheet
├── popup.html            # Glassmorphic dark popup interface
├── popup.css             # Developer-grade dark styling & animations
├── popup.js              # Real-time state management, site whitelisting & stats counter
└── icons/                # High-resolution extension icons
    ├── icon16.png
    ├── icon32.png
    ├── icon48.png
    └── icon128.png
```

---

## 🛠️ How to Load into Google Chrome

1. Open **Google Chrome** (or any Chromium browser: Brave, Edge, Opera, Vivaldi).
2. Navigate to `chrome://extensions/` in the URL address bar.
3. Enable **Developer mode** toggle in the top-right corner.
4. Click the **Load unpacked** button in the top-left corner.
5. Select this folder: `H:\OD Project\AdBlockExtension`.
6. Pin **Chrome Blocks** to your Chrome toolbar for easy access.

> [!NOTE]
> The `.git` repository folder, `.gitignore`, `README.md`, and `LICENSE` files are safely ignored by Chrome's extension loader and will **never** interfere with extension loading or performance.

---

## 🔄 Git Workflow & Version Control

To stage, commit, and push updates using **Git Bash** or your preferred terminal:

```bash
# 1. Check working tree status
git status

# 2. Stage all changes (cleanly filtered by .gitignore)
git add .

# 3. Commit with a structured message
git commit -m "feat: complete Manifest V3 Chrome Blocks ad blocker with DNR & YouTube skipper"

# 4. Push to remote repository (main branch)
git push origin main
```

---

## 🛡️ Manifest V3 Permissions Explained

- `declarativeNetRequest`: Network-level ad and tracker blocking.
- `declarativeNetRequestFeedback`: Real-time blocked request telemetry for statistics.
- `storage`: Persists master enable/disable state, blocked counts, and whitelisted sites in `chrome.storage.local`.
- `activeTab` & `scripting`: Enables site-specific pause/resume and communication with the active webpage.
- `host_permissions: ["<all_urls>"]`: Enables protection and ad blocking across all visited websites.

---

## 📄 License

This project is licensed under the MIT License - see the [LICENSE](LICENSE) file for details.
