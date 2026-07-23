import { Bot, CheckCircle, Layers, Search, Sparkles } from "lucide-react";
import React from "react";
import type { FileDiff } from "../../lib/api";

export type Role = "user" | "assistant";

export interface UndoStats {
  filesTouched: number;
  filesReverted: number;
  errors: number;
}

export interface UndoResult {
  stats?: UndoStats;
  files?: Array<{
    path: string;
    status: "reverted" | "skipped" | "error";
    reason?: string;
  }>;
  error?: string;
}

export interface Message {
  id: string;
  role: Role;
  content: string;
  createdAt: string;
  metadata?: {
    type?: string;
    intent?: string;
    requestId?: string; // برای Undo
    plan_file?: string;
    plan_path?: string;
    plan_summary?: {
      name?: string;
      project_type?: string;
      goal?: string;
      tech_stack?: Record<string, string>;
      phases_count?: number;
      files_count?: number;
    };
    plan?: any;
    planMetadata?: any;
    stage?: "analyzing" | "planning" | "validating" | "complete";
    undoResult?: any;
    fileDiffs?: FileDiff[];
    attachments?: { name: string; type: string; size: number; thumbUrl?: string }[];
  };
}

export interface Conversation {
  id: string;
  title: string;
  preview: string;
  updatedAt: string;
  unread?: number;
}

export interface PipelineStage {
  key: string;
  label: string;
  description: string;
  icon: React.ComponentType<{ className?: string }>;
}

export const AGENT_STAGES: PipelineStage[] = [
  {
    key: "intake",
    label: "Intake",
    description: "Reading the request",
    icon: Search,
  },
  {
    key: "context",
    label: "Context",
    description: "Scanning files and structure",
    icon: Layers,
  },
  {
    key: "plan",
    label: "Plan",
    description: "Designing the task flow",
    icon: Sparkles,
  },
  {
    key: "validate",
    label: "Validate",
    description: "Checking quality and constraints",
    icon: CheckCircle,
  },
  {
    key: "complete",
    label: "Complete",
    description: "Ready for review",
    icon: Bot,
    },
];

export type CharCount = number;
