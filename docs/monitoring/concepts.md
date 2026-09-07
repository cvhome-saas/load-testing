# Concepts, in plain words

Each term below is one you will meet on the dashboards, with a cvhome example. No prior monitoring knowledge assumed.

**Metric.** A number that is measured again and again over time and stored with a timestamp: "catalog answered 42
requests in the last second", "checkout's database pool has 4 of 5 connections in use". Cheap to store for weeks;
what every graph is drawn from.

**Label.** A name=value pair attached to a metric so it can be sliced: `service_name="catalog"`,
`uri="/api/v2/products/search"`, `status="500"`. "Requests per second by service" means: the request metric, added
up separately for each `service_name` label value. Too many distinct label values (an id per customer, a full URL
per request) make a metric unusably large — *cardinality* — which is why URLs are templated (`/product/{id}`) and
never raw.

**Rate.** Counters only ever go up ("requests since start-up"); a *rate* is how fast they go up, per second, over a
window. `rate(...[5m])` is the average per-second increase over the last five minutes. All the "per second" panels
are rates.

**Log.** A line of text a service writes as it works, with a timestamp, a level (DEBUG, INFO, WARN, ERROR) and, in
cvhome, the `trace_id` of the request that produced it. Where the stack traces are.

**Trace and span.** A trace is the record of one request as it travels through the system; a span is one step of it
(one HTTP call, one SQL statement, one scheduled job run) with a start time, a duration and a status. Spans nest:
the storefront page render contains the call to catalog, which contains the SQL statements. Every span in a trace
shares one `trace_id`. When a metric says "slow", the trace says *where*.

**Service graph.** Drawn from the traces: every "service A called service B" pair, how often, how slow, how often it
failed. This is where a broken dependency shows up as one red edge.

**p50 / p95 / p99 (percentiles).** Sort the response times of the last five minutes; p95 is the value that 95 % of
requests were faster than. Averages hide the slow tail — an average of 200 ms is consistent with 5 % of customers
waiting 3 s — so latency goals are always stated as percentiles. p50 is "the typical request", p95 "the slow ones",
p99 "the worst".

**Histogram / bucket.** How percentiles are computed from metrics: requests are counted in duration buckets
("under 50 ms", "under 100 ms", … "under 10 s"). p95 is read off those counts. The bucket boundaries are chosen to
match the targets (500 ms for storefront reads, 2 s for checkout) so the answer is exact at the boundaries that
matter and approximate between them.

**SLI, SLO, error budget.** An *SLI* (service level indicator) is a measurement of one aspect of "is it working":
"share of requests answered without a 5xx", "share of storefront reads under 500 ms". An *SLO* (objective) is the
target for it: 99.9 %, 95 %. The *error budget* is what the SLO allows to go wrong: at 99.9 % availability, 0.1 % of
requests may fail per month. Spend it slowly and nobody minds; spend it in a day and that is an incident.

**Burn rate.** How fast the error budget is being spent, relative to the rate that would use up exactly the budget
by the end of the month. 1 = on budget. 14.4 over one hour means the whole month's budget would be gone in two days —
the classic "page someone" threshold. The Platform Overview shows burn rates over a fast window (1 h) and a slow one
(6 h); an alert needs both to be high, so a short blip does not page and a slow leak does not hide.

**RED.** Rate, Errors, Duration: the three things to know about anything that serves requests. The Service RED
dashboard is exactly that for one service.

**Saturation / USE.** Utilisation (how busy), Saturation (how much is queued), Errors: the three things to know about
a resource that can run out — request threads, database connections, CPU, heap. When load rises, the first resource
to reach its ceiling is *the* bottleneck; everything downstream just waits for it. The Bottlenecks dashboard puts
every ceiling on one axis.

**Connection pool.** A service keeps a small fixed set of database connections (5 locally, 10 deployed) and requests
borrow one for each statement. When all are borrowed, the next request *waits* ("pending") and, after 30 s, gives
up ("timeout"). A pending count above zero is the pool being the bottleneck: either statements are too slow, or
transactions are held too long, or the pool is too small for the traffic.

**Request threads (Tomcat).** Each Java service handles requests on a fixed pool of threads (200 by default). When all
are busy, new requests queue in the connector and latency climbs without any single request being slow — it is
waiting for a thread. Busy/max above 80 % is the warning.

**Garbage collection (GC).** The JVM periodically pauses to reclaim memory. A little is normal; if more than 5 % of
time is spent paused, or the live data after a collection keeps rising towards the heap limit, the service is either
leaking memory or needs a bigger heap. Heap-after-GC rising steadily through a soak test is the classic leak
signature.

**N+1.** A request that runs one query for a list and then one more per item: 1 + N statements. Invisible at 10 items,
fatal at 1,000. "Statements per request" above 10 for a read endpoint is almost always this.

**Outbox.** How services publish events to each other reliably: the event is written to an `outbox_record` table in
the same transaction as the change, and a scheduler ships it afterwards. If the scheduler falls behind, downstream
services see stale data; if a record is FAILED, its event was never delivered.

**401 vs 403.** 401 Unauthorized: no valid token was presented — expired, wrong issuer, missing. 403 Forbidden: the
token was fine but the caller lacks the permission for that action. A burst of 401s is usually a client with an
expired token; a burst of 403s after a deploy is usually a permission token missing its `case` in
`CustomPermissionEvaluator` (which denies by default, silently).

**4xx vs 5xx.** 4xx means the request could not be served *as asked* — bad input, not found, no permission, rate
limited; the caller must change something. 5xx means we failed. Only 5xx counts against the availability SLO;
4xx are tracked separately because a rise still means something changed.

**Exemplar.** A trace id attached to one histogram sample, so Grafana can jump from a point on a latency graph to a
real trace from that moment.
