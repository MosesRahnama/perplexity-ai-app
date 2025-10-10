/**
 * MCP Client Manager
 * Manages connections to all MCP servers and provides unified tool access
 * Supports both SSE and command-based MCP servers
 */

const { spawn } = require('child_process');
const { EventEmitter } = require('events');
const path = require('path');
const fs = require('fs');
const { net } = require('electron');

class MCPClientManager extends EventEmitter {
  constructor(config = {}) {
    super();
    this.servers = new Map();
    this.tools = new Map();
    this.resources = new Map();
    this.prompts = new Map();
    this.config = config;
    this.isInitialized = false;
    
    // Server configurations from your setup
    this.serverConfigs = config.servers || {};
    
    console.log('🔧 MCP Client Manager initialized with', Object.keys(this.serverConfigs).length, 'servers');
  }

  /**
   * Initialize all MCP server connections
   */
  async initialize() {
    if (this.isInitialized) {
      console.log('⚠️ MCP Manager already initialized');
      return;
    }

    console.log('🚀 Initializing MCP servers...');
    
    for (const [serverId, serverConfig] of Object.entries(this.serverConfigs)) {
      try {
        await this.connectToServer(serverId, serverConfig);
      } catch (error) {
        console.error(`❌ Failed to connect to MCP server '${serverId}':`, error.message);
        // Continue with other servers even if one fails
      }
    }

    this.isInitialized = true;
    console.log('✅ MCP Manager initialization complete');
    this.emit('initialized');
  }

  /**
   * Connect to a single MCP server
   */
  async connectToServer(serverId, config) {
    console.log(`🔌 Connecting to MCP server: ${serverId}`);

    let server;
    
    if (config.type === 'sse') {
      server = await this.createSSEConnection(serverId, config);
    } else if (config.command) {
      server = await this.createCommandConnection(serverId, config);
    } else {
      throw new Error(`Invalid server configuration for ${serverId}`);
    }

    this.servers.set(serverId, server);
    
    // Initialize server capabilities
    await this.initializeServerCapabilities(serverId, server);
    
    console.log(`✅ Connected to MCP server: ${serverId}`);
  }

  /**
   * Create SSE (Server-Sent Events) connection
   */
  async createSSEConnection(serverId, config) {
    const server = {
      id: serverId,
      type: 'sse',
      url: config.url,
      timeout: config.timeout || 300,
      autoApprove: config.autoApprove || [],
      connected: false,
      capabilities: {}
    };

    // Test connection
    try {
      const response = await this.makeSSERequest(server, {
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: '2024-11-05',
          capabilities: {
            tools: {},
            resources: {},
            prompts: {}
          },
          clientInfo: {
            name: 'perplexity-ai-app',
            version: '4.0.1'
          }
        }
      });
      
      server.connected = true;
      server.capabilities = response.result?.capabilities || {};
      
    } catch (error) {
      throw new Error(`SSE connection failed: ${error.message}`);
    }

    return server;
  }

  /**
   * Create command-based MCP connection
   */
  async createCommandConnection(serverId, config) {
    const server = {
      id: serverId,
      type: 'command',
      command: config.command,
      args: config.args || [],
      env: config.env || {},
      timeout: config.timeout || 300,
      autoApprove: config.autoApprove || [],
      process: null,
      connected: false,
      capabilities: {},
      messageQueue: [],
      responseHandlers: new Map()
    };

    // Spawn the MCP server process
    try {
      const env = { ...process.env, ...server.env };
      
      server.process = spawn(server.command, server.args, {
        env,
        stdio: ['pipe', 'pipe', 'pipe'],
        shell: true
      });

      // Handle process events
      server.process.on('error', (error) => {
        console.error(`MCP server ${serverId} process error:`, error);
        this.emit('server-error', serverId, error);
      });

      server.process.on('exit', (code, signal) => {
        console.log(`MCP server ${serverId} exited with code ${code}, signal ${signal}`);
        server.connected = false;
        this.emit('server-disconnected', serverId);
      });

      // Set up JSON-RPC communication
      this.setupJSONRPCCommunication(server);
      
      // Initialize the server
      const initResponse = await this.sendCommand(server, {
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: '2024-11-05',
          capabilities: {
            tools: {},
            resources: {},
            prompts: {}
          },
          clientInfo: {
            name: 'perplexity-ai-app',
            version: '4.0.1'
          }
        }
      });

      server.connected = true;
      server.capabilities = initResponse.result?.capabilities || {};
      
    } catch (error) {
      throw new Error(`Command connection failed: ${error.message}`);
    }

    return server;
  }

  /**
   * Set up JSON-RPC communication for command-based servers
   */
  setupJSONRPCCommunication(server) {
    let buffer = '';

    server.process.stdout.on('data', (data) => {
      buffer += data.toString();
      
      // Process complete JSON-RPC messages
      let lines = buffer.split('\n');
      buffer = lines.pop(); // Keep incomplete line in buffer
      
      for (const line of lines) {
        if (line.trim()) {
          try {
            const message = JSON.parse(line);
            this.handleJSONRPCMessage(server, message);
          } catch (error) {
            console.error(`Invalid JSON-RPC message from ${server.id}:`, line);
          }
        }
      }
    });

    server.process.stderr.on('data', (data) => {
      console.error(`MCP server ${server.id} stderr:`, data.toString());
    });
  }

  /**
   * Handle JSON-RPC message responses
   */
  handleJSONRPCMessage(server, message) {
    if (message.id && server.responseHandlers.has(message.id)) {
      const handler = server.responseHandlers.get(message.id);
      server.responseHandlers.delete(message.id);
      
      if (message.error) {
        handler.reject(new Error(message.error.message || 'Unknown RPC error'));
      } else {
        handler.resolve(message);
      }
    } else {
      // Handle notifications or other messages
      this.emit('server-message', server.id, message);
    }
  }

  /**
   * Send command to command-based MCP server
   */
  async sendCommand(server, message) {
    return new Promise((resolve, reject) => {
      if (!server.process || !server.connected) {
        reject(new Error(`Server ${server.id} is not connected`));
        return;
      }

      const messageId = message.id || Date.now();
      message.id = messageId;

      // Store response handler
      server.responseHandlers.set(messageId, { resolve, reject });

      // Set timeout
      setTimeout(() => {
        if (server.responseHandlers.has(messageId)) {
          server.responseHandlers.delete(messageId);
          reject(new Error(`Command timeout after ${server.timeout}s`));
        }
      }, server.timeout * 1000);

      // Send message
      const messageStr = JSON.stringify(message) + '\n';
      server.process.stdin.write(messageStr);
    });
  }

  /**
   * Make SSE request
   */
  async makeSSERequest(server, message) {
    return new Promise((resolve, reject) => {
      const request = net.request({
        url: server.url,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Accept': 'application/json'
        }
      });

      const timeout = setTimeout(() => {
        request.abort();
        reject(new Error(`SSE request timeout after ${server.timeout}s`));
      }, server.timeout * 1000);

      let responseData = '';

      request.on('response', (response) => {
        clearTimeout(timeout);
        
        if (response.statusCode >= 400) {
          reject(new Error(`HTTP ${response.statusCode}: ${response.statusMessage}`));
          return;
        }

        response.on('data', (chunk) => {
          responseData += chunk.toString();
        });

        response.on('end', () => {
          try {
            const data = JSON.parse(responseData);
            resolve(data);
          } catch (error) {
            reject(new Error(`Invalid JSON response: ${error.message}`));
          }
        });
      });

      request.on('error', (error) => {
        clearTimeout(timeout);
        reject(error);
      });

      request.write(JSON.stringify(message));
      request.end();
    });
  }

  /**
   * Initialize server capabilities (tools, resources, prompts)
   */
  async initializeServerCapabilities(serverId, server) {
    try {
      // List tools
      const toolsResponse = await this.callServerMethod(server, 'tools/list', {});
      if (toolsResponse.result?.tools) {
        for (const tool of toolsResponse.result.tools) {
          const toolKey = `${serverId}/${tool.name}`;
          this.tools.set(toolKey, {
            serverId,
            ...tool
          });
        }
      }

      // List resources
      const resourcesResponse = await this.callServerMethod(server, 'resources/list', {});
      if (resourcesResponse.result?.resources) {
        for (const resource of resourcesResponse.result.resources) {
          const resourceKey = `${serverId}/${resource.uri}`;
          this.resources.set(resourceKey, {
            serverId,
            ...resource
          });
        }
      }

      // List prompts
      const promptsResponse = await this.callServerMethod(server, 'prompts/list', {});
      if (promptsResponse.result?.prompts) {
        for (const prompt of promptsResponse.result.prompts) {
          const promptKey = `${serverId}/${prompt.name}`;
          this.prompts.set(promptKey, {
            serverId,
            ...prompt
          });
        }
      }

      console.log(`📋 Server ${serverId} capabilities:`, {
        tools: toolsResponse.result?.tools?.length || 0,
        resources: resourcesResponse.result?.resources?.length || 0,
        prompts: promptsResponse.result?.prompts?.length || 0
      });
      
    } catch (error) {
      console.error(`Failed to initialize capabilities for ${serverId}:`, error.message);
    }
  }

  /**
   * Call a method on a specific server
   */
  async callServerMethod(server, method, params) {
    const message = {
      jsonrpc: '2.0',
      id: Date.now(),
      method,
      params
    };

    if (server.type === 'sse') {
      return await this.makeSSERequest(server, message);
    } else if (server.type === 'command') {
      return await this.sendCommand(server, message);
    } else {
      throw new Error(`Unknown server type: ${server.type}`);
    }
  }

  /**
   * Call a tool by name
   */
  async callTool(toolName, args = {}) {
    // Find tool (supports both "toolname" and "server/toolname" formats)
    let tool = this.tools.get(toolName);
    
    if (!tool) {
      // Try to find by tool name only (first match)
      for (const [key, value] of this.tools.entries()) {
        if (key.endsWith(`/${toolName}`)) {
          tool = value;
          break;
        }
      }
    }

    if (!tool) {
      throw new Error(`Tool '${toolName}' not found`);
    }

    const server = this.servers.get(tool.serverId);
    if (!server || !server.connected) {
      throw new Error(`Server '${tool.serverId}' is not connected`);
    }

    console.log(`🔧 Calling tool: ${toolName} on server: ${tool.serverId}`);
    
    const response = await this.callServerMethod(server, 'tools/call', {
      name: tool.name,
      arguments: args
    });

    return response.result;
  }

  /**
   * Get all available tools
   */
  getAvailableTools() {
    return Array.from(this.tools.entries()).map(([key, tool]) => ({
      id: key,
      name: tool.name,
      description: tool.description,
      server: tool.serverId,
      inputSchema: tool.inputSchema
    }));
  }

  /**
   * Get all available resources
   */
  getAvailableResources() {
    return Array.from(this.resources.entries()).map(([key, resource]) => ({
      id: key,
      uri: resource.uri,
      name: resource.name,
      description: resource.description,
      server: resource.serverId,
      mimeType: resource.mimeType
    }));
  }

  /**
   * Get server status
   */
  getServerStatus() {
    const status = {};
    for (const [serverId, server] of this.servers.entries()) {
      status[serverId] = {
        connected: server.connected,
        type: server.type,
        toolCount: Array.from(this.tools.keys()).filter(k => k.startsWith(serverId)).length,
        resourceCount: Array.from(this.resources.keys()).filter(k => k.startsWith(serverId)).length
      };
    }
    return status;
  }

  /**
   * Shutdown all connections
   */
  async shutdown() {
    console.log('🔥 Shutting down MCP connections...');
    
    for (const [serverId, server] of this.servers.entries()) {
      try {
        if (server.type === 'command' && server.process) {
          server.process.kill('SIGTERM');
        }
        server.connected = false;
      } catch (error) {
        console.error(`Error shutting down server ${serverId}:`, error);
      }
    }

    this.servers.clear();
    this.tools.clear();
    this.resources.clear();
    this.prompts.clear();
    this.isInitialized = false;
    
    console.log('✅ MCP shutdown complete');
  }
}

module.exports = MCPClientManager;