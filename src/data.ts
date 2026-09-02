import { overviewData as generatedData } from "./data.generated";
import { parseOverviewData } from "./schema";
import type { OverviewData } from "./types";

export const overviewData: OverviewData = parseOverviewData(generatedData);
