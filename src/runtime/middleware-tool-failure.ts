import { ToolError } from "@livekit/agents";
import {
  middlewareFailureIsRetryable,
  type MiddlewareFailure,
} from "../clients/owned-middleware.js";

const NON_RETRYABLE_MIDDLEWARE_FAILURE =
  "Owned Middleware returned a non-retryable failure.";

export function throwOwnedMiddlewareFailure(
  failure: MiddlewareFailure,
  retryableMessage: string,
): never {
  if (middlewareFailureIsRetryable(failure)) {
    throw new ToolError(retryableMessage);
  }
  throw new Error(NON_RETRYABLE_MIDDLEWARE_FAILURE);
}
