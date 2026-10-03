import {
  DtcScanQueueStatusSchema,
  type DtcScanQueue,
  type DtcScanQueueChangeSchema,
} from "@crawl-automation/app";
import type { Database } from "@crawl-automation/platform";
import type { z } from "zod";
import { oncePerRequest } from "./request-receipt.js";
import { DTC_SCAN_STATUS } from "./dtc-scan-queries.js";

export class PostgresDtcScanQueue implements DtcScanQueue {
  constructor(private readonly database: Database) {}

  async status() {
    return DtcScanQueueStatusSchema.parse((await this.database.query(DTC_SCAN_STATUS))[0]);
  }

  change(input: z.infer<typeof DtcScanQueueChangeSchema>) {
    return this.database.transaction((tx) =>
      oncePerRequest(
        tx,
        {
          requestId: input.requestId,
          operation: "brands.controlDtcScans",
          input: { mode: input.mode },
          parse: DtcScanQueueStatusSchema.parse,
        },
        async () => {
          await tx.query(
            "UPDATE dtc_scan_control SET mode=$1,updated_at=clock_timestamp() WHERE singleton",
            [input.mode],
          );
          return DtcScanQueueStatusSchema.parse((await tx.query(DTC_SCAN_STATUS))[0]);
        },
      ),
    );
  }
}
