/**
 * Tiny HTTP layer shared by the weather client and the iCal calendar
 * provider. Everything network-facing is behind these small interfaces so
 * tests inject fixtures / in-memory bodies and never touch the network.
 *
 * NOTE on secrets: some URLs are bearer secrets (a Google Calendar "secret
 * address in iCal format" IS the credential). {@link NodeFetcher} therefore
 * lets the caller decide how a URL is named in error messages via
 * {@link NodeFetcherOptions.describeUrl}; pass a redacting describer for
 * secret URLs so no error can ever leak them.
 */

/** Minimal JSON GET abstraction so tests can inject fixtures. */
export interface HttpJsonFetcher {
  getJson(url: string): Promise<unknown>;
}

/** Minimal text GET abstraction (used for iCal/ICS feeds). */
export interface HttpTextFetcher {
  getText(url: string): Promise<string>;
}

/** Default per-request timeout (ms). */
export const DEFAULT_FETCH_TIMEOUT_MS = 10_000;

export interface NodeFetcherOptions {
  /** Abort the request after this many milliseconds (default {@link DEFAULT_FETCH_TIMEOUT_MS}). */
  timeoutMs?: number;
  /** Injectable fetch implementation (tests); defaults to Node's global fetch. */
  fetchImpl?: typeof fetch;
  /** Extra request headers (merged over the per-method defaults). */
  headers?: Record<string, string>;
  /**
   * How to name a URL inside error messages. Defaults to the URL itself
   * (fine for public APIs); pass a redacting describer for secret URLs.
   */
  describeUrl?: (url: string) => string;
}

const DEFAULT_USER_AGENT = "runup/0.1 (personal flight planning tool)";

/** Default fetcher using Node's global fetch, with a request timeout. */
export class NodeFetcher implements HttpJsonFetcher, HttpTextFetcher {
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;
  private readonly headers: Record<string, string>;
  private readonly describeUrl: (url: string) => string;

  constructor(opts: NodeFetcherOptions = {}) {
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_FETCH_TIMEOUT_MS;
    this.fetchImpl = opts.fetchImpl ?? ((input, init) => fetch(input, init));
    this.headers = opts.headers ?? {};
    this.describeUrl = opts.describeUrl ?? ((url) => url);
  }

  /** GET a URL and return the response body as text. */
  async getText(url: string): Promise<string> {
    return this.request(url, { Accept: "text/plain, */*" });
  }

  /** GET a URL and parse the body as JSON (an empty body is treated as `[]`). */
  async getJson(url: string): Promise<unknown> {
    const text = await this.request(url, { Accept: "application/json" });
    // aviationweather.gov returns an empty body (not "[]") when no reports match.
    return text.trim().length === 0 ? [] : JSON.parse(text);
  }

  private async request(url: string, defaultHeaders: Record<string, string>): Promise<string> {
    const label = this.describeUrl(url);
    try {
      const res = await this.fetchImpl(url, {
        headers: { "User-Agent": DEFAULT_USER_AGENT, ...defaultHeaders, ...this.headers },
        signal: AbortSignal.timeout(this.timeoutMs),
      });
      if (!res.ok) {
        throw new Error(`request failed: ${res.status} ${res.statusText} for ${label}`);
      }
      return await res.text();
    } catch (err) {
      if (isTimeoutError(err)) {
        throw new Error(`request timed out after ${this.timeoutMs} ms for ${label}`);
      }
      throw err;
    }
  }
}

/** True for the abort raised by an expired AbortSignal.timeout() (or an aborted request). */
function isTimeoutError(err: unknown): boolean {
  return err instanceof Error && (err.name === "TimeoutError" || err.name === "AbortError");
}
