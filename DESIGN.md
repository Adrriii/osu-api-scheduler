# Design notes

Why the scheduling works the way it does. To install it, see the README.

Most of the rules below exist because a simpler version was tried first and
broke in a specific way. Those failures are recorded here so they do not get
reintroduced.

## The problem

The osu! API rate limit is enforced per IP address, in front of the application.
A 429 comes back with `error code: 1015` and a `retry-after` of about 1800.

Two things follow. Every project on one server draws from one budget no matter
whose OAuth token it holds, so throttling any single project fixes nothing. And
the budget is small enough that something has to decide who goes first, or the
decision is made by whichever cron happened to fire.

Measured across 14 consecutive lockouts on one server: the limiter tripped at
roughly 1,150 to 1,200 requests every time, then locked out for 30 minutes.
That matches what osu! documents, 60 requests per minute sustained with bursts
to 1200, and it is the shape of a token bucket.

## The rate model

A global token bucket mirrors the upstream one. It refills at the sustained rate
and caps at the burst allowance. Nothing is sent unless it holds a token.

It starts empty. The upstream bucket's real level is not visible, so assuming a
full one after a restart would be a 1200 request gamble.

Each priority level then gets its **own** bucket, with two settings that are
deliberately independent:

- **Share** is its slice of the sustained rate.
- **Burst** is how much it may bank while idle and spend in a hurry.

These pull in opposite directions on purpose. A score collector sends a few
requests a minute but needs to go hard after an outage, so it gets a small share
and large headroom. A nightly sweep is busy continuously, so its bucket never
sits full and headroom would be wasted on it. What it needs is the larger
average.

Deriving burst from share is wrong, and it was the first version. Lowering a
level's share to free up rate silently cut its headroom too, which is the
opposite of the intent.

## Base rate before bank

A level's share is credited to its own bank and it spends from there. So the
rate serves that level's own requests first, and the bank is simply what it did
not spend. The bank is not a competing claim on the rate.

The only credit that moves elsewhere is a share a full bank cannot hold. That
goes to whoever has requests queued, and it deliberately does not fire before
the bank is full.

Measured on a 60/min tick with sweeps backlogged:

| Fast levels' banks | Reaches queued work |
|---|---|
| empty | 39/min |
| one full | 45/min |
| all full | 60/min |

Two earlier versions were wrong. Splitting each tick 50/50 between banking and
chasing queued work took rate *away* from levels to force banking. Giving 100%
to queued work meant the quiet levels never banked at all, so their headroom
only ever built during a backoff, which is too late to be a cushion.

## Banks never go negative

A level spends its own bank. If that is empty it may draw on a **lower**
priority level's bank, taking from the least important available first. A lower
level can never touch a higher one's.

That is what lets a burst at the top visibly slow the sweeps instead of being
capped at the refill rate, and it is one directional, so a sweep cannot eat the
headroom that exists for recovery.

An earlier version let a level borrow past its share and charged it back, so
banks went negative. Worse, that borrowing was ordered by priority, which meant
whichever level had the biggest backlog took all the spare capacity. On one
server the background scans ran at 43/min against a 15/min guarantee while the
lowest level sat pinned at its floor.

## The global reserve

Per level headroom is worthless on its own. Nothing sends without a global
token, and a level with a backlog will borrow every spare one. Measured, that
held the global bucket at zero, so a level could bank 400 tokens and still only
manage the refill rate. A burst you cannot spend is not a burst.

So a slice of the global bucket is reserved for the latency critical levels.

It gates **borrowing only**. A level's own bank is always spendable while the
global bucket has anything in it. Gating own bank spending on the reserve
deadlocked levels that were holding budget they were not allowed to use: full
banks, requests queued over two minutes, nothing moving.

## Priority and aging

Strict order by level, with one exception: a job's effective priority improves
one step per minute waited. A saturated top level cannot pin the bottom one at
zero forever.

Aging is a safety net, not a scheduling strategy. A share is a floor, not a fast
lane. Putting a poller that needs to react quickly at a low priority cost it a
**120 second** wait behind a backlogged sweep, because it only got through once
aging lifted it. Moved to a level above the sweep it was 0.21 seconds.

## Backing off

Three different things answer with a 429, and they want different responses:

| | Looks like | Response |
|---|---|---|
| Per IP rate limit | `error code: 1015`, text/plain, sends `retry-after` | Wait it out. The whole host is out of budget |
| Bot challenge | `Just a moment...`, text/html, no `retry-after` | Not a quota. Retrying harder makes it worse |
| Per token limit | osu!'s own, clears in seconds | Short pause |

A challenge is aimed at one request, not at the budget. Only some endpoints draw
one while the rest keep answering, so a challenged request goes to the back of
its lane and the other levels keep moving. Only a burst of them within a minute
is treated as a real block. Stopping the world for a single challenge meant one
awkward endpoint throttled everything.

The backoff is written to disk and re-read at startup, so a restart during a
lockout does not walk straight back into it.

## Two tokens

Do not conflate them.

The **osu! token** belongs to each calling application. It is forwarded
untouched. The scheduler holds no osu! credentials and never speaks for another
app, so each project keeps its own identity and its own rate accounting on
osu!'s side.

The **scheduler token** is a shared password granting use of the request budget.
That is the part worth stealing: roughly 1200 requests from anyone locks a whole
server out for 30 minutes, and no osu! credential is needed to do it. This is
what makes the proxy safe to expose.

## Requests that must not be dropped

By default a queued request has a deadline and gets a 504 if it passes.

`X-Osu-Max-Wait-Ms: 0` queues it until it is served, however long a backoff
lasts. Use it where giving up loses data rather than merely delaying it. The
osu! API keeps a short window of recent scores, so a poll abandoned during a
lockout is data nobody can go back for.

The client must lift its own timeout to match, or the scheduler holds a job
whose caller has already hung up: the request still costs budget and nobody
reads the answer.

## Failed is not dropped

A response that never reached osu! says nothing about what was asked for. A
scheduler error, a 5xx or a 429 is information about the infrastructure, not
about the resource.

Callers must not read it as "this does not exist". On one server, code that
treated a null response as "user missing from the API" flagged 254 real players
during a rate limit outage. Seven flags deleted a player's scores; the count
reached four.

The same applies to cursors. Advancing a scan cursor after a request that never
arrived marks work as done that was never done.

## Identity

Consumers identify themselves with `User-Agent`. It is both what osu! sees and
what the dashboard groups usage by.

Anything that omits one is recorded as `unknown`, deliberately. Traffic you
cannot attribute is worth seeing.

## What it keeps

Individual requests are only interesting while they are recent: the live feed,
the last hour's shape, a median latency. None of that earns a row on disk per
request. Measured, one such row with its indexes is 111 bytes, so 60 requests a
minute kept 45 days is about 413 MB. That is not a thing to leave on someone's
server for a dashboard.

So there are three tiers:

| | Where | Kept |
|---|---|---|
| Individual requests | Memory | Last 500, plus a latency sample per level |
| Per-minute buckets | Memory | A few hours |
| Per-hour totals | SQLite | 90 days |
| Per-day totals | SQLite | Years |

Hourly and daily are both written on flush rather than daily being derived when
hourly expires, so the long view is complete right up to the current hour.

Two consequences worth knowing.

A restart forgets the feed and the minute-level shape, which is why the hour
view refills rather than being restored.

And latency is always reported over the last hour, whatever range is selected.
A median needs individual values, which sums cannot give you, and an hour of
those is what is held in memory. The mean is taken over the same hour rather
than over the selected range, because a mean spanning a year sitting beside a
median spanning an hour would put two different questions in one column. The
column says which hour it means.

Aggregate rows are about 70 bytes. Ninety days of hourly plus a decade of daily
is roughly 6 MB.
