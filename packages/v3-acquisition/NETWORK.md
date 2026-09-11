# Network routes — first HTTP implementation

Selected deployment (2026-09-08 update): **reuse the host's default Clash**. `attachDefaultClashLanes` adds four fixed loopback listeners and reserved proxy aliases without changing original groups/rules/DNS/TUN. [Real four-IP round-robin verification passed on Mini](../../docs/quality/2026-09-08-default-clash-lanes.md). No second proxy daemon is needed; owning browser/Worker lifecycle integration remains pending.

2026-09-08: fixed-lane admission components now exist in `lane-pool.ts`, `lane-store.ts` and `clash-lanes.ts`. [Current verification and remaining runtime integration](../../docs/quality/2026-09-08-four-egress-pool.md). They do not silently change `createHttpRoute` or activate rotation in existing Workers. Actual four-IP independent-core acceptance is blocked; descriptions below remain accurate for existing fixed HTTP routes.

Shared, credential-free route selection lives in `v3-contracts/src/network.ts`. Runtime implementations live here; site parsing remains in `v3-channels`. No network service or additional deployment is required for this library.

GNC **pages** must now use the separate `CdpRenderedBrowser` / `GncBrowserReader`, not this HTTP route factory. Browser target requests use Chrome's actual configured network; Node fetch is used only for local CDP control. GNC file downloads still use this factory. The browser capability is not added to HttpRoute: these remain separate ports, so HTTP cannot masquerade as rendered-browser support. See [GNC browser setup](../../apps/v3-workers/GNC_WORKER.md).

| Selection | Runtime behavior | Important boundary |
| --- | --- | --- |
| `host`, `managed: false` | Use the caller's already configured `hostClient` unchanged | Missing client fails startup, never silently creates DIRECT. Actual browser/OS host-client wiring is still required. |
| `direct`, `managed: true` | Explicit existing `DirectHttpsTransport` | Does not read proxy environment variables. OS routing/TUN may still affect physical egress. |
| `static-proxy`, `managed: true` | One HTTP(S) CONNECT via a private, fixed proxy URL per transport instance | No global Agent/env mutation, route switching, fallback, proxy pool or retry. |

`createHttpRoute(selection, privateConfig)` is the composition factory, not a workflow. Constructor injection passes the selected route into each reader. Only `http` and `binary` capabilities are currently available; requests for rendered HTML or interactive browser fail capability checks. Those implementations, ScraperAPI and Clash control/rotation remain separate tasks.

## Private assembly example (not a runnable production grant)

```ts
const route = createHttpRoute(
  { routeId: "gnc-lane-a", version: "1", egressId: "gnc-lane-a/1", mode: "static-proxy", managed: true },
  { proxyUrl: privateDeployment.proxyUrl },
);
```

Do not put `proxyUrl`, authentication, cookies or private source grants into Temporal inputs/history or logs. Public metadata contains only IDs/version/mode/management state. Static proxy uses a JS private field for its endpoint. No credentials were read or configured in this implementation turn.

## Fixed proxy behavior

- Target URL remains HTTPS/approved-origin only. `StaticProxyTransport.targetResolution = "proxy"`: page/file callers do **not** resolve the target; CONNECT carries `hostname:443`. TLS SNI/certificate checks and HTTP Host retain the original hostname. The trusted proxy owns target DNS and restrictions on the resolved destination. This does not provide the direct client's DNS/IP-pinning SSRF guarantee.
- Direct and existing unspecified host transports retain local public-address validation/pinning. `transportAddress` selects by the injected transport, not task flags or a failed DNS lookup. Proxy calls must pass an undefined address; outdated callers passing a pin fail before connecting rather than silently losing their pin guarantee.
- Proxy endpoint is trusted deployment configuration and can be a private/loopback listener. Proxy DNS is therefore not subject to the target public-address policy. Proxy operator trust is required; the application cannot prove which upstream IP the operator actually used.
- Proxy authentication goes only to CONNECT; source Cookie/Authorization goes only inside target TLS. Invalid/duplicate/override headers fail before networking. Proxy 407 is `NETWORK.PROXY_AUTH`, distinct from target challenge errors.
- Both HTTP and HTTPS CONNECT endpoints are implemented; SOCKS is explicitly unsupported. For credentials on a remote proxy, require HTTPS. Plain HTTP credential transmission is permitted only to loopback endpoints, not arbitrary LAN/public proxies.
- Target TLS and HTTPS proxy TLS verification remain enabled; no bypass flag or test CA in production configuration. Native Node request CONNECT events and TLS socket wrapping follow the [Node HTTP API](https://nodejs.org/api/http.html#event-connect_1) and [TLS API](https://nodejs.org/api/tls.html#tlsconnectoptions-callback).
- Each call owns its own connection, agent and 30-second deadline, closed on response close/cancellation/failure. It cannot close other instances' connections. No full-Brand socket/session pool yet.

## Clash compatibility boundary

A preconfigured HTTP/mixed listener can be used as the proxy endpoint. Hostname CONNECT lets Clash apply hostname rules without a crawler DNS adapter, controller DNS queries, fake-IP exceptions or system DNS changes. This does **not** configure a Clash group, validate upstream isolation or prove an exit IP. No controller API is called. A fixed proxy URL is not necessarily a fixed upstream exit, especially with a shared selector. Domain rules for page and CDN hosts may differ. Actual exit/session isolation, health gating and authorized rotation remain pending; do not assume this change implements them.

Use a new route configuration version for this changed proxy resolution policy; do not rewrite published input/evidence identities or restart existing workers onto it implicitly. The Mac mini probe uses `2-domain-connect`. The earlier real-DNS/dedicated-listener proposal is superseded by [the revised decision](../../docs/spark/2026-09-07-clash-fixed-lane-design.md).

`host` mode is a port for an already configured host HTTP client. The generic Node client is not presumed to inherit macOS/Windows browser settings. Browser unmanaged mode must use the browser-owning runtime's real client; this HTTP factory does not manufacture one.

## Verification / remaining integration

Run acquisition unit tests, existing HTTPS integration, and channels proxy integration **on Mac mini**. Proxy tests forward hostname CONNECTs to loopback TLS fixtures and inject trust only in the test module; direct HTTPS tests retain public-IP pin fixtures. They prove CONNECT/TLS behavior, not real provider reachability or target geolocation. HTTPS proxy endpoint code remains without an end-to-end HTTPS-proxy fixture; target TLS is exercised through HTTP CONNECT.

Next: immutable page publication to R2 + reliable result registration; independent Temporal Worker wiring; approved real-source/provider smoke test; concrete browser/ScraperAPI and host runtime bindings; route health gating before polling and shared resource leases where needed. Static route IDs are configuration identities, not proof of fixed physical egress.
