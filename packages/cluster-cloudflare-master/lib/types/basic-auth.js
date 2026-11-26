/** HTTP Basic Authentication verification using Web Crypto API. */
/**
 * Constant-time string equality check using crypto.subtle.
 * Prevents timing attacks on basic auth passwords.
 * @param a - First string.
 * @param b - Second string.
 * @returns true if strings are identical.
 */
export async function timingSafeEqual(a, b) {
    const encoder = new TextEncoder();
    const aBuf = encoder.encode(a);
    const bBuf = encoder.encode(b);
    if (aBuf.byteLength !== bBuf.byteLength) {
        return false;
    }
    // Use HMAC or direct subtle digest comparison for constant-time comparison
    const aHash = await crypto.subtle.digest('SHA-256', aBuf);
    const bHash = await crypto.subtle.digest('SHA-256', bBuf);
    const aView = new Uint8Array(aHash);
    const bView = new Uint8Array(bHash);
    let diff = 0;
    for (let i = 0; i < aView.length; i++) {
        diff |= aView[i] ^ bView[i];
    }
    return diff === 0;
}
/** Name of session cookie issued on successful basic auth. */
export const AUTH_COOKIE_NAME = 'dsh_auth';
/**
 * Computes deterministic auth cookie token based on credentials and optional secret salt.
 * @param user - Username.
 * @param pass - Password.
 * @param salt - Optional salt/token.
 * @returns SHA-256 hex string.
 */
export async function computeAuthCookieValue(user, pass, salt = '') {
    const data = new TextEncoder().encode(`${user}:${pass}:${salt}`);
    const hash = await crypto.subtle.digest('SHA-256', data);
    return Array.from(new Uint8Array(hash))
        .map(b => b.toString(16).padStart(2, '0'))
        .join('');
}
function parseCookie(cookieHeader, name) {
    if (!cookieHeader)
        return undefined;
    const parts = cookieHeader.split(';');
    for (const part of parts) {
        const [k, ...v] = part.trim().split('=');
        if (k === name) {
            return v.join('=');
        }
    }
    return undefined;
}
/**
 * Checks whether the incoming request satisfies HTTP Basic Authentication or carries a valid auth cookie.
 * @param request - Incoming HTTP request.
 * @param expectedUser - Configured username.
 * @param expectedPass - Configured password.
 * @param salt - Salt for cookie generation (e.g. AUTH_TOKEN).
 * @returns AuthResult indicating if authenticated and whether to issue a session cookie.
 */
export async function verifyAuth(request, expectedUser, expectedPass, salt = '') {
    if (!expectedUser && !expectedPass) {
        return { authenticated: true, shouldSetCookie: false };
    }
    const expectedCookie = await computeAuthCookieValue(expectedUser ?? '', expectedPass ?? '', salt);
    // 1. Check if valid session cookie is already present
    const cookieHeader = request.headers.get('Cookie');
    const clientCookie = parseCookie(cookieHeader, AUTH_COOKIE_NAME);
    if (clientCookie && (await timingSafeEqual(clientCookie, expectedCookie))) {
        return { authenticated: true, shouldSetCookie: false };
    }
    // 2. Fall back to checking Authorization: Basic header
    const authHeader = request.headers.get('Authorization');
    if (!authHeader || !authHeader.startsWith('Basic ')) {
        return { authenticated: false, shouldSetCookie: false };
    }
    const b64 = authHeader.slice(6).trim();
    let decoded;
    try {
        decoded = atob(b64);
    }
    catch {
        return { authenticated: false, shouldSetCookie: false };
    }
    const colonIdx = decoded.indexOf(':');
    if (colonIdx === -1) {
        return { authenticated: false, shouldSetCookie: false };
    }
    const user = decoded.slice(0, colonIdx);
    const pass = decoded.slice(colonIdx + 1);
    const userMatch = await timingSafeEqual(user, expectedUser ?? '');
    const passMatch = await timingSafeEqual(pass, expectedPass ?? '');
    if (userMatch && passMatch) {
        return {
            authenticated: true,
            shouldSetCookie: true,
            cookieValue: expectedCookie,
        };
    }
    return { authenticated: false, shouldSetCookie: false };
}
/**
 * Checks whether the incoming request satisfies HTTP Basic Authentication or cookie session.
 * @param request - Incoming HTTP request.
 * @param expectedUser - Configured username.
 * @param expectedPass - Configured password.
 * @param salt - Optional salt/token.
 * @returns true if authenticated or auth disabled.
 */
export async function verifyBasicAuth(request, expectedUser, expectedPass, salt = '') {
    const result = await verifyAuth(request, expectedUser, expectedPass, salt);
    return result.authenticated;
}
/**
 * Creates a standard 401 Unauthorized response with optional WWW-Authenticate header.
 * @param realm - Authentication realm name.
 * @param includeWwwAuthenticate - Whether to include the WWW-Authenticate header (default: true).
 * @returns 401 HTTP Response.
 */
export function unauthorizedResponse(realm = 'DeepSeek Harness', includeWwwAuthenticate = true) {
    const headers = new Headers({
        'content-type': 'text/plain; charset=utf-8',
    });
    if (includeWwwAuthenticate) {
        headers.set('www-authenticate', `Basic realm="${realm}"`);
    }
    return new Response('401 Unauthorized - Authentication required\n', {
        status: 401,
        headers,
    });
}
//# sourceMappingURL=basic-auth.js.map