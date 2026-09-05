# Coverage: endpoint family → client method → script

Every endpoint family the platform exposes to its three audiences, the client method that calls it and the
scripts that put it under load. A family with no script is a gap; add the script before calling the suite complete.
`selftest.js` calls every method once; `smoke.js` runs every journey once.

## Storefront (shopper, through spg)

| family | client method | scripts |
| --- | --- | --- |
| SSR pages: home, category, product, search, checkout, login, register, content, blog, help | `StorefrontPagesClient.*` | storefront/browse, storefront/search, storefront/soak, shopper/guest-checkout, browser/* |
| catalog: category hierarchy, category by slug, manufacturers, listing (by category, by sku, sorted), product by slug, related, groups, search, suggest | `CatalogClient.categoryHierarchy … suggest` | storefront/browse, storefront/search, storefront/breakpoint, storefront/soak, mixed |
| inventory: availability (GET and bulk POST) | `InventoryClient.availability`, `availabilityQuery` | storefront/browse, storefront/breakpoint |
| content storefront: site, layout, menus, banners, policies, faq, pages, posts, sitemap | `ContentClient.site … sitemap` | storefront/content, storefront/browse |
| merchant: store, current store, languages | `MerchantClient.store`, `currentStore`, `languages` | storefront/content |
| checkout: cart create/get/update/remove line, checkout, order status, countries, zones | `CheckoutClient.createCart … zones` | shopper/cart, shopper/guest-checkout, shopper/inventory-contention, mixed |
| payment: supported payment types | `PaymentClient.supportedPaymentTypes` | shopper/guest-checkout |
| cua: registration, social logins, jwks, authorize → login → token → refresh, me | `CuaClient.*`, `core/pkce.js` | shopper/registration, shopper/account, platform/uaa-public, browser/shopper-auth |
| customer (bearer): info, my orders, my order, history | `CheckoutClient.customerInfo … myOrderHistory` | shopper/account |

## Console (seller and platform admin, through store-core-gateway)

| family | client method | scripts |
| --- | --- | --- |
| gateway sign-in (authorize → uaa form → callback), session check, health | `core/session.js`, `GatewayClient.health` | platform/gateway-login, every admin script (session pool) |
| tenancy stores: list, all, info, get, unique, themes, color themes, per pod | `TenancyClient.listStores … storesPerPod` | admin/store-reads, admin/platform-reads |
| tenancy lifecycle: signup, create, suspend, resume, archive, delete, store pod | `TenancyClient.signup, createStore … storePod` | admin/store-lifecycle, fixtures |
| tenancy org/users/statistics: current, orgs, org stores, members, user accounts, store/org statistic | `TenancyClient.currentUser … orgStatistic` | admin/store-reads, admin/platform-reads |
| billing: plans, current subscription, invoices, entitlement, platform subscriptions/invoices, health | `BillingClient.*` | admin/store-reads, admin/platform-reads |
| pod-registry: list, get | `PodRegistryClient.*` | admin/platform-reads |
| uaa: me, account, admin users, roles, dashboard | `UaaClient.me … adminDashboard` | admin/platform-reads |
| merchant (pod, seller): private store, update, allocates | `MerchantClient.privateStore`, `updateStore`, `allocates` | admin/store-reads, admin/store-lifecycle |
| catalog (pod, seller): product create/definition/update/patch/delete, sku unique, attach/detach category, category create/hierarchy/unique/update/visible/delete, search index rebuild | `CatalogClient.createProduct … rebuildSearchIndex` | admin/catalog-management, fixtures, mixed |
| inventory (pod, seller): set, bulk, delete, reserve/commit/release | `InventoryClient.set … release` | admin/catalog-management, fixtures |
| content (pod, seller): pages list/create/update/publish/bulk/delete, layout get/put/publish, summary | `ContentClient.listPages … summary` | admin/content-management, fixtures |
| checkout (pod, seller): orders list (+filters), order, history | `CheckoutClient.orders`, `order`, `orderHistory` | admin/orders-list, mixed |
| payment (pod, seller): configurations, transactions | `PaymentClient.configurations`, `transactions` | admin/orders-list |
| cua (pod, seller): shoppers | `CuaClient.shoppers` | selftest |

## Platform edges

| family | where | scripts |
| --- | --- | --- |
| uaa public: login settings, context, idps, jwks, openid configuration | `UaaClient` on `uaaEdge()` | platform/uaa-public |
| the fixed-window rate limiter on `/login`, `/oauth2/token`, `/api/v1/public/**` | `platform/rateLimitProbe.js` | platform/rate-limit-probe |
| spg domain lookup (known and unknown hosts) and merchant lookup-by-domain | `platform/spgDomainLookup.js`, `MerchantClient.lookupByDomain` | platform/spg-domain-lookup |
| in-memory gateway sessions | `core/session.js` | platform/gateway-login |

## Browser

| journey | page object | scripts |
| --- | --- | --- |
| home → category → product → add to cart → drawer → checkout → order placed | `pages/storefront.js` | browser/shopper-checkout |
| register → login → account | `pages/storefront.js` | browser/shopper-auth |
| home, search, category, product (read-only, Web Vitals) | `pages/storefront.js` | browser/browse, mixed |
