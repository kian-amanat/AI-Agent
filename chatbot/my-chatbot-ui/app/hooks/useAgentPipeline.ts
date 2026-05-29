import { useState } from "react";

export type AgentStage =
  | "idle"
  | "intake"
  | "context"
  | "planning"
  | "executing"
  | "validating"
  | "complete";

export function useAgentPipeline() {
  const [stage, setStage] = useState<AgentStage>("idle");

  const [active, setActive] = useState(false);

  const start = () => {
    setActive(true);
    setStage("intake");
  };

  const stop = () => {
    setStage("complete");

    setTimeout(() => {
      setActive(false);
    }, 1200);
  };

  return {
    stage,
    setStage,
    active,
    start,
    stop,
  };
}