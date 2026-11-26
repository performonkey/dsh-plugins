/** HTTP Basic Authentication verification using Web Crypto API. */
/**
 * Constant-time string equality check using crypto.subtle.
 * Prevents timing attacks on basic auth passwords.
 * @param a - First string.
 * @param b - Second string.
 * @returns true if strings are identical.
 */
export declare function timingSafeEqual(a: string, b: string): Promise<boolean>;
/** Name of session cookie issued on successful basic auth. */
export declare const AUTH_COOKIE_NAME = "dsh_auth";
/**
 * Computes deterministic auth cookie token based on credentials and optional secret salt.
 * @param user - Username.
 * @param pass - Password.
 * @param salt - Optional salt/token.
 * @returns SHA-256 hex string.
 */
export declare function computeAuthCookieValue(user: string, pass: string, salt?: string): Promise<string>;
/** Result of authentication check. */
export interface AuthResult {
    readonly authenticated: boolean;
    readonly shouldSetCookie: boolean;
    readonly cookieValue?: string | undefined;
}
/**
 * Checks whether the incoming request satisfies HTTP Basic Authentication or carries a valid auth cookie.
 * @param request - Incoming HTTP request.
 * @param expectedUser - Configured username.
 * @param expectedPass - Configured password.
 * @param salt - Salt for cookie generation (e.g. AUTH_TOKEN).
 * @returns AuthResult indicating if authenticated and whether to issue a session cookie.
 */
export declare function verifyAuth(request: Request, expectedUser?: string, expectedPass?: string, salt?: string): Promise<AuthResult>;
/**
 * Checks whether the incoming request satisfies HTTP Basic Authentication or cookie session.
 * @param request - Incoming HTTP request.
 * @param expectedUser - Configured username.
 * @param expectedPass - Configured password.
 * @param salt - Optional salt/token.
 * @returns true if authenticated or auth disabled.
 */
export declare function verifyBasicAuth(request: Request, expectedUser?: string, expectedPass?: string, salt?: string): Promise<boolean>;
/**
 * Creates a standard 401 Unauthorized response with optional WWW-Authenticate header.
 * @param realm - Authentication realm name.
 * @param includeWwwAuthenticate - Whether to include the WWW-Authenticate header (default: true).
 * @returns 401 HTTP Response.
 */
export declare function unauthorizedResponse(realm?: string, includeWwwAuthenticate?: boolean): Response;
//# sourceMappingURL=basic-auth.d.ts.map