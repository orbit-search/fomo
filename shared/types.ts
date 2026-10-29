/** Shared wire contracts. Provider keys and model instructions stay on the server. */
export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
export type Provider = 'firecrawl' | 'orbit' | 'monid' | 'openrouter';
export type SessionStatus = 'idle' | 'running' | 'approval' | 'stopping';
export interface Session {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  status: SessionStatus;
}
export interface ToolCall {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
}
export interface Message {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | null;
  tool_calls?: ToolCall[];
  tool_call_id?: string;
}
export interface Event {
  id: number;
  sessionId: string;
  turnId: string;
  kind:
    | 'user'
    | 'delta'
    | 'answer'
    | 'tool_start'
    | 'tool_end'
    | 'approval'
    | 'approval_resolved'
    | 'route'
    | 'usage'
    | 'error'
    | 'done';
  data: Record<string, unknown>;
  at: string;
}
export interface Artifact {
  id: string;
  sessionId: string;
  provider: Provider;
  kind: 'page' | 'people' | 'tool' | 'browser';
  title: string;
  data: Record<string, unknown>;
  createdAt: string;
}
export interface Approval {
  id: string;
  sessionId: string;
  turnId: string;
  tool: string;
  args: Record<string, unknown>;
  detail: Record<string, unknown>;
  status: 'pending' | 'approved' | 'denied';
  createdAt: string;
}
export interface Snapshot {
  session: Session;
  events: Event[];
  artifacts: Artifact[];
  approvals: Approval[];
}
export interface ToolDefinition {
  type: 'function';
  function: { name: string; description: string; parameters: Record<string, unknown> };
}
export interface ToolContext {
  sessionId: string;
  turnId: string;
  callId: string;
  signal: AbortSignal;
}
export interface Config {
  port: number;
  dataDir: string;
  operatorToken?: string;
  models: string[];
  keys: Record<Provider, string | undefined>;
  workspaceId?: string;
  origins: Record<Provider, string>;
}
export interface RouteUsage {
  prompt_tokens?: number;
  completion_tokens?: number;
  total_tokens?: number;
  cost?: number;
}
