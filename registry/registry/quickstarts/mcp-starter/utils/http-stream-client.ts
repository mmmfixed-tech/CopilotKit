import { MCPTool, MCPClient as MCPClientInterface } from "@copilotkit/runtime";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { JSONRPCMessage } from "@modelcontextprotocol/sdk/types.js";

/**
 * Configuration options for the HttpStreamClient
 */
export interface HttpStreamClientOptions {
  serverUrl: string;
  headers?: Record<string, string>;
  onMessage?: (message: Record<string, unknown>) => void;
  onError?: (error: Error) => void;
  onOpen?: () => void;
  onClose?: () => void;
  sessionId?: string;
  maxRetries?: number;
  initialReconnectionDelay?: number;
  maxReconnectionDelay?: number;
  reconnectionDelayGrowFactor?: number;
}

/**
 * HttpStreamClient - Modern HTTP Stream MCP Client
 * 
 * This class implements the Model Context Protocol (MCP) client using the modern
 * StreamableHTTPClientTransport, which provides better performance and reliability
 * compared to the legacy SSE transport implementations.
 * 
 * The StreamableHTTP transport uses:
 * - HTTP POST for sending messages to the server
 * - HTTP GET with Server-Sent Events for receiving messages from the server
 * - Built-in reconnection with exponential backoff
 * - Session management and resumption capabilities
 * - OAuth authentication support
 * 
 * This replaces the deprecated SSE-only transport and provides compatibility
 * with modern MCP servers like Composio and others that support HTTP streaming.
 */
export class HttpStreamClient implements MCPClientInterface {
  private client: Client;
  private transport: StreamableHTTPClientTransport;
  private serverUrl: URL;
  private onMessage: (message: Record<string, unknown>) => void;
  private onError: (error: Error) => void;
  private onOpen: () => void;
  private onClose: () => void;
  private isConnected = false;
  private headers?: Record<string, string>;

  // Cache for tools to avoid repeated fetches
  private toolsCache: Record<string, MCPTool> | null = null;

  constructor(options: HttpStreamClientOptions) {
    this.serverUrl = new URL(options.serverUrl);
    this.headers = options.headers;
    this.onMessage = options.onMessage || ((message) => console.log("Message received:", message));
    this.onError = options.onError || ((error) => console.error("Error:", error));
    this.onOpen = options.onOpen || (() => console.log("Connection opened"));
    this.onClose = options.onClose || (() => console.log("Connection closed"));

    // Initialize the modern HTTP Stream transport
    this.transport = new StreamableHTTPClientTransport(this.serverUrl, {
      requestInit: this.headers ? { headers: this.headers } : undefined,
      sessionId: options.sessionId,
      reconnectionOptions: {
        maxRetries: options.maxRetries || 3,
        initialReconnectionDelay: options.initialReconnectionDelay || 1000,
        maxReconnectionDelay: options.maxReconnectionDelay || 30000,
        reconnectionDelayGrowFactor: options.reconnectionDelayGrowFactor || 1.5,
      },
    });

    // Initialize the client
    this.client = new Client({
      name: "cpk-http-stream-client",
      version: "1.0.0",
    });

    // Set up event handlers
    this.transport.onmessage = this.handleMessage.bind(this);
    this.transport.onerror = this.handleError.bind(this);
    this.transport.onclose = this.handleClose.bind(this);
  }

  private handleMessage(message: JSONRPCMessage): void {
    try {
      this.onMessage(message as Record<string, unknown>);
    } catch (error) {
      this.handleError(
        error instanceof Error
          ? error
          : new Error(`Failed to handle message: ${error}`)
      );
    }
  }

  private handleError(error: Error): void {
    console.error("HttpStreamClient error:", error);
    this.onError(error);
    
    // Mark as disconnected on error
    if (this.isConnected) {
      this.isConnected = false;
    }
  }

  private handleClose(): void {
    console.log("HttpStreamClient connection closed");
    this.isConnected = false;
    this.onClose();
  }

  /**
   * Connects to the MCP server using HTTP Stream transport
   */
  public async connect(): Promise<void> {
    try {
      console.log("Connecting to MCP server via HTTP Stream:", this.serverUrl.href);

      // Start the transport (HTTP Stream connection)
      await this.transport.start();

      // Connect the client
      await this.client.connect(this.transport);

      this.isConnected = true;
      console.log("Successfully connected to MCP server via HTTP Stream");
      this.onOpen();
    } catch (error) {
      console.error("Failed to connect to MCP server:", error);
      const connectionError = error instanceof Error 
        ? error 
        : new Error(`Connection failed: ${error}`);
      this.handleError(connectionError);
      throw connectionError;
    }
  }

  /**
   * Returns a map of tool names to MCPTool objects
   * This method matches the expected CopilotKit interface
   */
  public async tools(): Promise<Record<string, MCPTool>> {
    try {
      // Return from cache if available
      if (this.toolsCache) {
        return this.toolsCache;
      }

      if (!this.isConnected) {
        throw new Error("Client is not connected. Call connect() first.");
      }

      // Fetch raw tools data using the client
      const rawToolsResult = await this.client.listTools();

      // Transform to the expected format
      const toolsMap: Record<string, MCPTool> = {};

      if (rawToolsResult?.tools && Array.isArray(rawToolsResult.tools)) {
        rawToolsResult.tools.forEach((tool: any) => {
          if (tool && typeof tool === "object" && "name" in tool) {
            // Extract required parameters
            let requiredParams: string[] = [];
            if (
              tool.inputSchema &&
              typeof tool.inputSchema === "object" &&
              "required" in tool.inputSchema &&
              Array.isArray(tool.inputSchema.required)
            ) {
              requiredParams = tool.inputSchema.required;
            }

            // Enhanced description with parameter requirements
            let enhancedDescription = tool.description || `Tool: ${tool.name}`;
            if (requiredParams.length > 0) {
              enhancedDescription += `\nRequired parameters: ${requiredParams.join(", ")}`;
            }

            // Add example structure if derivable from schema
            const exampleInput = this.deriveExampleInput(tool.inputSchema, tool.name);
            if (exampleInput) {
              enhancedDescription += `\nExample usage: ${exampleInput}`;
            }

            toolsMap[tool.name] = {
              description: enhancedDescription,
              schema: tool.inputSchema || {},
              execute: async (args: Record<string, unknown>) => {
                return this.callTool(tool.name, args);
              },
            };
          }
        });
      }

      // Cache the results for subsequent calls
      this.toolsCache = toolsMap;
      console.log(`Loaded ${Object.keys(toolsMap).length} tools from MCP server`);

      return toolsMap;
    } catch (error) {
      console.error("Failed to fetch tools:", error);
      const toolsError = error instanceof Error 
        ? error 
        : new Error(`Failed to fetch tools: ${error}`);
      this.handleError(toolsError);
      throw toolsError;
    }
  }

  /**
   * Derives example input from a JSON schema for better tool descriptions
   */
  private deriveExampleInput(schema: any, toolName: string): string | null {
    if (!schema || typeof schema !== "object") {
      return null;
    }

    try {
      const properties = schema.properties || {};
      const required = schema.required || [];
      
      if (Object.keys(properties).length === 0) {
        return `${toolName}({})`;
      }

      const exampleArgs: Record<string, any> = {};
      
      // Generate example values for required parameters
      required.forEach((paramName: string) => {
        const paramSchema = properties[paramName];
        if (paramSchema) {
          exampleArgs[paramName] = this.generateExampleValue(paramSchema, paramName);
        }
      });

      // Add a few optional parameters if they exist
      const optionalParams = Object.keys(properties).filter(key => !required.includes(key));
      optionalParams.slice(0, 2).forEach(paramName => {
        const paramSchema = properties[paramName];
        if (paramSchema) {
          exampleArgs[paramName] = this.generateExampleValue(paramSchema, paramName);
        }
      });

      return `${toolName}(${JSON.stringify(exampleArgs, null, 2)})`;
    } catch (error) {
      console.warn("Failed to derive example input for tool:", toolName, error);
      return null;
    }
  }

  /**
   * Generates example values based on JSON schema types
   */
  private generateExampleValue(schema: any, paramName: string): any {
    if (!schema || typeof schema !== "object") {
      return `<${paramName}>`;
    }

    const type = schema.type;
    
    switch (type) {
      case "string":
        return schema.enum ? schema.enum[0] : `"example_${paramName}"`;
      case "number":
      case "integer":
        return schema.minimum !== undefined ? schema.minimum : 42;
      case "boolean":
        return true;
      case "array":
        const itemExample = schema.items 
          ? this.generateExampleValue(schema.items, "item")
          : "item";
        return [itemExample];
      case "object":
        if (schema.properties) {
          const objExample: Record<string, any> = {};
          Object.keys(schema.properties).slice(0, 2).forEach(key => {
            objExample[key] = this.generateExampleValue(schema.properties[key], key);
          });
          return objExample;
        }
        return {};
      default:
        return `<${paramName}>`;
    }
  }

  /**
   * Calls a tool on the MCP server
   */
  private async callTool(toolName: string, args: Record<string, unknown>): Promise<any> {
    try {
      if (!this.isConnected) {
        throw new Error("Client is not connected. Call connect() first.");
      }

      console.log(`Calling tool '${toolName}' with args:`, args);
      
      const result = await this.client.callTool({
        name: toolName,
        arguments: args,
      });

      console.log(`Tool '${toolName}' executed successfully:`, result);
      return result;
    } catch (error) {
      console.error(`Failed to call tool '${toolName}':`, error);
      const toolError = error instanceof Error 
        ? error 
        : new Error(`Tool execution failed: ${error}`);
      this.handleError(toolError);
      throw toolError;
    }
  }

  /**
   * Closes the connection to the MCP server
   */
  public async close(): Promise<void> {
    try {
      console.log("Closing HTTP Stream connection to MCP server");
      
      if (this.transport) {
        await this.transport.close();
      }
      
      this.isConnected = false;
      this.toolsCache = null; // Clear cache on close
      
      console.log("HTTP Stream connection closed successfully");
    } catch (error) {
      console.error("Error while closing connection:", error);
      const closeError = error instanceof Error 
        ? error 
        : new Error(`Failed to close connection: ${error}`);
      this.handleError(closeError);
      throw closeError;
    }
  }

  /**
   * Gets the current session ID (if available)
   */
  public get sessionId(): string | undefined {
    return this.transport?.sessionId;
  }

  /**
   * Checks if the client is currently connected
   */
  public get connected(): boolean {
    return this.isConnected;
  }

  /**
   * Manually clear the tools cache (useful for testing or force refresh)
   */
  public clearToolsCache(): void {
    this.toolsCache = null;
    console.log("Tools cache cleared");
  }
}
