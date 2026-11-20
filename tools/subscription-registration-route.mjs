// A browsed frame has no search-result parent. Accept it only after a visual
// review has bound the exact provider frame to the canonical target.
export function verifiedFindmypastBrowseRoute(target, route) {
  const binding = target?.browseBinding;
  if (!binding?.viewerId || !binding?.verifiedAt || !binding?.verificationBasis
      || !target?.peopleVerifiedAt || !target?.peopleVerificationBasis) return false;
  try {
    const url = new URL(route.sourceUrl);
    return url.protocol === "https:"
      && ["search.findmypast.com", "search.findmypast.co.uk"].includes(url.hostname)
      && !url.username && !url.password && !url.port
      && ["/record", "/record/browse"].includes(url.pathname)
      && url.searchParams.getAll("id").length === 1
      && url.searchParams.get("id").toLowerCase() === binding.viewerId.toLowerCase();
  } catch { return false; }
}

export function subscriptionRegistrationRouteId(target, requestedId) {
  if (requestedId) return requestedId;
  const routes = (target?.routes || []).filter((route) =>
    ((route.sourceQueue === "subscription-records" && ["Ancestry", "Findmypast"].includes(route.provider))
      || (route.sourceQueue === "archion-access" && route.provider === "Archion"))
    && ["pending-subscription", "ready-subscription-capture", "acquired", "published"].includes(route.status));
  if (routes.length === 1) return routes[0].id;
  throw new Error("Canonical subscription registration requires one eligible route or explicit --route.");
}

export function explicitSubscriptionProjectionRoute(target, projection) {
  const routes = (target?.routes || []).filter((route) => route.id === projection.routeId);
  const route = routes.length === 1 ? routes[0] : null;
  const validPair = route && ((["Ancestry", "Findmypast"].includes(route.provider)
    && route.sourceQueue === "subscription-records")
    || (route.provider === "Archion" && route.sourceQueue === "archion-access"));
  if (!projection.routeId || !route || route.targetId !== target.id
      || route.provider !== projection.provider || !validPair) {
    throw new Error(`Invalid canonical subscription route binding: ${projection.id}/${projection.routeId}`);
  }
  return route;
}
