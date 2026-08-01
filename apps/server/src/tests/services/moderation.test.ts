import { describe, expect, it } from 'vitest'
import { decideModerationOutcome } from '../../features/chat/moderation.js'

describe('moderation.decideModerationOutcome', () => {
	it('allows and publishes the original text when no rewrite is given', () => {
		expect(
			decideModerationOutcome({ status: 200, body: { verdict: 'allow' } }),
		).toEqual({
			allowed: true,
			publishText: null,
		})
	})

	it('allows and returns the rewrite when publishText is a non-empty string', () => {
		expect(
			decideModerationOutcome({
				status: 200,
				body: { verdict: 'allow', publishText: 'cleaned up text' },
			}),
		).toEqual({ allowed: true, publishText: 'cleaned up text' })
	})

	it('treats an empty-string publishText as no rewrite', () => {
		expect(
			decideModerationOutcome({
				status: 200,
				body: { verdict: 'allow', publishText: '' },
			}),
		).toEqual({ allowed: true, publishText: null })
	})

	it('blocks with reason rate_limited for the rate_limited band', () => {
		expect(
			decideModerationOutcome({
				status: 200,
				body: { verdict: 'reject', band: 'rate_limited' },
			}),
		).toEqual({ allowed: false, reason: 'rate_limited' })
	})

	it('blocks with reason rate_limited for a conventional HTTP 429, regardless of body shape', () => {
		expect(
			decideModerationOutcome({ status: 429, body: { verdict: 'allow' } }),
		).toEqual({ allowed: false, reason: 'rate_limited' })
		expect(decideModerationOutcome({ status: 429, body: null })).toEqual({
			allowed: false,
			reason: 'rate_limited',
		})
		expect(
			decideModerationOutcome({
				status: 429,
				body: '<html>too many requests</html>',
			}),
		).toEqual({ allowed: false, reason: 'rate_limited' })
	})

	it.each(['threat_block', 'blocklist', 'safety_block', 'guard_block'])(
		'blocks with the generic reason for the %s band',
		(band) => {
			expect(
				decideModerationOutcome({
					status: 200,
					body: { verdict: 'reject', band },
				}),
			).toEqual({
				allowed: false,
				reason: 'moderated',
			})
		},
	)

	it('reports guard_unavailable as unavailable, not as a rule violation', () => {
		// The service rejected because its own model was down. Telling the
		// player they broke a rule would be a lie.
		expect(
			decideModerationOutcome({
				status: 200,
				body: { verdict: 'reject', band: 'guard_unavailable' },
			}),
		).toEqual({ allowed: false, reason: 'unavailable' })
	})

	it('degrades an unrecognised reject band to the generic block, never an allow', () => {
		expect(
			decideModerationOutcome({
				status: 200,
				body: { verdict: 'reject', band: 'some_future_band' },
			}),
		).toEqual({ allowed: false, reason: 'moderated' })
	})

	it('blocks with reason moderated when a reject has no band at all', () => {
		expect(
			decideModerationOutcome({ status: 200, body: { verdict: 'reject' } }),
		).toEqual({
			allowed: false,
			reason: 'moderated',
		})
	})

	it('fails closed as unavailable on a transport failure (null attempt)', () => {
		expect(decideModerationOutcome(null)).toEqual({
			allowed: false,
			reason: 'unavailable',
		})
	})

	it.each([400, 401, 413, 500, 503])(
		'fails closed as unavailable for HTTP status %i',
		(status) => {
			expect(
				decideModerationOutcome({ status, body: { verdict: 'allow' } }),
			).toEqual({
				allowed: false,
				reason: 'unavailable',
			})
		},
	)

	it('fails closed as unavailable on an unparseable body', () => {
		expect(decideModerationOutcome({ status: 200, body: null })).toEqual({
			allowed: false,
			reason: 'unavailable',
		})
		expect(
			decideModerationOutcome({
				status: 200,
				body: '<html>proxy error</html>',
			}),
		).toEqual({
			allowed: false,
			reason: 'unavailable',
		})
		expect(decideModerationOutcome({ status: 200, body: [] })).toEqual({
			allowed: false,
			reason: 'unavailable',
		})
	})

	it('fails closed as unavailable on an unrecognised verdict value', () => {
		expect(
			decideModerationOutcome({ status: 200, body: { verdict: 'maybe' } }),
		).toEqual({
			allowed: false,
			reason: 'unavailable',
		})
	})

	it('fails closed as unavailable when band or publishText have the wrong type', () => {
		expect(
			decideModerationOutcome({
				status: 200,
				body: { verdict: 'reject', band: 42 },
			}),
		).toEqual({ allowed: false, reason: 'unavailable' })
		expect(
			decideModerationOutcome({
				status: 200,
				body: { verdict: 'allow', publishText: 42 },
			}),
		).toEqual({ allowed: false, reason: 'unavailable' })
	})
})
