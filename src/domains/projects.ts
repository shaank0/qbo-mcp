/**
 * Projects domain.
 *
 * QuickBooks has no separate Project entity in the REST accounting API:
 * a project is a Customer with the read-only `IsProject` flag set. That flag is
 * minor-version gated, which is why the client pins minorversion 75.
 *
 * Read-only by construction — `IsProject` cannot be set through this API — so
 * this tool is safe regardless of the backend's write-surface configuration.
 * It also classifies as `read` in the gateway's RBAC (its name carries the
 * `list` verb), so it needs no allow-list entry.
 *
 * Richer project management (create/update, project-only fields) lives in
 * Intuit's separate GraphQL Projects API and is deliberately not implemented.
 */

import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import { getClient } from "../utils/client.js";

export const projectTools: Tool[] = [
  {
    name: "qbo_projects_list",
    description:
      "List QuickBooks projects (customers flagged IsProject), with their parent customer and active status. Use for reconciling project lists against other systems.",
    inputSchema: {
      type: "object",
      properties: {
        active_only: {
          type: "boolean",
          description: "Only return active projects (default false — returns all)",
        },
        startPosition: { type: "number", description: "1-based pagination offset" },
        maxResults: { type: "number", description: "Page size (default 100, max 1000)" },
      },
    },
  },
];

interface QboProject {
  Id?: string;
  DisplayName?: string;
  Active?: boolean;
  ParentRef?: { value?: string; name?: string };
}

export async function handleProjectTool(
  name: string,
  args: Record<string, unknown>
): Promise<{ content: { type: "text"; text: string }[]; isError?: boolean }> {
  if (name !== "qbo_projects_list") {
    return {
      content: [{ type: "text", text: `Unknown project tool: ${name}` }],
      isError: true,
    };
  }

  const startPosition = Number(args.startPosition ?? 1);
  const maxResults = Number(args.maxResults ?? 100);

  // IsProject is a read-only boolean literal in QBO SQL — not a quoted string.
  const conditions = ["IsProject = true"];
  if (args.active_only === true) conditions.push("Active = true");

  const sql =
    `SELECT * FROM Customer WHERE ${conditions.join(" AND ")} ` +
    `STARTPOSITION ${startPosition} MAXRESULTS ${maxResults}`;

  const result = (await getClient().query(sql)) as {
    QueryResponse?: { Customer?: QboProject[] };
  };

  const projects = (result?.QueryResponse?.Customer ?? []).map((c) => ({
    id: c.Id ?? "",
    name: c.DisplayName ?? "",
    active: c.Active ?? false,
    parentCustomerId: c.ParentRef?.value ?? null,
    parentCustomerName: c.ParentRef?.name ?? null,
  }));

  return {
    content: [
      { type: "text", text: JSON.stringify({ projects, count: projects.length }, null, 2) },
    ],
  };
}
