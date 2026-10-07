/**
 * Error Handling Utilities
 *
 * Standardized error handling with:
 * - Custom error classes with status codes
 * - Consistent JSON error responses
 * - Express/Next.js middleware
 * - Utility functions for common patterns
 *
 * Notes:
 * - `override` modifiers, required by this repo's `noImplicitOverride`
 * - `wrapAsync` keeps the route handler's argument types, so Next.js route
 *   context (`{ params: Promise<...> }`) stays typed inside the handler
 *
 * @example
 * ```ts
 * import { NotFoundError, wrapAsync, assertFound } from './error-handler';
 *
 * // Throw custom error
 * throw new NotFoundError('User not found');
 *
 * // Assert existence
 * const user = assertFound(await getUser(id), 'User');
 *
 * // Wrap async handler
 * export const GET = wrapAsync(async (req) => { ... });
 * ```
 */

// =============================================================================
// Types
// =============================================================================

/**
 * Standard error codes returned by every API route
 */
export type ErrorCode =
  | 'BAD_REQUEST'
  | 'VALIDATION_ERROR'
  | 'UNAUTHORIZED'
  | 'FORBIDDEN'
  | 'NOT_FOUND'
  | 'CONFLICT'
  | 'RATE_LIMITED'
  | 'EXTERNAL_SERVICE_ERROR'
  | 'INTERNAL_ERROR'
  | 'SERVICE_UNAVAILABLE';

/**
 * Standard error response format
 */
export interface ErrorResponse {
  error: {
    code: ErrorCode;
    message: string;
    details?: Record<string, unknown>;
    requestId?: string;
  };
}

/**
 * Validation error detail
 */
export interface ValidationDetail {
  field: string;
  message: string;
  value?: unknown;
}

// =============================================================================
// Base Error Class
// =============================================================================

/**
 * Base application error class
 *
 * All custom errors should extend this class.
 * - `isOperational`: true for expected errors (4xx), false for bugs (5xx)
 * - `statusCode`: HTTP status code
 * - `code`: Machine-readable error code
 */
export class AppError extends Error {
  readonly statusCode: number;
  readonly code: ErrorCode;
  readonly isOperational: boolean;
  readonly details?: Record<string, unknown>;
  override readonly cause?: Error;

  constructor(
    message: string,
    statusCode: number,
    code: ErrorCode,
    options?: {
      isOperational?: boolean;
      details?: Record<string, unknown>;
      cause?: Error;
    }
  ) {
    super(message);
    this.name = this.constructor.name;
    this.statusCode = statusCode;
    this.code = code;
    this.isOperational = options?.isOperational ?? true;
    this.details = options?.details;
    this.cause = options?.cause;

    // Maintains proper stack trace
    Error.captureStackTrace(this, this.constructor);
  }

  /**
   * Convert error to JSON response format
   */
  toJSON(requestId?: string): ErrorResponse {
    return {
      error: {
        code: this.code,
        message: this.message,
        ...(this.details && { details: this.details }),
        ...(requestId && { requestId }),
      },
    };
  }

  /**
   * Convert to HTTP Response object
   */
  toResponse(requestId?: string): Response {
    return new Response(JSON.stringify(this.toJSON(requestId)), {
      status: this.statusCode,
      headers: { 'Content-Type': 'application/json' },
    });
  }
}

// =============================================================================
// Specific Error Classes
// =============================================================================

/**
 * 400 Bad Request - Malformed request syntax
 */
export class BadRequestError extends AppError {
  constructor(message: string = 'Bad request', details?: Record<string, unknown>) {
    super(message, 400, 'BAD_REQUEST', { details });
  }
}

/**
 * 400 Validation Error - Request data validation failed
 */
export class ValidationError extends AppError {
  readonly validationErrors: ValidationDetail[];

  constructor(message: string, errors: ValidationDetail[] = []) {
    super(message, 400, 'VALIDATION_ERROR', {
      details: { errors },
    });
    this.validationErrors = errors;
  }

  /**
   * Create from a map of field -> message
   */
  static fromFields(fields: Record<string, string>): ValidationError {
    const errors = Object.entries(fields).map(([field, message]) => ({
      field,
      message,
    }));
    return new ValidationError('Validation failed', errors);
  }
}

/**
 * 401 Unauthorized - Missing or invalid authentication
 */
export class UnauthorizedError extends AppError {
  constructor(message: string = 'Authentication required') {
    super(message, 401, 'UNAUTHORIZED');
  }
}

/**
 * 403 Forbidden - Authenticated but not authorized
 */
export class ForbiddenError extends AppError {
  constructor(message: string = 'Access denied') {
    super(message, 403, 'FORBIDDEN');
  }
}

/**
 * 404 Not Found - Resource does not exist
 */
export class NotFoundError extends AppError {
  constructor(message: string = 'Resource not found') {
    super(message, 404, 'NOT_FOUND');
  }
}

/**
 * 409 Conflict - Resource state conflict
 */
export class ConflictError extends AppError {
  constructor(message: string = 'Resource conflict') {
    super(message, 409, 'CONFLICT');
  }
}

/**
 * 429 Rate Limited - Too many requests
 */
export class RateLimitError extends AppError {
  readonly retryAfter?: number;

  constructor(message: string = 'Too many requests', retryAfter?: number) {
    super(message, 429, 'RATE_LIMITED', {
      details: retryAfter ? { retryAfter } : undefined,
    });
    this.retryAfter = retryAfter;
  }

  override toResponse(requestId?: string): Response {
    const response = super.toResponse(requestId);
    if (this.retryAfter) {
      const headers = new Headers(response.headers);
      headers.set('Retry-After', String(this.retryAfter));
      return new Response(response.body, {
        status: response.status,
        headers,
      });
    }
    return response;
  }
}

/**
 * 502/503 External Service Error - Third-party service failed
 */
export class ExternalServiceError extends AppError {
  readonly service: string;

  constructor(
    service: string,
    message?: string,
    options?: { cause?: Error; statusCode?: number }
  ) {
    super(
      message || `${service} service error`,
      options?.statusCode || 502,
      'EXTERNAL_SERVICE_ERROR',
      {
        isOperational: true,
        details: { service },
        cause: options?.cause,
      }
    );
    this.service = service;
  }
}

/**
 * 503 Service Unavailable - Service temporarily unavailable
 */
export class ServiceUnavailableError extends AppError {
  constructor(message: string = 'Service temporarily unavailable') {
    super(message, 503, 'SERVICE_UNAVAILABLE');
  }
}

/**
 * 500 Internal Error - Unexpected server error (non-operational)
 */
export class InternalError extends AppError {
  constructor(message: string = 'Internal server error', cause?: Error) {
    super(message, 500, 'INTERNAL_ERROR', {
      isOperational: false,
      cause,
    });
  }
}

// =============================================================================
// Error Utilities
// =============================================================================

/**
 * Assert a value exists, throw NotFoundError if null/undefined
 *
 * @param value - Value to check
 * @param resourceName - Name for error message (e.g., "User", "Product")
 * @returns The value (non-null)
 *
 * @example
 * ```ts
 * const user = assertFound(await db.getUser(id), 'User');
 * // user is guaranteed to be non-null here
 * ```
 */
export function assertFound<T>(
  value: T | null | undefined,
  resourceName: string = 'Resource'
): T {
  if (value === null || value === undefined) {
    throw new NotFoundError(`${resourceName} not found`);
  }
  return value;
}

/**
 * Assert a condition is true, throw ValidationError if false
 *
 * @param condition - Condition to check
 * @param message - Error message if condition is false
 * @param field - Optional field name for validation detail
 *
 * @example
 * ```ts
 * assertValid(price > 0, 'Price must be positive', 'price');
 * assertValid(email.includes('@'), 'Invalid email format', 'email');
 * ```
 */
export function assertValid(
  condition: boolean,
  message: string,
  field?: string
): asserts condition {
  if (!condition) {
    const errors = field ? [{ field, message }] : [];
    throw new ValidationError(message, errors);
  }
}

/**
 * Assert multiple validation rules
 *
 * @param rules - Array of [condition, field, message] tuples
 *
 * @example
 * ```ts
 * assertValidAll([
 *   [name.length > 0, 'name', 'Name is required'],
 *   [price > 0, 'price', 'Price must be positive'],
 *   [quantity >= 1, 'quantity', 'Quantity must be at least 1'],
 * ]);
 * ```
 */
export function assertValidAll(
  rules: Array<[condition: boolean, field: string, message: string]>
): void {
  const errors: ValidationDetail[] = [];

  for (const [condition, field, message] of rules) {
    if (!condition) {
      errors.push({ field, message });
    }
  }

  if (errors.length > 0) {
    throw new ValidationError('Validation failed', errors);
  }
}

// =============================================================================
// Error Conversion
// =============================================================================

/**
 * Convert any error to an AppError
 *
 * - AppError: returned as-is
 * - Error with status/statusCode: converted with code mapping
 * - Unknown: wrapped in InternalError
 */
export function toAppError(error: unknown): AppError {
  // Already an AppError
  if (error instanceof AppError) {
    return error;
  }

  // Standard Error with status code (e.g., from fetch)
  if (error instanceof Error) {
    const err = error as Error & { status?: number; statusCode?: number; code?: string };
    const status = err.status || err.statusCode;

    if (status) {
      const code = mapStatusToCode(status);
      return new AppError(err.message, status, code, {
        isOperational: status < 500,
        cause: error,
      });
    }

    // Network/system errors
    if (isNetworkError(error)) {
      return new ExternalServiceError('Network', err.message, { cause: error });
    }

    // Unknown Error
    return new InternalError(err.message, error);
  }

  // Non-Error thrown
  return new InternalError(String(error));
}

/**
 * Map HTTP status code to error code
 */
function mapStatusToCode(status: number): ErrorCode {
  switch (status) {
    case 400:
      return 'BAD_REQUEST';
    case 401:
      return 'UNAUTHORIZED';
    case 403:
      return 'FORBIDDEN';
    case 404:
      return 'NOT_FOUND';
    case 409:
      return 'CONFLICT';
    case 429:
      return 'RATE_LIMITED';
    case 502:
    case 504:
      return 'EXTERNAL_SERVICE_ERROR';
    case 503:
      return 'SERVICE_UNAVAILABLE';
    default:
      return status >= 500 ? 'INTERNAL_ERROR' : 'BAD_REQUEST';
  }
}

/**
 * Check if error is a network error
 */
function isNetworkError(error: Error): boolean {
  const msg = error.message.toLowerCase();
  return (
    msg.includes('fetch failed') ||
    msg.includes('network') ||
    msg.includes('econnrefused') ||
    msg.includes('econnreset') ||
    msg.includes('timeout') ||
    msg.includes('socket')
  );
}

// =============================================================================
// Error Logging
// =============================================================================

/**
 * Sensitive field names to redact from logs
 */
const SENSITIVE_FIELDS = [
  'password',
  'token',
  'secret',
  'key',
  'authorization',
  'cookie',
  'credit',
  'card',
  'ssn',
  'social',
];

/**
 * Sanitize an object by redacting sensitive fields
 */
export function sanitizeForLogging(obj: unknown): unknown {
  if (obj === null || obj === undefined) {
    return obj;
  }

  if (typeof obj === 'string') {
    // Redact things that look like tokens/keys
    if (obj.length > 50 && /^[A-Za-z0-9_-]+$/.test(obj)) {
      return `[REDACTED:${obj.slice(0, 8)}...]`;
    }
    return obj;
  }

  if (Array.isArray(obj)) {
    return obj.map(sanitizeForLogging);
  }

  if (typeof obj === 'object') {
    const sanitized: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(obj)) {
      const lowerKey = key.toLowerCase();
      if (SENSITIVE_FIELDS.some((field) => lowerKey.includes(field))) {
        sanitized[key] = '[REDACTED]';
      } else {
        sanitized[key] = sanitizeForLogging(value);
      }
    }
    return sanitized;
  }

  return obj;
}

/**
 * Log an error with context
 */
export function logError(
  error: AppError,
  context?: Record<string, unknown>
): void {
  const isProduction = process.env.NODE_ENV === 'production';

  const logData: Record<string, unknown> = {
    name: error.name,
    code: error.code,
    message: error.message,
    statusCode: error.statusCode,
    isOperational: error.isOperational,
  };

  if (context) {
    logData.context = sanitizeForLogging(context);
  }

  if (error.details) {
    logData.details = sanitizeForLogging(error.details);
  }

  // Include stack trace in development
  if (!isProduction && error.stack) {
    logData.stack = error.stack;
  }

  // Include cause chain
  if (error.cause) {
    logData.cause = {
      name: error.cause.name,
      message: error.cause.message,
      ...(!isProduction && { stack: error.cause.stack }),
    };
  }

  // Log level based on error type
  if (error.isOperational) {
    console.warn('[Error]', JSON.stringify(logData));
  } else {
    console.error('[Error]', JSON.stringify(logData));
  }
}

// =============================================================================
// Route Handler Utilities
// =============================================================================

/**
 * Wrap an async route handler with error handling
 *
 * Catches any thrown errors and converts to proper HTTP responses.
 *
 * @example Next.js App Router
 * ```ts
 * export const GET = wrapAsync(async (request) => {
 *   const user = assertFound(await getUser(id), 'User');
 *   return NextResponse.json(user);
 * });
 * ```
 *
 * @example Express
 * ```ts
 * app.get('/users/:id', wrapAsync(async (req, res) => {
 *   const user = assertFound(await getUser(req.params.id), 'User');
 *   res.json(user);
 * }));
 * ```
 */
export function wrapAsync<TArgs extends unknown[], TRequest extends Request = Request>(
  handler: (request: TRequest, ...args: TArgs) => Promise<Response> | Response
): (request: TRequest, ...args: TArgs) => Promise<Response> {
  return async (request: TRequest, ...args: TArgs) => {
    try {
      return await handler(request, ...args);
    } catch (error) {
      const appError = toAppError(error);

      // Log the error
      logError(appError, {
        method: request.method,
        url: request.url,
      });

      return appError.toResponse();
    }
  };
}

// =============================================================================
// Express Middleware
// =============================================================================

/**
 * Express error handling middleware
 *
 * Add as the last middleware in your Express app:
 * ```ts
 * app.use(errorHandler);
 * ```
 */
export function expressErrorHandler(
  err: Error,
  req: { method: string; url: string; body?: unknown },
  res: {
    status: (code: number) => { json: (body: unknown) => void };
    headersSent: boolean;
  },
  next: (err?: Error) => void
): void {
  // If headers already sent, delegate to default handler
  if (res.headersSent) {
    return next(err);
  }

  const appError = toAppError(err);

  // Log the error
  logError(appError, {
    method: req.method,
    url: req.url,
  });

  // Send response
  res.status(appError.statusCode).json(appError.toJSON());
}

// =============================================================================
// Type Guards
// =============================================================================

/**
 * Check if an error is a specific AppError type
 */
export function isAppError(error: unknown): error is AppError {
  return error instanceof AppError;
}

/**
 * Check if an error is operational (expected, like 404)
 */
export function isOperationalError(error: unknown): boolean {
  return error instanceof AppError && error.isOperational;
}

/**
 * Check if an error indicates a specific HTTP status
 */
export function hasStatus(error: unknown, status: number): boolean {
  return error instanceof AppError && error.statusCode === status;
}
