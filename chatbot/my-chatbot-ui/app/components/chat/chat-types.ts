import { Bot, CheckCircle, Layers, Search, Sparkles } from "lucide-react";
import React from "react";

export type Role = "user" | "assistant";

export interface Message {
  id: string;
  role: Role;
  content: string;
  createdAt: string;
  metadata?: {
    type?: string;
    intent?: string;
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
    stage?: "analyzing" | "planning" | "validating" | "complete";
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