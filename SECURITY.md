# Security Policy

## Overview

This document outlines the security posture, best practices, and hardening recommendations for the Perplexity AI Desktop App.

---

## Supported Versions

| Version | Supported          | Notes                                  |
| ------- | ------------------ | -------------------------------------- |
| 4.0.1   | :white_check_mark: | Current stable release                 |
| 4.0.0   | :white_check_mark: | Rollback version (supported)           |
| < 4.0.0 | :x:                | No longer supported, upgrade required  |

---

## Reporting a Vulnerability

If you discover a security vulnerability, please report it responsibly:

1. **DO NOT** create a public GitHub issue
2. Email: [security contact - to be configured]
3. Include:
   - Description of the vulnerability
   - Steps to reproduce
   - Potential impact
   - Suggested fix (if any)

We aim to respond within **48 hours** and provide a fix within **7 days** for critical issues.

---

## Security Architecture

### Current Implementation

#### ✅ **Implemented Security Measures**

1. **Context Isolation**
   - All BrowserWindow and BrowserView instances use `contextIsolation: true`
   - Prevents renderer processes from directly accessing Node.js APIs

2. **Node Integration Disabled**
   - `nodeIntegration: false` in all renderer contexts
   - Reduces attack surface for XSS vulnerabilities

3. **Preload Scripts**
   - Controlled IPC bridge via `contextBridge.exposeInMainWorld()`
   - Explicit whitelist of exposed APIs

4. **External Link Handling**
   - External URLs open in default browser, not in-app
   - Prevents navigation hijacking

5. **Update Verification**
   - Version comparison using semantic versioning
   - Manual download from GitHub releases (HTTPS)

6. **Session Isolation**
   - Separate BrowserView instances for different domains
   - Prevents cross-site tracking

---

### ⚠️ **Security Gaps & Hardening Needed**

#### 1. **Secrets Management**

**Current State:**
- API keys stored in `.env` file (plaintext on disk)
- Session cookies stored unencrypted in app data directory

**Recommended:**
- Use OS keychain integration (Keytar or Electron's safeStorage API)
- Encrypt sensitive data at rest
- Clear secrets from memory after use

**Implementation:**

```javascript
// Use Electron's safeStorage API (Electron 13+)
const { safeStorage } = require('electron');

function storeSecret(key, value) {
  const encrypted = safeStorage.encryptString(value);
  settings.set(key, encrypted.toString('base64'));
}

function getSecret(key) {
  const encrypted = Buffer.from(settings.get(key), 'base64');
  return safeStorage.decryptString(encrypted);
}
```

#### 2. **Code Signing**

**Current State:**
- Binaries are **not code-signed**
- Windows SmartScreen warnings
- macOS Gatekeeper blocks unsigned apps

**Recommended:**
- Windows: EV Code Signing Certificate (~$400/year)
- macOS: Apple Developer ID ($99/year)
- Linux: Sign with GPG key

**electron-builder Configuration:**

```json
{
  "win": {
    "certificateFile": "./certs/cert.p12",
    "certificatePassword": "${CERT_PASSWORD}",
    "signingHashAlgorithms": ["sha256"],
    "signAndEditExecutable": true
  },
  "mac": {
    "identity": "Developer ID Application: Your Name (TEAM_ID)",
    "hardenedRuntime": true,
    "gatekeeperAssess": false,
    "entitlements": "./entitlements.mac.plist",
    "entitlementsInherit": "./entitlements.mac.plist"
  }
}
```

#### 3. **Sandboxing**

**Current State:**
- BrowserView has `sandbox: false` for performance
- No process sandboxing

**Recommended:**
- Enable sandbox where possible
- Use least-privilege principle

**Mitigation:**

```javascript
// Enable sandbox for content views
currentView = new BrowserView({
  webPreferences: {
    sandbox: true,  // Enable
    contextIsolation: true,
    preload: path.join(__dirname, 'preload.js')
  }
});
```

**Trade-off:** May impact performance; test thoroughly.

#### 4. **Content Security Policy (CSP)**

**Current State:**
- No explicit CSP headers
- Relies on Electron defaults

**Recommended:**
- Set strict CSP for all renderer processes

**Implementation:**

```javascript
// In main.js, for each BrowserWindow
mainWindow.webContents.session.webRequest.onHeadersReceived((details, callback) => {
  callback({
    responseHeaders: {
      ...details.responseHeaders,
      'Content-Security-Policy': [
        "default-src 'self'; " +
        "script-src 'self' 'unsafe-inline'; " +
        "style-src 'self' 'unsafe-inline'; " +
        "img-src 'self' data: https:; " +
        "connect-src 'self' https://api.openai.com https://api.anthropic.com;"
      ]
    }
  });
});
```

#### 5. **Input Validation**

**Current State:**
- Limited input sanitization
- IPC messages not validated

**Recommended:**
- Validate all IPC inputs
- Sanitize user-provided data before processing

**Implementation:**

```javascript
// In main.js IPC handlers
ipcMain.handle('ai-complete', async (event, params) => {
  // Validate input
  if (!params || typeof params.prompt !== 'string') {
    throw new Error('Invalid input: prompt must be a string');
  }
  
  if (params.prompt.length > 100000) {
    throw new Error('Prompt too long (max 100k chars)');
  }
  
  // Sanitize
  const sanitizedPrompt = params.prompt
    .replace(/[\x00-\x1F\x7F]/g, '') // Remove control characters
    .trim();
  
  // Process...
});
```

#### 6. **Dependency Vulnerabilities**

**Current State:**
- 4 known vulnerabilities (2 low, 1 moderate, 1 critical)
- Dependencies not regularly audited

**Recommended:**
- Run `npm audit` regularly
- Update dependencies quarterly
- Use Dependabot or Snyk for automated alerts

**Action:**

```bash
# Check vulnerabilities
npm audit

# Auto-fix (non-breaking)
npm audit fix

# Force fix (may break)
npm audit fix --force
```

#### 7. **Telemetry Opt-Out**

**Current State:**
- No telemetry implemented
- No explicit opt-out mechanism

**Recommended:**
- Add telemetry settings with opt-out by default
- Clearly disclose data collection

**Implementation:**

```javascript
// In settings
const telemetryEnabled = settings.get('telemetryEnabled', false); // Default: OFF

// In settings UI
<div class="setting-item">
  <label>
    <input type="checkbox" id="telemetry-checkbox" />
    Enable anonymous usage analytics
  </label>
  <small>Helps improve the app. No personal data collected.</small>
</div>
```

#### 8. **Network Security**

**Current State:**
- No certificate pinning
- Relies on system trust store

**Recommended:**
- Pin certificates for critical endpoints (optional)
- Validate TLS connections

**Implementation:**

```javascript
// In main.js
app.on('certificate-error', (event, webContents, url, error, certificate, callback) => {
  // Only for critical endpoints
  if (url.startsWith('https://api.openai.com')) {
    // Verify certificate fingerprint
    const expectedFingerprint = 'SHA256:...';
    if (certificate.fingerprint === expectedFingerprint) {
      event.preventDefault();
      callback(true);
      return;
    }
  }
  callback(false);
});
```

---

## Secrets Management Best Practices

### 1. Environment Variables

**DO:**
- Use `.env` file for development (add to `.gitignore`)
- Load with `dotenv` package
- Validate presence of required secrets on startup

**DON'T:**
- Commit `.env` to version control
- Hardcode secrets in source code
- Log secrets to console

### 2. API Key Storage

**For Development:**
```bash
# .env file
API_KEY=sk-...
OPENAI_API_KEY=sk-...
ANTHROPIC_API_KEY=sk-ant-...
```

**For Production:**
```javascript
// Use OS keychain
const keytar = require('keytar');

async function getApiKey() {
  return await keytar.getPassword('perplexity-app', 'api-key');
}

async function setApiKey(key) {
  await keytar.setPassword('perplexity-app', 'api-key', key);
}
```

### 3. Session Data

**Current State:**
- Stored in `%APPDATA%/perplexity-ai-app/` (unencrypted)

**Recommended:**
```javascript
// Encrypt session data
const { safeStorage } = require('electron');

function saveSessionData(data) {
  const encrypted = safeStorage.encryptString(JSON.stringify(data));
  fs.writeFileSync(sessionPath, encrypted);
}

function loadSessionData() {
  const encrypted = fs.readFileSync(sessionPath);
  const decrypted = safeStorage.decryptString(encrypted);
  return JSON.parse(decrypted);
}
```

---

## Least-Privilege Permissions

### Windows

**Current:**
- `requestedExecutionLevel: asInvoker` (runs as current user)

**Recommendation:**
- ✅ Already follows least-privilege
- No admin rights required

### macOS

**Current:**
- No sandboxing
- Full disk access not required

**Recommendation:**
- Consider enabling App Sandbox (optional)
- Request only necessary entitlements:

```xml
<!-- entitlements.mac.plist -->
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "...">
<plist version="1.0">
<dict>
  <key>com.apple.security.app-sandbox</key>
  <true/>
  <key>com.apple.security.network.client</key>
  <true/>
  <key>com.apple.security.files.user-selected.read-write</key>
  <true/>
</dict>
</plist>
```

### Linux

**Current:**
- No restrictions

**Recommendation:**
- Run with standard user permissions
- Use AppArmor or SELinux profiles (advanced)

---

## Safe Defaults

### Application Settings

**Defaults:**
```javascript
{
  autoStartEnabled: false,          // Don't start on boot by default
  disableHardwareAcceleration: false,
  telemetryEnabled: false,          // Opt-out by default
  cacheEnabled: true,               // Safe: only caches API responses
  validateResponses: true,          // Validate API responses
  maxPromptLength: 100000           // Limit input size
}
```

### Network Defaults

```javascript
{
  timeout: 30000,                   // 30s timeout
  retries: 3,                       // Max 3 retries
  followRedirects: false,           // Don't follow redirects
  validateCertificates: true        // Verify TLS certificates
}
```

---

## Privacy Considerations

### Data Collection

**Current:**
- ❌ No telemetry
- ❌ No analytics
- ❌ No crash reporting

**If Implementing Telemetry:**
1. Obtain explicit user consent (opt-in)
2. Anonymize all data
3. Store minimal data (no PII)
4. Provide clear privacy policy
5. Allow opt-out at any time

### Third-Party Services

**Current Connections:**
- `perplexity.ai` / `labs.perplexity.ai` (user login, search)
- `cdn.jsdelivr.net` (notifications, updates)
- `raw.githubusercontent.com` (update checks)
- `localhost:8000/v1` (AI providers)

**Data Shared:**
- User prompts/queries → AI providers
- Version number → GitHub (update checks)
- No tracking cookies or analytics

---

## Compliance

### GDPR (EU)

**Applicable if:**
- App used by EU residents

**Requirements:**
- ✅ No personal data collected by app
- ✅ User controls their data (local storage only)
- ⚠️ Third-party services (Perplexity, OpenAI, etc.) have separate policies

### COPPA (US)

**Applicable if:**
- App targets children under 13

**Requirements:**
- Obtain parental consent
- Limit data collection
- Provide privacy notice

**Current Status:** App not designed for children under 13.

---

## Incident Response

### In Case of Security Breach

1. **Immediate Actions:**
   - Revoke compromised API keys
   - Reset user sessions
   - Notify affected users within 72 hours (GDPR requirement)

2. **Investigation:**
   - Identify vulnerability
   - Assess impact (data accessed, systems affected)
   - Document timeline

3. **Remediation:**
   - Patch vulnerability
   - Release hotfix update
   - Update security documentation

4. **Communication:**
   - Publish security advisory
   - Notify users via update notification
   - Coordinate with platform vendors (if applicable)

---

## Security Checklist

### For Developers

- [ ] Never commit secrets to git
- [ ] Use environment variables or keychain
- [ ] Validate all user inputs
- [ ] Sanitize IPC messages
- [ ] Enable context isolation
- [ ] Disable node integration in renderers
- [ ] Use HTTPS for all network requests
- [ ] Implement CSP headers
- [ ] Code-sign releases
- [ ] Run `npm audit` before release
- [ ] Test on all platforms
- [ ] Document security assumptions

### For Users

- [ ] Download only from official sources (GitHub releases)
- [ ] Verify checksums/signatures (if provided)
- [ ] Keep app updated
- [ ] Use strong API keys
- [ ] Don't share `.env` files
- [ ] Review permissions before granting
- [ ] Monitor network activity (optional)
- [ ] Report suspicious behavior

---

## Security Updates

Security patches are released as needed. Subscribe to GitHub releases for notifications:

```
https://github.com/MosesRahnama/perplexity-ai-app/releases
```

---

## Additional Resources

- [Electron Security Best Practices](https://www.electronjs.org/docs/latest/tutorial/security)
- [OWASP Desktop App Security](https://owasp.org/www-project-desktop-app-security/)
- [NIST Cybersecurity Framework](https://www.nist.gov/cyberframework)

---

**Document Version:** 1.0  
**Last Updated:** 2025-01-XX  
**Next Review:** 2025-04-XX (Quarterly)
