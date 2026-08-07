<?php

/**
 * PHP client for the osu! API scheduler.
 *
 * The scheduler is the single owner of a host's osu! API request budget: it
 * queues every project's requests by how much delay each can absorb, paces the
 * whole host against one rate limit, and backs off once for everyone. Nothing
 * on the host should call osu.ppy.sh directly, because a per-IP limit can only
 * be respected by something that sees all of the traffic.
 *
 * Two different tokens are involved; do not conflate them:
 *
 *   - Your *osu!* token goes in the Authorization header as usual. The
 *     scheduler forwards it untouched and never substitutes its own, so your
 *     app keeps its own identity and its own osu! application.
 *   - The *scheduler* token is a shared password that grants use of the request
 *     budget. It is what makes the proxy safe to expose.
 *
 * Configuration, in order of precedence: constants defined before this file is
 * required, then environment variables, then the defaults.
 *
 *   define('OSU_API_SCHEDULER_URL',        'http://127.0.0.1:7654');
 *   define('OSU_API_SCHEDULER_TOKEN',      '…');           // or …_TOKEN_FILE
 *   define('OSU_API_SCHEDULER_TOKEN_FILE', '/etc/osu-api-scheduler/token');
 *
 * @license AGPL-3.0-or-later
 */
class OsuApiScheduler {

	const DEFAULT_URL = 'http://127.0.0.1:7654';
	const DEFAULT_TOKEN_FILE = '/etc/osu-api-scheduler/token';

	/** Must exceed the scheduler's own max wait, or curl gives up first. */
	const CONNECT_TIMEOUT_S = 5;
	const TIMEOUT_S = 330;

	/** Default deadline for P_INTERACTIVE, where a browser is waiting. */
	const INTERACTIVE_MAX_WAIT_MS = 15000;

	/**
	 * Priority levels. The scheduler knows nothing about who is calling -- you
	 * state how much delay your own work can absorb and it schedules on that.
	 *
	 * Pick by what a delay costs, not by how much you care about the job.
	 */
	/** A missed window cannot be recovered. */
	const P_REALTIME = 'realtime';
	/** Someone is waiting on the response. */
	const P_INTERACTIVE = 'interactive';
	/** Background, but something visible is stale until it lands. */
	const P_HIGH = 'high';
	/** Routine background work. */
	const P_NORMAL = 'normal';
	/** Sweeps and housekeeping that soak up whatever capacity is left over. */
	const P_BULK = 'bulk';

	private static ?string $token = null;

	private static function setting(string $name, string $default): string {
		if (defined($name)) return (string)constant($name);
		$env = getenv($name);
		return $env === false || $env === '' ? $default : $env;
	}

	public static function baseUrl(): string {
		return rtrim(self::setting('OSU_API_SCHEDULER_URL', self::DEFAULT_URL), '/');
	}

	public static function token(): string {
		if (self::$token !== null) return self::$token;

		$direct = self::setting('OSU_API_SCHEDULER_TOKEN', '');
		if ($direct !== '') return self::$token = $direct;

		$file = self::setting('OSU_API_SCHEDULER_TOKEN_FILE', self::DEFAULT_TOKEN_FILE);
		$raw = @file_get_contents($file);
		return self::$token = $raw === false ? '' : trim($raw);
	}

	/**
	 * @param string $path  Upstream path, with or without a leading slash:
	 *                      "api/v2/users/123/mania" or "api/get_beatmaps?k=..".
	 * @param string $tier  One of the P_* priority constants.
	 * @param array  $opts  consumer, method, body, headers, max_wait_ms, never_expire
	 *
	 *   consumer => 'name/1.0'  states who is calling. It becomes the
	 *   User-Agent, which is both what osu! sees and what the dashboard groups
	 *   usage by, so anything that skips it shows up as "unknown".
	 *
	 *   never_expire => true  queues the request until it is served, however
	 *   long a backoff lasts, and lifts this side's timeout to match. Use it
	 *   where giving up loses data rather than merely delaying it. It holds a
	 *   PHP process for the duration, so it is wrong for anything serving a page.
	 *
	 * @return array{status:int, body:string, headers:array, scheduler_error:?string, from_upstream:bool, waited_ms:int}
	 *         `from_upstream` is the only safe test for "osu! answered this".
	 *         When it is false the status belongs to the scheduler, not to osu!,
	 *         and says nothing about the thing you asked for: do not read it as
	 *         a verdict on the resource. Retry later instead.
	 */
	public static function request(string $path, string $tier, array $opts = []): array {
		$method = strtoupper($opts['method'] ?? 'GET');
		$body = $opts['body'] ?? null;
		$neverExpire = !empty($opts['never_expire']);

		// An interactive caller has a page open in front of someone. Failing in
		// a few seconds is kinder than holding the request until the browser
		// gives up, so it gets a short deadline unless told otherwise.
		$maxWait = $opts['max_wait_ms']
			?? ($tier === self::P_INTERACTIVE ? self::INTERACTIVE_MAX_WAIT_MS : null);

		$headers = [
			'X-Osu-Priority: ' . $tier,
			'X-Scheduler-Token: ' . self::token(),
		];
		if ($neverExpire) {
			$headers[] = 'X-Osu-Max-Wait-Ms: 0';
		} elseif ($maxWait !== null) {
			$headers[] = 'X-Osu-Max-Wait-Ms: ' . (int)$maxWait;
		}
		foreach (($opts['headers'] ?? []) as $h) {
			$headers[] = $h;
		}
		if ($body !== null) {
			$headers[] = 'Content-Type: application/json';
		}
		if (!empty($opts['consumer'])) {
			$headers[] = 'User-Agent: ' . $opts['consumer'];
		}

		$responseHeaders = [];
		$ch = curl_init();
		curl_setopt($ch, CURLOPT_URL, self::baseUrl() . '/' . ltrim($path, '/'));
		curl_setopt($ch, CURLOPT_RETURNTRANSFER, true);
		curl_setopt($ch, CURLOPT_HTTPHEADER, $headers);
		curl_setopt($ch, CURLOPT_CONNECTTIMEOUT, self::CONNECT_TIMEOUT_S);
		// 0 disables curl's own timeout. Without this the scheduler would hold
		// the job while this side hung up, which is the worst of both: the
		// request still costs budget but nobody reads the answer.
		curl_setopt($ch, CURLOPT_TIMEOUT, $neverExpire ? 0 : (int)($opts['timeout_s'] ?? self::TIMEOUT_S));
		if ($method !== 'GET') {
			curl_setopt($ch, CURLOPT_CUSTOMREQUEST, $method);
			if ($body !== null) curl_setopt($ch, CURLOPT_POSTFIELDS, $body);
		}
		curl_setopt($ch, CURLOPT_HEADERFUNCTION, function ($_, $header) use (&$responseHeaders) {
			$parts = explode(':', $header, 2);
			if (count($parts) === 2) {
				$responseHeaders[strtolower(trim($parts[0]))] = trim($parts[1]);
			}
			return strlen($header);
		});

		$out = curl_exec($ch);
		$status = (int)curl_getinfo($ch, CURLINFO_HTTP_CODE);
		$err = curl_error($ch);

		if ($out === false) {
			// Scheduler down or unreachable. Fail closed: the whole point is
			// that nothing bypasses it, so never fall back to calling osu!
			// directly -- that is how a host earns a rate-limit ban.
			return [
				'status' => 0,
				'body' => '',
				'headers' => [],
				'scheduler_error' => 'unreachable',
				'from_upstream' => false,
				'waited_ms' => 0,
				'detail' => $err,
			];
		}

		return [
			'status' => $status,
			'body' => $out,
			'headers' => $responseHeaders,
			'scheduler_error' => $responseHeaders['x-scheduler-error'] ?? null,
			'from_upstream' => isset($responseHeaders['x-scheduler-upstream']),
			'waited_ms' => (int)($responseHeaders['x-scheduler-waited-ms'] ?? 0),
		];
	}

	/** Convenience: decoded JSON body, or null on any scheduler failure. */
	public static function json(string $path, string $tier, array $opts = [], ?bool $assoc = null) {
		$r = self::request($path, $tier, $opts);
		if (!$r['from_upstream']) return null;
		return json_decode($r['body'], $assoc);
	}

	/** Queue depths, pacing and backoff state -- for dashboards and debugging. */
	public static function stats(): ?array {
		$r = self::request('stats', self::P_HIGH, ['timeout_s' => 5]);
		if ($r['scheduler_error'] !== null || $r['status'] !== 200) return null;
		return json_decode($r['body'], true);
	}
}
