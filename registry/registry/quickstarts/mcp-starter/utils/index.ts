/**
 * MCP Client Utilities for CopilotKit
 * 
 * This module provides clients for connecting to Model Context Protocol (MCP) servers.
 */

// Modern HTTP Stream client (recommended)
export { HttpStreamClient, type HttpStreamClientOptions } from './http-stream-client.js';

// Legacy SSE client (deprecated)
export { MCPClient, type McpClientOptions } from './mcp-client.js';

// Re-export for convenience
import { HttpStreamClient } from './http-stream-client.js';

/**
 * Recommended client for new projects.
 * Uses modern HTTP Stream transport with better reliability and reconnection.
 */
export const RecommendedMCPClient = HttpStreamClient;

/**
 * Migration guide:
 * 
 * OLD (deprecated):
 * ```typescript
 * import { MCPClient } from './utils/mcp-client.js';
 * const client = new MCPClient({ serverUrl: '...' });
 * ```
 * 
 * NEW (recommended):
 * ```typescript
 * import { HttpStreamClient } from './utils/http-stream-client.js';
 * // OR
 * import { RecommendedMCPClient } from './utils/index.js';
 * 
 * const client = new HttpStreamClient({ serverUrl: '...' });
 * ```
 * 
 * Benefits of HttpStreamClient:
 * - Uses modern StreamableHTTPClientTransport from MCP SDK
 * - Built-in reconnection with exponential backoff
 * - Session management and resumption
 * - Better error handling and recovery
 * - Compatible with modern MCP servers (Composio, etc.)
 * - OAuth authentication support
 */