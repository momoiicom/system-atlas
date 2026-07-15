export interface AtlasEvent {
  traceId: string;
  spanId: string;
  parentId: string | null;
  module: string;
  fn: string;
  t0: number;
  t1: number;
  args: string | null;
  result: string | null;
  error: string | null;
}

export interface AtlasConfig {
  include: string[];
  exclude: string[];
  capture: "values" | "shapes";
  redact: RegExp[];
  dbPath: string;
  retentionHours: number;
}
