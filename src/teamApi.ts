/** Native calls that carry team usage alongside the existing team commands. */
import { invoke } from "@tauri-apps/api/core";
import type { TaskUsage, TeamBinding, TeamSnapshot } from "./agentTeam";
import type { TeamUsageReport } from "./teamUsage";

/** Finishes a delegation with its measured consumption; long reports are kept in full natively. */
export const agentTeamFinishTask = (binding: TeamBinding, taskId: string, status: string, report: string | null, usage: TaskUsage | null): Promise<TeamSnapshot> =>
  invoke("agent_team_finish", { ...binding, taskId, status, report, usage });

/** Heartbeat that also publishes usage, budget and account quotas for the coordinator tools. */
export const agentTeamPublishUsage = (binding: TeamBinding, usage: TeamUsageReport): Promise<TeamSnapshot> =>
  invoke("agent_team_poll", { ...binding, usage });
