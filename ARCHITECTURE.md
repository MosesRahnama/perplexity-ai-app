# Perplexity AI Desktop App - Architecture Documentation

**Version:** 4.0.1  
**Platform:** Electron-based cross-platform desktop application  
**Target OS:** Windows 11 (primary), macOS, Linux

---

## Table of Contents

1. [Overview](#overview)
2. [Repository Structure](#repository-structure)
3. [Build System](#build-system)
4. [Application Architecture](#application-architecture)
5. [IPC Communication](#ipc-communication)
6. [Plugin & Extension Points](#plugin--extension-points)
7. [State Management](#state-management)
8. [Update Mechanism](#update-mechanism)
9. [Telemetry](#telemetry)
10. [Authentication](#authentication)
11. [Security Model](#security-model)

---

## Overview

The Perplexity AI Desktop App is an Electron-based wrapper providing desktop access to perplexity.ai and labs.perplexity.ai with enhanced features including:

- **System Tray Integration**: Minimize to tray, persistent background operation
- **Global Shortcuts**: Quick search, custom prefix search, navigation
- **Session Persistence**: State retention across restarts
- **Notification System**: GitHub CDN-based notification polling
- **Auto-update Checker**: Version comparison with rollback support
- **Multi-view Management**: Cached BrowserView instances for performance

---

## Repository Structure

```
perplexity-ai-app/
├── main.js                          # Main process entry point
├── notification-manager.js          # Notification polling & display logic
├── search-service.js                # Quick search & clipboard integration
├── build-auto.js                    # OS detection & build automation
├── package.json                     # NPM config & electron-builder settings
│
├── src/
│   ├── js/
│   │   ├── preload/                 # Context bridge scripts
│   │   │   ├── preload.js           # Main window preload
│   │   │   ├── preload_inject.js    # BrowserView injection
│   │   │   ├── preload_notification.js
│   │   │   ├── preload_notification_panel.js
│   │   │   ├── preload_update.js
│   │   │   └── preload_prefix.js
│   │   └── renderer/                # Renderer process scripts
│   │       ├── renderer.js          # Main UI logic
│   │       ├── notification_renderer.js
│   │       ├── notification_panel_renderer.js
│   │       └── update_renderer.js
│   └── css/                         # Stylesheets
│
├── assets/                          # Icons, images
├── notifications/                   # Notification content (Markdown)
│   ├── notification-manifest.json
│   └── notification-*.md
├── release_notes/                   # Version changelogs
│
└── HTML files:
    ├── index.html                   # Main window
    ├── settings.html                # Settings modal
    ├── update.html                  # Update prompt
    ├── notification.html            # Single notification viewer
    ├── notification-panel.html      # Notification list
    └── prefix-search.html           # Custom prefix input
```

---

## Build System

### Build Tool: `electron-builder`

**Configuration:** `package.json` → `build` section

### Build Targets

| Platform | Target          | Output Format          | Notes                        |
|----------|-----------------|------------------------|------------------------------|
| Windows  | `nsis`          | `.exe` installer       | One-click, differential updates |
| macOS    | `dmg`, `zip`    | `.dmg`, `.zip`         | Code-signed (optional)       |
| Linux    | `deb`, `AppImage` | `.deb`, `.AppImage`  | Debian-based + universal     |

### Build Scripts

```bash
npm run package-auto       # Auto-detect OS and build
npm run package-win        # Windows-specific
npm run package-mac        # macOS-specific
npm run package-linux      # Linux-specific
```

### Auto-Detection Logic (`build-auto.js`)

```javascript
detectOS() {
  // Checks os.platform() and /etc/os-release
  // Returns: 'windows', 'mac', 'debian', 'linux-other'
}
```

### Packaging Configuration

- **ASAR Archive:** Enabled for performance
- **Compression:** Maximum
- **Excluded from bundle:**
  - `node_modules` dev files (test, examples, `.d.ts`)
  - Git metadata, logs, markdown (except essential)
  - `package-lock.json`

### Update Channels

- **Stable:** `main` branch via GitHub releases
- **Rollback:** Manual version pinning in `package.json`

---

## Application Architecture

### Main Process (`main.js`)

**Responsibilities:**
- Window lifecycle management (BrowserWindow, BrowserView)
- Global shortcut registration
- System tray creation
- IPC message handling
- Service instantiation (NotificationManager, SearchService)
- Update checking

**Key Components:**

1. **Window Management**
   - `mainWindow`: Primary BrowserWindow (loads `index.html`)
   - `settingsWindow`: Modal for configuration
   - `updateWindow`: Update notification modal
   - `prefixSearchWindow`: Custom prefix input
   - `views{}`: Cached BrowserView instances (max 2)

2. **BrowserView Abstraction**
   - Separate isolated contexts for perplexity.ai and labs.perplexity.ai
   - Preload script injection (`preload_inject.js`)
   - Memory optimization: max 2 cached views, oldest evicted

3. **State Persistence**
   - `electron-store` for settings/shortcuts
   - `electron-window-state` for window geometry

### Notification Manager (`notification-manager.js`)

**Responsibilities:**
- Fetch notification manifest from GitHub CDN
- Poll every 1 hour for new notifications
- Display high-priority notifications
- Track read/dismissed state

**Flow:**
1. Fetch `notification-manifest.json` from `cdn.jsdelivr.net/gh/inulute/perplexity-ai-app@main/notifications/`
2. Compare against local cache (electron-store)
3. Download Markdown content for new notifications
4. Render via `marked.js` with DOMPurify sanitization
5. Update badge count on main UI

**Caching:** 1-hour cooldown between fetches to reduce CDN load

### Search Service (`search-service.js`)

**Responsibilities:**
- Global quick search (selected text → Perplexity search)
- Custom prefix search (e.g., "explain", "meaning of")
- Platform-specific clipboard handling

**Platform Differences:**

| Platform | Copy Method                     | Fallback                |
|----------|---------------------------------|-------------------------|
| Windows  | PowerShell SendKeys             | wscript.shell SendKeys  |
| macOS    | AppleScript keystroke           | N/A                     |
| Linux    | xclip (primary/clipboard)       | xdotool key simulation  |

**X11 Selection Handling (Linux):**
- Primary: Mouse selection
- Clipboard: Ctrl+C copied text
- Fallback: Simulate Ctrl+C via xdotool

---

## IPC Communication

### Channel Registry

#### Main Window (`preload.js`)

| Channel                         | Direction | Purpose                                  |
|---------------------------------|-----------|------------------------------------------|
| `switch-ai-tool`                | R → M     | Switch between perplexity.ai / labs      |
| `open-settings`                 | R → M     | Open settings modal                      |
| `get-shortcuts` / `set-shortcuts` | R ↔ M   | Shortcut configuration                   |
| `open-notification-panel`       | R → M     | Open notification list                   |
| `perform-quick-search`          | R → M     | Trigger quick search on selected text    |
| `toggle-autostart`              | R → M     | Enable/disable launch on boot            |
| `get-app-version`               | R ← M     | Retrieve app version (invoke)            |
| `notification-badge-update`     | R ← M     | Update notification count badge          |
| `page-loading`                  | R ← M     | Loading state indicator                  |

#### Update Window (`preload_update.js`)

| Channel                    | Direction | Purpose                              |
|----------------------------|-----------|--------------------------------------|
| `update-data`              | R ← M     | Send update info (version, notes)    |
| `download-update`          | R → M     | Open download page                   |
| `remind-tomorrow-update`   | R → M     | Defer update check for 23 hours      |

#### Notification System

| Channel                     | Direction | Purpose                            |
|-----------------------------|-----------|-------------------------------------|
| `notification-data`         | R ← M     | Send notification content           |
| `close-notification`        | R → M     | Dismiss notification window         |
| `mark-notification-read`    | R → M     | Mark as read                        |
| `notifications-list`        | R ← M     | Send list to panel                  |

**Note:** R = Renderer, M = Main

---

## Plugin & Extension Points

### Current Extension Mechanisms

1. **Custom Preload Scripts**
   - `preload_inject.js` injected into BrowserView
   - Can manipulate Perplexity web UI via DOM
   - Example: Remove nag screens, inject custom CSS

2. **Protocol Handler**
   - `perplexity-search://` URL scheme
   - Registered in `package.json` → `build.protocols`
   - Handler in `main.js` → `processCommandLineArgs()`

3. **Context Menu Integration**
   - Windows: Registry-based (not yet implemented in code)
   - Linux: `.desktop` file actions (not yet implemented)

### Proposed Enhancement: Provider Abstraction Layer

**Not currently implemented.** The app is a wrapper around Perplexity's web UI with no direct API integration.

**Enhancement Opportunity:**
- Add `providers/` directory for OpenAI, Anthropic, Vertex AI clients
- Create routing layer to multiplex requests
- Implement caching middleware
- Add decision policy hooks (agent selection)

---

## State Management

### Persistence Layer: `electron-store`

**Storage Location:**
- Windows: `%APPDATA%\perplexity-ai-app\config.json`
- macOS: `~/Library/Application Support/perplexity-ai-app/config.json`
- Linux: `~/.config/perplexity-ai-app/config.json`

### Stored State

```json
{
  "defaultAI": "https://perplexity.ai",
  "shortcuts": {
    "perplexityAI": { "key": "Control+1", "enabled": false },
    "perplexityLabs": { "key": "Control+2", "enabled": false },
    "sendToTray": { "key": "Alt+Shift+W", "enabled": false },
    "restoreApp": { "key": "Alt+Shift+Q", "enabled": false },
    "quickSearch": { "key": "Alt+Shift+X", "enabled": false },
    "customPrefixSearch": { "key": "Alt+Shift+D", "enabled": false }
  },
  "notifications": {
    "items": [...],
    "unreadCount": 0
  },
  "dismissedNotifications": [...],
  "lastUpdateCheck": 1234567890,
  "autoStartEnabled": false,
  "hasShownTrayNotification": false,
  "disableHardwareAcceleration": false
}
```

### Window State: `electron-window-state`

Persists:
- Window position (x, y)
- Window size (width, height)
- Maximized/fullscreen state

---

## Update Mechanism

### Version Check Flow

1. **Trigger:** App launch + every 12 hours
2. **Source:** `https://raw.githubusercontent.com/inulute/perplexity-ai-app/main/package.json`
3. **Comparison:** `compareVersions(latest, current)` (semantic versioning)
4. **Display:** Modal with Markdown release notes
5. **Action:** Open GitHub releases page (manual download)

### Update Window (`update.html`)

**Features:**
- Displays latest version
- Renders Markdown release notes from `release_notes/v*.md`
- Sanitizes HTML via DOMPurify
- Options: "Download Update" or "Remind Me Tomorrow"

### Rollback Strategy

**Manual:** User downloads specific version from GitHub releases

**No automatic rollback mechanism** currently implemented.

### Differential Updates

- NSIS installer supports differential package downloads
- Configured via `build.nsis.differentialPackage: true`

---

## Telemetry

### Current State: **NONE**

The application does **not** currently implement any telemetry or analytics.

### Potential Telemetry Points (if implemented):

1. **Usage Metrics:**
   - Active sessions
   - Feature usage (quick search, shortcuts)
   - Crash reports

2. **Privacy Concerns:**
   - No opt-in/opt-out mechanism exists
   - Would require GDPR-compliant disclosure

---

## Authentication

### Current State: **NONE**

The application does not implement authentication. Users authenticate directly with Perplexity's web services in the BrowserView.

**Observed Flow:**
1. User logs in via perplexity.ai web UI
2. Cookies/session tokens stored in Electron session
3. Persisted across app restarts (Electron default behavior)

**Security Implications:**
- Session data stored in `%APPDATA%\perplexity-ai-app\` (unencrypted)
- Vulnerable to local attacks if disk is compromised

---

## Security Model

### Current Security Posture

#### ✅ **Implemented:**

1. **Context Isolation:** Enabled in all BrowserWindows/BrowserViews
2. **Node Integration:** Disabled in renderer processes
3. **Preload Scripts:** Used for controlled IPC bridge
4. **Content Security Policy:** Implicit (Electron defaults)
5. **External Link Handling:** Opens in default browser (not in-app)

#### ⚠️ **Gaps:**

1. **No Secrets Management:** No `.env` support, hardcoded CDN URLs
2. **Session Storage:** Unencrypted on disk
3. **No Code Signing:** Binaries not signed (Windows SmartScreen warnings)
4. **Preload Injection:** `preload_inject.js` has broad DOM access
5. **No Sandboxing:** BrowserView has `sandbox: false` for performance

### Recommended Hardening (Not Implemented)

1. **Environment Variables:** Use `dotenv` for API keys (future provider integration)
2. **Keychain Integration:** Store sensitive data in OS keychain
3. **Code Signing:** Apple Developer ID (macOS), EV cert (Windows)
4. **Subresource Integrity:** Pin CDN resources (jsdelivr.net)
5. **Least Privilege:** Enable sandbox where possible

---

## Dependencies

### Production Dependencies

```json
{
  "electron-clipboard-extended": "^1.1.1",  // Extended clipboard API
  "electron-store": "^7.0.3",               // Persistent storage
  "electron-window-state": "^5.0.3",        // Window geometry persistence
  "marked": "^15.0.11"                      // Markdown rendering
}
```

### Dev Dependencies

```json
{
  "electron": "^33.0.2",           // Electron framework
  "electron-builder": "^25.1.8"    // Build & packaging
}
```

### External CDN Dependencies

- **jsdelivr.net/gh/**: Notification manifest & content
- **GitHub Releases API:** Update checking
- **Perplexity Services:** Core functionality (web wrapper)

---

## Performance Optimizations

1. **View Caching:** Max 2 BrowserView instances, LRU eviction
2. **Memory Management:** 
   - `backgroundThrottling: true`
   - Disable hardware acceleration option
   - Periodic resource cleanup (every 5 minutes)
3. **Lazy Loading:** Notification content fetched on-demand
4. **Debounced Resize:** 200ms delay before adjusting view bounds

---

## Platform-Specific Considerations

### Windows 11

- **Tray Icon:** Persistent in notification area
- **Autostart:** Registry-based (`HKCU\Software\Microsoft\Windows\CurrentVersion\Run`)
- **Copy Method:** PowerShell SendKeys (reliable)

### macOS

- **Dock Behavior:** Hide from dock when in tray
- **Autostart:** Login items
- **Copy Method:** AppleScript keystroke

### Linux

- **Dependencies:** Requires `xclip` and optionally `xdotool`
- **Autostart:** XDG autostart (`.config/autostart/`)
- **X11 Selections:** Primary (mouse) + clipboard

---

## Key Insights for Enhancement

### 1. **No Direct API Integration**
- The app is a web wrapper with no direct Perplexity API calls
- Enhancement: Add provider abstraction for OpenAI, Anthropic, Vertex

### 2. **Notification System is GitHub CDN-Based**
- No webhooks or real-time push
- Enhancement: Add WebSocket support for instant updates

### 3. **No Authentication Layer**
- Relies entirely on Perplexity's web auth
- Enhancement: Implement OAuth flow for API providers

### 4. **Limited Telemetry**
- No crash reporting or usage analytics
- Enhancement: Add opt-in Sentry integration

### 5. **Security Hardening Needed**
- No secrets management (.env)
- No code signing
- Session data unencrypted
- Enhancement: Implement keychain integration, use dotenv

---

## Next Steps for Enhancement Suite

Based on this architecture analysis, the following enhancements are feasible:

1. **Provider Abstraction Layer**
   - Create `src/providers/` directory
   - Implement `BaseProvider` class
   - Add OpenAI, Anthropic, Vertex AI clients
   - Localhost proxy at `http://localhost:8000/v1`

2. **Caching Layer**
   - Add `node-cache` or `lru-cache` dependency
   - Implement TTL-based disk cache (electron-store)
   - Cache OpenAI/Anthropic responses

3. **Decision Policy Hooks**
   - Add `src/policies/` directory
   - Implement routing logic (model selection, rate limiting)
   - Add agent/tool decision framework

4. **Security Enhancements**
   - Add `dotenv` dependency
   - Create `.env.example` and `.env` (gitignored)
   - Implement secrets manager (OS keychain)
   - Add telemetry opt-out setting

5. **CI/CD Pipeline**
   - Create `.github/workflows/ci.yml`
   - Windows build matrix
   - Smoke tests
   - Automated releases

---

## Diagram

See `diagram.puml` for a visual representation of this architecture.

To render:
```bash
plantuml diagram.puml
```

Or use online viewer: http://www.plantuml.com/plantuml/uml/

---

**Document Version:** 1.0  
**Last Updated:** 2025-01-XX  
**Maintained By:** Enhancement Team
