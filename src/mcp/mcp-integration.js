/**
 * MCP Integration Layer
 * Integrates MCP Client Manager with the main Electron process
 * Provides IPC handlers for renderer process MCP access
 */

const { ipcMain } = require('electron');
const MCPClientManager = require('./mcp-client-manager');
const fs = require('fs');
const path = require('path');

class MCPIntegration {
  constructor(mainWindow) {
    this.mainWindow = mainWindow;
    this.mcpManager = null;
    this.isInitialized = false;
    this.toolRegistry = new Map();
    
    console.log('🤖 MCP Integration layer initialized');
  }

  /**
   * Initialize MCP integration
   */
  async initialize() {
    if (this.isInitialized) {
      console.log('⚠️ MCP Integration already initialized');
      return;
    }

    try {
      // Load MCP configuration
      const config = this.loadMCPConfig();
      
      // Initialize MCP Manager
      this.mcpManager = new MCPClientManager({
        servers: config.mcpServers,
        settings: config.settings
      });

      // Set up event handlers
      this.setupEventHandlers();
      
      // Set up IPC handlers
      this.setupIPCHandlers();
      
      // Initialize MCP connections
      await this.mcpManager.initialize();
      
      // Register tools
      this.registerTools();
      
      this.isInitialized = true;
      console.log('✅ MCP Integration initialization complete');
      
      // Notify renderer of successful initialization
      if (this.mainWindow && this.mainWindow.webContents) {
        this.mainWindow.webContents.send('mcp-initialized', {
          toolCount: this.mcpManager.tools.size,
          serverCount: this.mcpManager.servers.size
        });
      }
      
    } catch (error) {
      console.error('❌ MCP Integration initialization failed:', error);
      throw error;
    }
  }

  /**
   * Load MCP configuration from file
   */
  loadMCPConfig() {
    try {
      const configPath = path.join(__dirname, '../../mcp-config.json');
      const configData = fs.readFileSync(configPath, 'utf8');
      const config = JSON.parse(configData);
      
      console.log('📄 Loaded MCP config:', {
        servers: Object.keys(config.mcpServers).length,
        priorities: Object.keys(config.priorities).length
      });
      
      return config;
    } catch (error) {
      console.error('❌ Failed to load MCP config:', error.message);
      throw new Error('MCP configuration file not found or invalid');
    }
  }

  /**
   * Set up event handlers for MCP manager
   */
  setupEventHandlers() {
    this.mcpManager.on('initialized', () => {
      console.log('✨ MCP Manager fully initialized');
      this.updateToolRegistry();
    });

    this.mcpManager.on('server-error', (serverId, error) => {
      console.error(`❌ MCP Server ${serverId} error:`, error.message);
      this.notifyRenderer('mcp-server-error', { serverId, error: error.message });
    });

    this.mcpManager.on('server-disconnected', (serverId) => {
      console.log(`🔌 MCP Server ${serverId} disconnected`);
      this.notifyRenderer('mcp-server-disconnected', { serverId });
    });
  }

  /**
   * Set up IPC handlers for renderer communication
   */
  setupIPCHandlers() {
    // Get available tools
    ipcMain.handle('mcp-get-tools', () => {
      if (!this.mcpManager) return [];
      return this.mcpManager.getAvailableTools();
    });

    // Get available resources
    ipcMain.handle('mcp-get-resources', () => {
      if (!this.mcpManager) return [];
      return this.mcpManager.getAvailableResources();
    });

    // Call a tool
    ipcMain.handle('mcp-call-tool', async (event, toolName, args) => {
      if (!this.mcpManager) {
        throw new Error('MCP Manager not initialized');
      }
      
      try {
        console.log(`🔧 IPC tool call: ${toolName}`);
        const result = await this.mcpManager.callTool(toolName, args);
        
        // Log successful tool calls
        this.logToolCall(toolName, args, result, true);
        
        return result;
      } catch (error) {
        console.error(`❌ Tool call failed: ${toolName}`, error.message);
        this.logToolCall(toolName, args, null, false, error.message);
        throw error;
      }
    });

    // Get server status
    ipcMain.handle('mcp-get-server-status', () => {
      if (!this.mcpManager) return {};
      return this.mcpManager.getServerStatus();
    });

    // Get MCP statistics
    ipcMain.handle('mcp-get-stats', () => {
      if (!this.mcpManager) {
        return {
          initialized: false,
          serverCount: 0,
          toolCount: 0,
          resourceCount: 0
        };
      }
      
      return {
        initialized: this.isInitialized,
        serverCount: this.mcpManager.servers.size,
        toolCount: this.mcpManager.tools.size,
        resourceCount: this.mcpManager.resources.size,
        serverStatus: this.mcpManager.getServerStatus()
      };
    });

    // Refresh MCP connections
    ipcMain.handle('mcp-refresh', async () => {
      if (!this.mcpManager) return false;
      
      try {
        await this.mcpManager.shutdown();
        await this.initialize();
        return true;
      } catch (error) {
        console.error('❌ MCP refresh failed:', error);
        return false;
      }
    });

    // Get tool registry (for Perplexity agent integration)
    ipcMain.handle('mcp-get-tool-registry', () => {
      return Array.from(this.toolRegistry.entries()).map(([name, tool]) => ({
        name,
        ...tool
      }));
    });

    console.log('📡 MCP IPC handlers registered');
  }

  /**
   * Register tools for native agent access
   */
  registerTools() {
    if (!this.mcpManager) return;

    this.toolRegistry.clear();
    
    for (const [toolKey, tool] of this.mcpManager.tools.entries()) {
      // Create a simplified tool descriptor for agents
      const agentTool = {
        name: tool.name,
        description: tool.description,
        server: tool.serverId,
        schema: tool.inputSchema,
        execute: async (args) => {
          return await this.mcpManager.callTool(toolKey, args);
        }
      };
      
      this.toolRegistry.set(tool.name, agentTool);
    }
    
    console.log(`📋 Registered ${this.toolRegistry.size} tools for agent access`);
  }

  /**
   * Update tool registry when servers change
   */
  updateToolRegistry() {
    this.registerTools();
    this.notifyRenderer('mcp-tools-updated', {
      toolCount: this.toolRegistry.size
    });
  }

  /**
   * Log tool calls for debugging and analytics
   */
  logToolCall(toolName, args, result, success, error = null) {
    const logEntry = {
      timestamp: new Date().toISOString(),
      tool: toolName,
      args: JSON.stringify(args),
      success,
      error,
      resultSize: result ? JSON.stringify(result).length : 0
    };
    
    console.log('📊 Tool call log:', logEntry);
    
    // Could implement persistent logging here
  }

  /**
   * Notify renderer process of events
   */
  notifyRenderer(event, data) {
    if (this.mainWindow && this.mainWindow.webContents) {
      this.mainWindow.webContents.send(event, data);
    }
  }

  /**
   * Get tool for direct use (for native agent integration)
   */
  getTool(toolName) {
    return this.toolRegistry.get(toolName);
  }

  /**
   * Execute tool directly (for native agent integration)
   */
  async executeTool(toolName, args) {
    const tool = this.getTool(toolName);
    if (!tool) {
      throw new Error(`Tool '${toolName}' not found`);
    }
    
    return await tool.execute(args);
  }

  /**
   * Get all available tool names
   */
  getToolNames() {
    return Array.from(this.toolRegistry.keys());
  }

  /**
   * Check if a specific tool is available
   */
  hasToolCachin(toolName) {
    return this.toolRegistry.has(toolName);
  }

  /**
   * Get high-priority tools (desktop automation, etc.)
   */
  getHighPriorityTools() {
    const highPriorityServers = ['desktop-commander', 'filesystem', 'memory', 'playwright', 'windows-mcp', 'pieces'];
    
    return Array.from(this.toolRegistry.entries())
      .filter(([name, tool]) => highPriorityServers.includes(tool.server))
      .map(([name, tool]) => ({ name, ...tool }));
  }

  /**
   * Shutdown MCP integration
   */
  async shutdown() {
    console.log('🔥 Shutting down MCP Integration...');
    
    if (this.mcpManager) {
      await this.mcpManager.shutdown();
      this.mcpManager = null;
    }
    
    this.toolRegistry.clear();
    this.isInitialized = false;
    
    console.log('✅ MCP Integration shutdown complete');
  }
}

module.exports = MCPIntegration;