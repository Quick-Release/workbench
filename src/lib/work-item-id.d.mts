// Types for work-item-id.mjs (GH-195): the implementation is plain ESM so
// the installed CLI's raw-Node sync can import it from node_modules.
export declare const workItemIdNamespace: (id: string) => string;
export declare const workItemIdNumber: (id: string) => number;
export declare const workItemIdNumberText: (id: string) => string;
export declare const workItemIdLabel: (id: string) => string;
export declare const compareWorkItemIds: (left: string, right: string) => number;
export declare const byIssueNumber: <T extends { id: string }>(left: T, right: T) => number;
