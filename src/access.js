import { createRemoteJWKSet, jwtVerify } from 'jose';
import { HTTPException } from 'hono/http-exception';

// Cloudflare Access signs its identity tokens with RS256 and publishes the public
// keys at <team domain>/cdn-cgi/access/certs. Pinning the algorithm here means a
// token that nominates any other one — `none`, or an HMAC over a key we would
// have to guess — never reaches signature verification at all.
const ALGORITHMS = ['RS256'];

// Access rotates its signing keys, so the key set has to be re-fetchable rather
// than read once. jose's remote key set does exactly that: it caches the JWKS,
// refetches when a token names a key it hasn't seen (rate-limited by its own
// cooldown), and shares one in-flight request. Keep one per team domain for the
// isolate's lifetime — a fresh one per request would refetch the JWKS per request.
const keySets = new Map();

function keySetFor(certsUrl) {
    let keySet = keySets.get(certsUrl);
    if (!keySet) {
        keySet = createRemoteJWKSet(new URL(certsUrl));
        keySets.set(certsUrl, keySet);
    }
    return keySet;
}

// The token's issuer is the team domain in `https://team.cloudflareaccess.com`
// form. Accept a bare hostname too: writing it without the scheme is the easiest
// way to misconfigure this into locking the whole roster out, and being lenient
// about the spelling gives up nothing — the issuer is still compared exactly.
function normalizeTeamDomain(value) {
    const trimmed = value.replace(/\/+$/, '');
    return /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
}

/**
 * Verifies a Cloudflare Access JWT and returns the caller's email, lowercased.
 *
 * Throws an HTTPException rather than returning null: an unverifiable token is a
 * different situation from no token at all — one is a forgery or a
 * misconfiguration and deserves to be visible, the other is just a signed-out
 * request — and neither may be quietly treated as "signed in".
 */
export async function accessTokenEmail(token, env) {
    const teamDomain = (env.ACCESS_TEAM_DOMAIN || '').trim();
    const aud = (env.ACCESS_AUD || '').trim();
    if (!teamDomain || !aud) {
        console.error(
            'Cannot verify an Access token: set ACCESS_TEAM_DOMAIN and ACCESS_AUD ' +
                '(wrangler secret put ...) to the team domain and the application AUD tag.',
        );
        throw new HTTPException(500, { message: 'Access verification is not configured' });
    }

    const issuer = normalizeTeamDomain(teamDomain);
    let payload;
    try {
        ({ payload } = await jwtVerify(token, keySetFor(`${issuer}/cdn-cgi/access/certs`), {
            issuer,
            // The AUD tag is per-application: without this check a valid token for
            // any other application in the same Zero Trust account would pass.
            audience: aud,
            algorithms: ALGORITHMS,
            // Access always sends these. Requiring them keeps a token that simply
            // omits `exp` from being treated as one that never expires.
            requiredClaims: ['exp', 'iat', 'email'],
        }));
    } catch (err) {
        // The reason is for `wrangler tail`, not the caller: which check failed is
        // useful to whoever configured Access and to nobody else.
        console.warn(`Access token verification failed: ${err.message}`);
        throw new HTTPException(403, { message: 'Access token verification failed' });
    }

    // `requiredClaims` above guarantees the claim is present, not that it names
    // anyone: a service-token JWT verifies perfectly well and has no user behind it.
    const email = typeof payload.email === 'string' ? payload.email.trim().toLowerCase() : '';
    if (!email) throw new HTTPException(403, { message: 'Access token carries no email' });
    return email;
}
