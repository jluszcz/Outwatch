import { SignJWT, exportJWK, generateKeyPair } from 'jose';
import { vi } from 'vitest';

// A throwaway stand-in for a real Cloudflare Access setup: a team domain, an
// application AUD tag, and an RSA key pair playing the part of the one behind
// Cloudflare's /cdn-cgi/access/certs endpoint. Nothing here is a real value.
export const TEAM_DOMAIN = 'https://test-team.cloudflareaccess.com';
export const CERTS_URL = `${TEAM_DOMAIN}/cdn-cgi/access/certs`;
export const AUD = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
export const KID = 'test-signing-key';

// The Access config the Worker sees in production. Spread into a test env.
export const accessEnv = { ACCESS_TEAM_DOMAIN: TEAM_DOMAIN, ACCESS_AUD: AUD };

// Generated once per test file and memoized: RSA keygen is slow enough to notice
// if every signed token paid for it.
let keysPromise = null;

export function accessKeys() {
    keysPromise ??= (async () => {
        const { publicKey, privateKey } = await generateKeyPair('RS256', { extractable: true });
        const jwk = { ...(await exportJWK(publicKey)), kid: KID, alg: 'RS256', use: 'sig' };
        return { publicKey, privateKey, jwk };
    })();
    return keysPromise;
}

// Mints the JWT Access would put in the Cf-Access-Jwt-Assertion header. Every
// claim is overridable so tests can produce the forged and expired variants.
export async function signAccessToken({
    email = 'alice@example.com',
    aud = AUD,
    issuer = TEAM_DOMAIN,
    kid = KID,
    alg = 'RS256',
    expiresIn = '1h',
    key,
    claims = {},
} = {}) {
    const { privateKey } = await accessKeys();
    const jwt = new SignJWT({ ...(email === null ? {} : { email }), ...claims })
        .setProtectedHeader({ alg, kid })
        .setIssuedAt()
        .setIssuer(issuer)
        .setAudience(aud);
    if (expiresIn !== null) jwt.setExpirationTime(expiresIn);
    return jwt.sign(key ?? privateKey);
}

// Stands in for Cloudflare's JWKS endpoint. jose fetches it with the global
// fetch, so that is what we replace; anything else reaching for the network in a
// test is a bug worth failing on rather than silently allowing out.
export async function stubJwksEndpoint({ keys } = {}) {
    const { jwk } = await accessKeys();
    const body = { keys: keys ?? [jwk] };
    const stub = vi.fn(async (input) => {
        const url = typeof input === 'string' ? input : input.url;
        if (url === CERTS_URL) return Response.json(body);
        throw new Error(`unexpected fetch in test: ${url}`);
    });
    vi.stubGlobal('fetch', stub);
    return stub;
}
