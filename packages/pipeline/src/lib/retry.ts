/**
 * Retry Logic Utilities
 *
 * Standardized retry logic with:
 * - Exponential backoff with jitter
 * - Configurable retry conditions
 * - Built-in checks for rate limits and network errors
 * - Detailed logging
 *
 * Notes:
 * - `delayHint` option: honor a server-provided delay (Gemini's RetryInfo
 *   retryDelay) instead of the computed backoff
 * - `sleep` is exported (the webhook deliverer and CLI use it)
 * - `errorStatus` helper for the SDK error shapes the pipeline sees
 *
 * @example
 * ```ts
 * import { withRetry, isRetryableError } from './retry';
 *
 * const result = await withRetry(
 *   () => fetch('https://api.deepgram.com/v1/listen'),
 *   { maxRetries: 3, retryOn: isRetryableError }
 * );
 * ```
 */

// =============================================================================
// Types
// =============================================================================

/**
 * Options for retry behavior
 */
export interface RetryOptions {
  /**
   * Maximum number of retry attempts (default: 3)
   * Total attempts = maxRetries + 1
   */
  maxRetries?: number;

  /**
   * Initial delay in milliseconds before first retry (default: 1000)
   */
  initialDelay?: number;

  /**
   * Maximum delay in milliseconds (default: 10000)
   * Delays are capped at this value
   */
  maxDelay?: number;

  /**
   * Multiplier for exponential backoff (default: 2)
   * delay = initialDelay * (backoffMultiplier ^ attemptNumber)
   */
  backoffMultiplier?: number;

  /**
   * Jitter factor (0-1) to randomize delays (default: 0.1)
   * Helps avoid thundering herd when multiple clients retry
   */
  jitter?: number;

  /**
   * Function to determine if an error should trigger a retry
   * Default: isRetryableError
   */
  retryOn?: (error: Error) => boolean;

  /**
   * Callback fired before each retry attempt
   */
  onRetry?: (error: Error, attempt: number, delay: number) => void;

  /**
   * Server-provided delay in ms (e.g. Retry-After); null uses the computed backoff
   */
  delayHint?: (error: Error) => number | null;

  /**
   * Operation name for logging (default: 'operation')
   */
  operationName?: string;
}

/**
 * Result of a retry operation with metadata
 */
export interface RetryResult<T> {
  /** The successful result */
  result: T;
  /** Number of attempts made (1 = success on first try) */
  attempts: number;
  /** Total time spent including delays (ms) */
  totalTime: number;
}

// =============================================================================
// Default Configuration
// =============================================================================

const DEFAULT_OPTIONS: Required<Omit<RetryOptions, 'onRetry' | 'delayHint'>> = {
  maxRetries: 3,
  initialDelay: 1000,
  maxDelay: 10000,
  backoffMultiplier: 2,
  jitter: 0.1,
  retryOn: isRetryableError,
  operationName: 'operation',
};

// =============================================================================
// Core Retry Function
// =============================================================================

/**
 * Execute a function with automatic retry on failure
 *
 * Uses exponential backoff with jitter for delay calculation.
 *
 * @param fn - Async function to execute
 * @param options - Retry configuration
 * @returns Result of the function
 * @throws The last error if all retries fail
 *
 * @example Basic usage
 * ```ts
 * const data = await withRetry(() => fetchFromApi());
 * ```
 *
 * @example Custom options
 * ```ts
 * const data = await withRetry(
 *   () => gemini.generateContent(request),
 *   {
 *     maxRetries: 5,
 *     initialDelay: 500,
 *     retryOn: isRateLimitError,
 *     operationName: 'Gemini extract',
 *   }
 * );
 * ```
 */
export async function withRetry<T>(
  fn: () => Promise<T>,
  options: RetryOptions = {}
): Promise<T> {
  const opts = { ...DEFAULT_OPTIONS, ...options };

  let lastError: Error | null = null;

  for (let attempt = 0; attempt <= opts.maxRetries; attempt++) {
    try {
      const result = await fn();

      // Log success after retries
      if (attempt > 0) {
        console.log(
          `[Retry] ${opts.operationName} succeeded after ${attempt + 1} attempts`
        );
      }

      return result;
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));

      // Check if we should retry
      const shouldRetry = attempt < opts.maxRetries && opts.retryOn(lastError);

      if (!shouldRetry) {
        // Final failure - log and throw
        if (attempt > 0) {
          console.error(
            `[Retry] ${opts.operationName} failed after ${attempt + 1} attempts:`,
            lastError.message
          );
        }
        throw lastError;
      }

      // Calculate delay with exponential backoff
      const baseDelay = opts.initialDelay * Math.pow(opts.backoffMultiplier, attempt);
      const cappedDelay = Math.min(baseDelay, opts.maxDelay);

      // Add jitter to avoid thundering herd
      const jitterAmount = cappedDelay * opts.jitter * (Math.random() * 2 - 1);
      const delay = opts.delayHint?.(lastError) ?? Math.round(cappedDelay + jitterAmount);

      // Log retry attempt
      console.warn(
        `[Retry] ${opts.operationName} attempt ${attempt + 1}/${opts.maxRetries + 1} failed: ${lastError.message}. Retrying in ${delay}ms...`
      );

      // Call onRetry callback if provided
      opts.onRetry?.(lastError, attempt + 1, delay);

      // Wait before retrying
      await sleep(delay);
    }
  }

  // Should never reach here, but TypeScript needs this
  throw lastError || new Error('Retry failed');
}

/**
 * Execute with retry and return detailed result
 *
 * Same as withRetry but returns metadata about the retry process.
 *
 * @example
 * ```ts
 * const { result, attempts, totalTime } = await withRetryResult(() => fetch(...));
 * console.log(`Succeeded after ${attempts} attempts in ${totalTime}ms`);
 * ```
 */
export async function withRetryResult<T>(
  fn: () => Promise<T>,
  options: RetryOptions = {}
): Promise<RetryResult<T>> {
  const startTime = Date.now();
  let attempts = 0;

  const result = await withRetry(fn, {
    ...options,
    onRetry: (error, attempt, delay) => {
      attempts = attempt;
      options.onRetry?.(error, attempt, delay);
    },
  });

  return {
    result,
    attempts: attempts + 1, // Convert to 1-indexed
    totalTime: Date.now() - startTime,
  };
}

// =============================================================================
// Retry Condition Functions
// =============================================================================

/**
 * HTTP status codes that are typically retryable
 */
const RETRYABLE_STATUS_CODES = [
  408, // Request Timeout
  429, // Too Many Requests
  500, // Internal Server Error
  502, // Bad Gateway
  503, // Service Unavailable
  504, // Gateway Timeout
];

/**
 * Check if an error is retryable (network errors, timeouts, server errors)
 *
 * Returns true for:
 * - Network errors (fetch failed, connection refused, etc.)
 * - Timeout errors
 * - HTTP 429, 500, 502, 503, 504
 * - GraphQL THROTTLED errors
 */
export function isRetryableError(error: Error): boolean {
  return isNetworkError(error) || isServerError(error) || isRateLimitError(error);
}

/**
 * Check if an error is a network-level error
 *
 * Returns true for:
 * - fetch failed
 * - Connection refused/reset
 * - Timeout
 * - Socket errors
 */
export function isNetworkError(error: Error): boolean {
  const message = error.message.toLowerCase();

  return (
    message.includes('fetch failed') ||
    message.includes('network') ||
    message.includes('econnrefused') ||
    message.includes('econnreset') ||
    message.includes('etimedout') ||
    message.includes('timeout') ||
    message.includes('socket') ||
    message.includes('dns') ||
    message.includes('getaddrinfo')
  );
}

/**
 * Check if an error is a server error (5xx)
 *
 * Checks for HTTP 500, 502, 503, 504 in:
 * - Error message
 * - Error status/statusCode property
 */
export function isServerError(error: Error): boolean {
  // Check message for status codes
  const message = error.message;
  if (/\b(500|502|503|504)\b/.test(message)) {
    return true;
  }

  // Check status property
  const err = error as Error & { status?: number; statusCode?: number; response?: { status?: number } };
  const status = err.status || err.statusCode || err.response?.status;

  return status !== undefined && status >= 500 && status < 600;
}

/**
 * Check if an error is specifically a rate limit error (429)
 *
 * Returns true for:
 * - HTTP 429 status
 * - "rate limit" in message
 * - GraphQL THROTTLED code
 */
export function isRateLimitError(error: Error): boolean {
  const message = error.message.toLowerCase();

  // Check for rate limit messages
  if (
    message.includes('rate limit') ||
    message.includes('too many requests') ||
    message.includes('throttled') ||
    message.includes('quota exceeded')
  ) {
    return true;
  }

  // Check for 429 status
  const err = error as Error & { status?: number; statusCode?: number; code?: string; response?: { status?: number } };
  const status = err.status || err.statusCode || err.response?.status;

  if (status === 429) {
    return true;
  }

  // Check for GraphQL THROTTLED code
  if (err.code === 'THROTTLED') {
    return true;
  }

  return false;
}

/**
 * Check if an error is a timeout error
 */
export function isTimeoutError(error: Error): boolean {
  const message = error.message.toLowerCase();
  return (
    message.includes('timeout') ||
    message.includes('etimedout') ||
    message.includes('timed out')
  );
}

/**
 * Create a custom retry condition that combines multiple checks
 *
 * @example
 * ```ts
 * const shouldRetry = combineRetryConditions(
 *   isRateLimitError,
 *   isNetworkError,
 *   (error) => error.message.includes('temporary')
 * );
 *
 * await withRetry(fn, { retryOn: shouldRetry });
 * ```
 */
export function combineRetryConditions(
  ...conditions: Array<(error: Error) => boolean>
): (error: Error) => boolean {
  return (error: Error) => conditions.some((condition) => condition(error));
}

/**
 * Never retry - useful for disabling retries
 */
export function neverRetry(): boolean {
  return false;
}

/**
 * Always retry - useful for testing
 */
export function alwaysRetry(): boolean {
  return true;
}

// =============================================================================
// Utility Functions
// =============================================================================

/**
 * Sleep for a given number of milliseconds
 */
export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Calculate delay for a specific attempt
 *
 * @example
 * ```ts
 * const delay = calculateDelay(2, { initialDelay: 1000, backoffMultiplier: 2 });
 * // Returns ~4000ms (1000 * 2^2)
 * ```
 */
export function calculateDelay(
  attempt: number,
  options: Pick<RetryOptions, 'initialDelay' | 'maxDelay' | 'backoffMultiplier' | 'jitter'> = {}
): number {
  const {
    initialDelay = DEFAULT_OPTIONS.initialDelay,
    maxDelay = DEFAULT_OPTIONS.maxDelay,
    backoffMultiplier = DEFAULT_OPTIONS.backoffMultiplier,
    jitter = DEFAULT_OPTIONS.jitter,
  } = options;

  const baseDelay = initialDelay * Math.pow(backoffMultiplier, attempt);
  const cappedDelay = Math.min(baseDelay, maxDelay);
  const jitterAmount = cappedDelay * jitter * (Math.random() * 2 - 1);

  return Math.round(cappedDelay + jitterAmount);
}

// =============================================================================
// Specialized Retry Functions
// =============================================================================

/**
 * Retry with rate limit awareness
 *
 * If a rate limit error includes retry-after, uses that delay.
 *
 * @example
 * ```ts
 * const data = await withRateLimitRetry(
 *   () => deepgramFetch(audio),
 *   { maxRetries: 5, operationName: 'Deepgram transcribe' }
 * );
 * ```
 */
export async function withRateLimitRetry<T>(
  fn: () => Promise<T>,
  options: Omit<RetryOptions, 'retryOn'> = {}
): Promise<T> {
  return withRetry(fn, {
    ...options,
    maxRetries: options.maxRetries ?? 5,
    initialDelay: options.initialDelay ?? 1000,
    retryOn: isRateLimitError,
  });
}

/**
 * Retry with network awareness
 *
 * Only retries on network-level errors, not HTTP errors.
 *
 * @example
 * ```ts
 * const data = await withNetworkRetry(
 *   () => fetch('https://api.example.com/data'),
 *   { maxRetries: 3 }
 * );
 * ```
 */
export async function withNetworkRetry<T>(
  fn: () => Promise<T>,
  options: Omit<RetryOptions, 'retryOn'> = {}
): Promise<T> {
  return withRetry(fn, {
    ...options,
    retryOn: isNetworkError,
  });
}

// =============================================================================
// Fetch with Retry
// =============================================================================

/**
 * Fetch with automatic retry
 *
 * Wraps fetch with retry logic for transient failures.
 *
 * @example
 * ```ts
 * const response = await fetchWithRetry('https://api.example.com/data', {
 *   method: 'POST',
 *   body: JSON.stringify(data),
 * });
 * ```
 */
export async function fetchWithRetry(
  url: string,
  init?: RequestInit,
  retryOptions: RetryOptions = {}
): Promise<Response> {
  return withRetry(
    async () => {
      const response = await fetch(url, init);

      // Throw on retryable status codes so retry logic can handle them
      if (RETRYABLE_STATUS_CODES.includes(response.status)) {
        const text = await response.text();
        const error = new Error(`HTTP ${response.status}: ${text.slice(0, 200)}`);
        (error as Error & { status: number }).status = response.status;
        throw error;
      }

      return response;
    },
    {
      operationName: `fetch ${url}`,
      ...retryOptions,
    }
  );
}

/**
 * Fetch JSON with automatic retry
 *
 * @example
 * ```ts
 * interface User { id: string; name: string; }
 * const user = await fetchJsonWithRetry<User>('https://api.example.com/user/123');
 * ```
 */
export async function fetchJsonWithRetry<T>(
  url: string,
  init?: RequestInit,
  retryOptions: RetryOptions = {}
): Promise<T> {
  const response = await fetchWithRetry(url, init, retryOptions);

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`HTTP ${response.status}: ${text.slice(0, 200)}`);
  }

  return (await response.json()) as T;
}

// =============================================================================
// Error Inspection (serv-audio-orders addition)
// =============================================================================

/**
 * Pull an HTTP status off the error shapes thrown by fetch wrappers and SDKs
 * (Deepgram, @google/genai). Falls back to a 429/5xx code in the message.
 */
export function errorStatus(error: unknown): number | null {
  if (typeof error !== 'object' || error === null) return null;
  const err = error as { status?: unknown; statusCode?: unknown; code?: unknown; response?: { status?: unknown } };
  for (const v of [err.status, err.statusCode, err.response?.status, err.code]) if (typeof v === 'number') return v;
  const m = /\b(429|5\d\d)\b/.exec(String((error as Error).message ?? ''));
  return m ? Number(m[1]) : null;
}
