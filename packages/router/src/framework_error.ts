export type RouterFrameworkErrorKind =
  | "invalid_request"
  | "not_found"
  | "configuration"
  | "cancelled"
  | "policy"
  | "executor";

const STATUS_BY_KIND: Record<RouterFrameworkErrorKind, number> = {
  invalid_request: 400,
  not_found: 404,
  configuration: 500,
  cancelled: 499,
  policy: 502,
  executor: 502,
};

export class RouterFrameworkError extends Error {
  readonly kind: RouterFrameworkErrorKind;
  readonly code: string;
  readonly param?: string;
  readonly status: number;

  constructor(
    kind: RouterFrameworkErrorKind,
    message: string,
    code: string,
    param?: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "RouterFrameworkError";
    this.kind = kind;
    this.code = code;
    this.status = STATUS_BY_KIND[kind];
    if (param !== undefined) this.param = param;
  }
}
