import type { IssuePanelAction } from "../components/IssueDetailPanel";
import {
  parseEdgeWriteResult,
  parseIssueCommentResult,
  parseIssueCreateResult,
  parseIssueEditResult,
} from "../schema";

// The shared panel's wire grammar (tickets #60/#61): each action names its
// seam route under /api/workflow, posts exactly its seam schema's fields —
// the action's `kind` never crosses the wire, where it would be excess — and
// each route host parses the answer through the same map, so the panel
// behaves identically on every view. The route suffix stays a string the
// route embeds in an /api/-relative fetch literal, keeping the seam
// invariant's source scan honest (ADR 0005).
export const issueActionRoute = (action: IssuePanelAction): string => {
  switch (action.kind) {
    case "comment":
      return "issue/comment";
    case "edit":
      return "issue/edit";
    case "create":
      return "issue/create";
    case "edge-add":
      return "edge/add";
    case "edge-remove":
      return "edge/remove";
  }
};

export const issueActionBody = (action: IssuePanelAction): Record<string, unknown> => {
  switch (action.kind) {
    case "comment":
      return { issueId: action.issueId, body: action.body };
    case "edit":
      return {
        issueId: action.issueId,
        title: action.title,
        body: action.body,
        confirm: action.confirm,
      };
    case "create":
      return { title: action.title, body: action.body };
    case "edge-add":
      return { blockedId: action.blockedId, blockerId: action.blockerId };
    case "edge-remove":
      return {
        blockedId: action.blockedId,
        blockerId: action.blockerId,
        confirm: action.confirm,
      };
  }
};

export const parseIssueActionResult = (kind: IssuePanelAction["kind"], raw: unknown) => {
  switch (kind) {
    case "comment":
      return parseIssueCommentResult(raw);
    case "edit":
      return parseIssueEditResult(raw);
    case "create":
      return parseIssueCreateResult(raw);
    case "edge-add":
    case "edge-remove":
      return parseEdgeWriteResult(raw);
  }
};
