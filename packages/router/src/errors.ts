// Typed errors for the deterministic routing core. The core never speaks
// HTTP; hosts map `kind` to their own transport semantics (Dari's hosted
// runtime maps invalid_request -> 400, selector_output -> 502, and
// configuration -> 500 while preserving `code`, `param`, and the message).
export type RouterCoreErrorKind =
  | "invalid_request"
  | "selector_output"
  | "configuration";

export class RouterCoreError extends Error {
  readonly kind: RouterCoreErrorKind;
  readonly code: string;
  readonly param?: string;

  constructor(
    kind: RouterCoreErrorKind,
    message: string,
    code: string,
    param?: string,
  ) {
    super(message);
    this.name = "RouterCoreError";
    this.kind = kind;
    this.code = code;
    if (param !== undefined) this.param = param;
  }
}
