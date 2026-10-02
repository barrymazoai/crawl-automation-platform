export interface AgentCaptureRequest {
  operationId: string;
  url: string;
  mode: "product" | "catalog" | "analysis";
  scope: object;
}
