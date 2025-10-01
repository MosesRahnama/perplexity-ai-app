/**
 * Response Cache Layer
 * Implements disk-based caching with TTL for AI provider responses
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { app } = require('electron');

class ResponseCache {
  constructor(config = {}) {
    this.ttl = config.ttl || 3600000; // Default: 1 hour
    this.maxSize = config.maxSize || 100 * 1024 * 1024; // 100 MB
    this.cacheDir = config.cacheDir || path.join(app.getPath('userData'), 'ai-cache');
    this.enabled = config.enabled !== false;
    
    // Create cache directory if it doesn't exist
    if (this.enabled && !fs.existsSync(this.cacheDir)) {
      fs.mkdirSync(this.cacheDir, { recursive: true });
    }

    // In-memory index for faster lookups
    this.index = new Map();
    this.loadIndex();
  }

  /**
   * Generate cache key from request parameters
   * @param {Object} params - Request parameters
   * @returns {string} Cache key (hash)
   */
  _generateKey(params) {
    const normalized = {
      provider: params.provider,
      model: params.model,
      prompt: params.prompt,
      temperature: params.options?.temperature || 0.7,
      max_tokens: params.options?.max_tokens || 1000
    };
    
    const hash = crypto
      .createHash('sha256')
      .update(JSON.stringify(normalized))
      .digest('hex');
    
    return hash;
  }

  /**
   * Get cached response if available and not expired
   * @param {Object} params - Request parameters
   * @returns {Object|null} Cached response or null
   */
  get(params) {
    if (!this.enabled) return null;

    const key = this._generateKey(params);
    const indexEntry = this.index.get(key);

    if (!indexEntry) return null;

    // Check if expired
    const now = Date.now();
    if (now - indexEntry.timestamp > this.ttl) {
      this.delete(key);
      return null;
    }

    try {
      const filePath = path.join(this.cacheDir, `${key}.json`);
      const data = fs.readFileSync(filePath, 'utf8');
      const cached = JSON.parse(data);
      
      console.log(`Cache HIT: ${key.slice(0, 8)}... (age: ${Math.round((now - indexEntry.timestamp) / 1000)}s)`);
      
      return {
        ...cached,
        cached: true,
        cacheAge: now - indexEntry.timestamp
      };
    } catch (error) {
      console.error(`Cache read error: ${error.message}`);
      this.delete(key);
      return null;
    }
  }

  /**
   * Store response in cache
   * @param {Object} params - Request parameters
   * @param {Object} response - Response to cache
   */
  set(params, response) {
    if (!this.enabled) return;

    const key = this._generateKey(params);
    const filePath = path.join(this.cacheDir, `${key}.json`);
    const timestamp = Date.now();

    try {
      // Check total cache size and evict if necessary
      this._evictIfNeeded();

      // Write to disk
      fs.writeFileSync(filePath, JSON.stringify(response), 'utf8');

      // Update index
      const stats = fs.statSync(filePath);
      this.index.set(key, {
        timestamp,
        size: stats.size,
        provider: params.provider,
        model: params.model
      });

      this.saveIndex();
      
      console.log(`Cache SET: ${key.slice(0, 8)}... (size: ${stats.size} bytes)`);
    } catch (error) {
      console.error(`Cache write error: ${error.message}`);
    }
  }

  /**
   * Delete a specific cache entry
   * @param {string} key - Cache key
   */
  delete(key) {
    if (!this.enabled) return;

    try {
      const filePath = path.join(this.cacheDir, `${key}.json`);
      if (fs.existsSync(filePath)) {
        fs.unlinkSync(filePath);
      }
      this.index.delete(key);
      this.saveIndex();
    } catch (error) {
      console.error(`Cache delete error: ${error.message}`);
    }
  }

  /**
   * Clear all cached responses
   */
  clear() {
    if (!this.enabled) return;

    try {
      const files = fs.readdirSync(this.cacheDir);
      for (const file of files) {
        if (file.endsWith('.json') && file !== 'index.json') {
          fs.unlinkSync(path.join(this.cacheDir, file));
        }
      }
      this.index.clear();
      this.saveIndex();
      console.log('Cache cleared');
    } catch (error) {
      console.error(`Cache clear error: ${error.message}`);
    }
  }

  /**
   * Evict old entries if cache size exceeds limit
   * Uses LRU (Least Recently Used) strategy
   */
  _evictIfNeeded() {
    const totalSize = Array.from(this.index.values())
      .reduce((sum, entry) => sum + entry.size, 0);

    if (totalSize < this.maxSize) return;

    console.log(`Cache size (${totalSize} bytes) exceeds limit (${this.maxSize}). Evicting...`);

    // Sort by timestamp (oldest first)
    const entries = Array.from(this.index.entries())
      .sort((a, b) => a[1].timestamp - b[1].timestamp);

    let freedSpace = 0;
    for (const [key, entry] of entries) {
      this.delete(key);
      freedSpace += entry.size;
      
      if (totalSize - freedSpace < this.maxSize * 0.8) {
        break;
      }
    }

    console.log(`Evicted ${freedSpace} bytes`);
  }

  /**
   * Load cache index from disk
   */
  loadIndex() {
    if (!this.enabled) return;

    try {
      const indexPath = path.join(this.cacheDir, 'index.json');
      if (fs.existsSync(indexPath)) {
        const data = fs.readFileSync(indexPath, 'utf8');
        const indexData = JSON.parse(data);
        this.index = new Map(Object.entries(indexData));
        console.log(`Loaded cache index: ${this.index.size} entries`);
      }
    } catch (error) {
      console.error(`Failed to load cache index: ${error.message}`);
      this.index = new Map();
    }
  }

  /**
   * Save cache index to disk
   */
  saveIndex() {
    if (!this.enabled) return;

    try {
      const indexPath = path.join(this.cacheDir, 'index.json');
      const indexData = Object.fromEntries(this.index);
      fs.writeFileSync(indexPath, JSON.stringify(indexData, null, 2), 'utf8');
    } catch (error) {
      console.error(`Failed to save cache index: ${error.message}`);
    }
  }

  /**
   * Get cache statistics
   * @returns {Object} Stats
   */
  getStats() {
    if (!this.enabled) {
      return { enabled: false };
    }

    const entries = Array.from(this.index.values());
    const totalSize = entries.reduce((sum, entry) => sum + entry.size, 0);
    const now = Date.now();
    const validEntries = entries.filter(e => now - e.timestamp <= this.ttl);

    return {
      enabled: true,
      totalEntries: this.index.size,
      validEntries: validEntries.length,
      expiredEntries: this.index.size - validEntries.length,
      totalSize,
      maxSize: this.maxSize,
      utilizationPercent: Math.round((totalSize / this.maxSize) * 100),
      cacheDir: this.cacheDir
    };
  }
}

module.exports = ResponseCache;
