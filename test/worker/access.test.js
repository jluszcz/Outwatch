import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { env } from 'cloudflare:test';
import { SignJWT, generateKeyPair } from 'jose';
import worker from '../../src/index.js';
import {
    AUD,
    KID,
    TEAM_DOMAIN,
    accessEnv,
    signAccessToken,
    stubJwksEndpoint,
} from './access-token.js';

function makeEnv(overrides = {}) {
    return {
        ...env,
        ...accessEnv,
        DEV_USER_EMAIL: undefined,
        ASSETS: { fetch: vi.fn().mockResolvedValue(new Response('index.html')) },
        DB: env.DB,
        ...overrides,
    };
}

// `token` is the Cf-Access-Jwt-Assertion header; `email` is the *plaintext*
// Cf-Access-Authenticated-User-Email header Access sets alongside it, which this
// app deliberately never trusts. Tests set them independently on purpose.
function req(path, { token, email, envOverrides } = {}) {
    const headers = {};
    if (token) headers['Cf-Access-Jwt-Assertion'] = token;
    if (email) headers['Cf-Access-Authenticated-User-Email'] = email;
    return worker.fetch(
        new Request(`https://example.com${path}`, { headers }),
        makeEnv(envOverrides),
    );
}

async function me(options) {
    const r = await req('/api/board', options);
    return { status: r.status, body: await r.json() };
}

beforeEach(async () => {
    await stubJwksEndpoint();
    await env.DB.exec('DELETE FROM watched');
    await env.DB.exec('DELETE FROM user_emails');
    await env.DB.exec('DELETE FROM users');
    await env.DB.exec('DELETE FROM seasons');
    await env.DB.exec("INSERT INTO users (id, name, sort_order) VALUES ('user-alice', 'Alice', 1)");
    await env.DB.exec("INSERT INTO users (id, name, sort_order) VALUES ('user-bob', 'Bob', 2)");
    await env.DB.exec(
        'INSERT INTO user_emails (email, user_id) VALUES ' +
            "('alice@example.com', 'user-alice'), ('bob@example.com', 'user-bob')",
    );
});

afterEach(() => {
    vi.unstubAllGlobals();
});

describe('Access token verification', () => {
    it('resolves the caller from a validly signed token', async () => {
        const { status, body } = await me({ token: await signAccessToken() });
        expect(status).toBe(200);
        expect(body.me).toEqual({ id: 'user-alice', name: 'Alice' });
    });

    it('lowercases the token email before matching the roster', async () => {
        const { body } = await me({ token: await signAccessToken({ email: 'BOB@EXAMPLE.COM' }) });
        expect(body.me.id).toBe('user-bob');
    });

    it('returns me: null for a verified token whose email is not on the roster', async () => {
        const { status, body } = await me({
            token: await signAccessToken({ email: 'stranger@example.com' }),
        });
        expect(status).toBe(200);
        expect(body.me).toBeNull();
    });
});

describe('the plaintext identity header alone', () => {
    // The whole point of verifying the JWT: Cf-Access-Authenticated-User-Email is
    // only as trustworthy as the hostname it arrived on, so on its own it grants
    // nothing. Anyone can send it to a hostname the Access app does not cover.
    it('grants no identity', async () => {
        const { status, body } = await me({ email: 'alice@example.com' });
        expect(status).toBe(200);
        expect(body.me).toBeNull();
    });

    it('cannot override the identity in a valid token', async () => {
        const { body } = await me({
            token: await signAccessToken({ email: 'alice@example.com' }),
            email: 'bob@example.com',
        });
        expect(body.me.id).toBe('user-alice');
    });

    it('is rejected on a mutation', async () => {
        const r = await worker.fetch(
            new Request('https://example.com/api/watched', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Cf-Access-Authenticated-User-Email': 'alice@example.com',
                },
                body: JSON.stringify({ season_id: 1 }),
            }),
            makeEnv(),
        );
        expect(r.status).toBe(403);
    });
});

describe('an unverifiable token', () => {
    async function expectRejected(token) {
        const r = await req('/api/board', { token });
        expect(r.status).toBe(403);
        expect((await r.json()).error).toMatch(/token/i);
    }

    it('is rejected when signed by a key that is not in the JWKS', async () => {
        const { privateKey } = await generateKeyPair('RS256', { extractable: true });
        await expectRejected(await signAccessToken({ key: privateKey }));
    });

    it('is rejected when the kid names no key in the JWKS', async () => {
        await expectRejected(await signAccessToken({ kid: 'not-a-real-key' }));
    });

    it('is rejected when the aud is another application', async () => {
        await expectRejected(await signAccessToken({ aud: 'some-other-application-aud-tag' }));
    });

    it('is rejected when the issuer is another team', async () => {
        await expectRejected(
            await signAccessToken({ issuer: 'https://attacker.cloudflareaccess.com' }),
        );
    });

    it('is rejected when expired', async () => {
        await expectRejected(await signAccessToken({ expiresIn: '-1h' }));
    });

    it('is rejected when it carries no expiry at all', async () => {
        await expectRejected(await signAccessToken({ expiresIn: null }));
    });

    it('is rejected when unsigned (alg: none)', async () => {
        const part = (obj) => btoa(JSON.stringify(obj)).replace(/=+$/, '');
        const header = part({ alg: 'none', kid: KID });
        const payload = part({
            email: 'alice@example.com',
            aud: AUD,
            iss: TEAM_DOMAIN,
            exp: Math.floor(Date.now() / 1000) + 3600,
        });
        await expectRejected(`${header}.${payload}.`);
    });

    it('is rejected when symmetrically signed (algorithm confusion)', async () => {
        const token = await new SignJWT({ email: 'alice@example.com' })
            .setProtectedHeader({ alg: 'HS256', kid: KID })
            .setIssuedAt()
            .setIssuer(TEAM_DOMAIN)
            .setAudience(AUD)
            .setExpirationTime('1h')
            .sign(new TextEncoder().encode('a'.repeat(32)));
        await expectRejected(token);
    });

    it('is rejected when it carries no email claim (e.g. a service token)', async () => {
        await expectRejected(await signAccessToken({ email: null }));
    });

    it('is rejected when the email claim is present but empty', async () => {
        await expectRejected(await signAccessToken({ email: '' }));
    });

    it('does not fall back to DEV_USER_EMAIL', async () => {
        const r = await req('/api/board', {
            token: await signAccessToken({ aud: 'wrong' }),
            envOverrides: { DEV_USER_EMAIL: 'alice@example.com' },
        });
        expect(r.status).toBe(403);
    });
});

describe('missing Access configuration', () => {
    // Holding a token with no way to check it is a deployment error, not a client
    // one — and trusting it unverified is exactly what this code exists to stop.
    it('fails closed with a 500 when ACCESS_AUD is unset', async () => {
        const r = await req('/api/board', {
            token: await signAccessToken(),
            envOverrides: { ACCESS_AUD: undefined },
        });
        expect(r.status).toBe(500);
        expect((await r.json()).error).toMatch(/not configured/i);
    });

    it('fails closed with a 500 when ACCESS_TEAM_DOMAIN is unset', async () => {
        const r = await req('/api/board', {
            token: await signAccessToken(),
            envOverrides: { ACCESS_TEAM_DOMAIN: undefined },
        });
        expect(r.status).toBe(500);
    });

    it('does not block an unauthenticated request', async () => {
        // No token, nothing to verify: the misconfiguration is invisible until
        // someone actually signs in, so reads still work as "not signed in".
        const r = await req('/api/board', { envOverrides: { ACCESS_AUD: undefined } });
        expect(r.status).toBe(200);
        expect((await r.json()).me).toBeNull();
    });
});

describe('the team domain setting', () => {
    it('accepts a bare hostname as well as a full URL', async () => {
        const { body } = await me({
            token: await signAccessToken(),
            envOverrides: { ACCESS_TEAM_DOMAIN: 'test-team.cloudflareaccess.com' },
        });
        expect(body.me.id).toBe('user-alice');
    });

    it('tolerates a trailing slash', async () => {
        const { body } = await me({
            token: await signAccessToken(),
            envOverrides: { ACCESS_TEAM_DOMAIN: `${TEAM_DOMAIN}/` },
        });
        expect(body.me.id).toBe('user-alice');
    });
});

describe('local dev identity', () => {
    it('falls back to DEV_USER_EMAIL when there is no token', async () => {
        const { body } = await me({ envOverrides: { DEV_USER_EMAIL: 'alice@example.com' } });
        expect(body.me.id).toBe('user-alice');
    });

    it('needs no Access configuration', async () => {
        const { body } = await me({
            envOverrides: {
                DEV_USER_EMAIL: 'alice@example.com',
                ACCESS_TEAM_DOMAIN: undefined,
                ACCESS_AUD: undefined,
            },
        });
        expect(body.me.id).toBe('user-alice');
    });
});
