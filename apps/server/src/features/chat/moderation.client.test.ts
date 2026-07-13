import { describe, expect, it } from 'vitest'
import {
	appealRemote,
	listHeldRemote,
	muteSignalRemote,
	reportRemote,
} from './moderation.client.js'

const opts = { url: 'http://mod', bearerToken: 'tok' }

function jsonFetch(status: number, body: unknown): typeof fetch {
	return (async (url: string | URL, init?: RequestInit) => {
		// biome-ignore lint/suspicious/noExplicitAny: test double
		;(jsonFetch as any).lastCall = { url: String(url), init }
		return new Response(JSON.stringify(body), {
			status,
			headers: { 'content-type': 'application/json' },
		})
	}) as unknown as typeof fetch
}

function throwingFetch(): typeof fetch {
	return (async () => {
		throw new TypeError('network down')
	}) as unknown as typeof fetch
}

describe('intake client', () => {
	it('reportRemote returns the reportId on 200', async () => {
		const r = await reportRemote(
			{
				reporterId: 'a',
				reportedPlayerId: 'b',
				message: 'bad',
				reason: 'harass',
			},
			{ ...opts, fetchFn: jsonFetch(200, { reportId: 'r1' }) },
		)
		expect(r).toEqual({ ok: true, data: { reportId: 'r1' } })
	})

	it('appealRemote returns the appealId on 200', async () => {
		const r = await appealRemote(
			{ playerId: 'c', message: 'held', originalBand: 'threat_block' },
			{ ...opts, fetchFn: jsonFetch(200, { appealId: 'ap1' }) },
		)
		expect(r).toEqual({ ok: true, data: { appealId: 'ap1' } })
	})

	it('muteSignalRemote returns the distinct-muter result', async () => {
		const r = await muteSignalRemote(
			{ muterId: 'm', mutedPlayerId: 't' },
			{
				...opts,
				fetchFn: jsonFetch(200, { distinctMuters: 5, flagged: true }),
			},
		)
		expect(r).toEqual({ ok: true, data: { distinctMuters: 5, flagged: true } })
	})

	it('listHeldRemote passes playerId + lobbyCode as query params', async () => {
		const fetchFn = jsonFetch(200, { held: [] })
		await listHeldRemote(
			{ playerId: 'p', lobbyCode: 'ABCD' },
			{ ...opts, fetchFn },
		)
		// biome-ignore lint/suspicious/noExplicitAny: test double
		const call = (jsonFetch as any).lastCall as { url: string }
		expect(call.url).toContain('/held?')
		expect(call.url).toContain('playerId=p')
		expect(call.url).toContain('lobbyCode=ABCD')
	})

	it('fails soft on a network error (never throws)', async () => {
		const r = await muteSignalRemote(
			{ muterId: 'm', mutedPlayerId: 't' },
			{ ...opts, fetchFn: throwingFetch() },
		)
		expect(r).toEqual({ ok: false, cause: 'TypeError' })
	})

	it('fails soft on a non-2xx status', async () => {
		const r = await reportRemote(
			{ reporterId: 'a', reportedPlayerId: 'b', message: 'x' },
			{ ...opts, fetchFn: jsonFetch(503, {}) },
		)
		expect(r).toEqual({ ok: false, cause: 'http_503' })
	})
})
