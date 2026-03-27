export function buildUpstreamUrl(
  destinationPrefix: string,
  incomingPathname: string,
  routePrefix: string,
  search: string,
  stripRouteSegments: string[] = [],
): string {
  const destination = new URL(destinationPrefix);
  const pathWithoutPrefix = removePrefix(incomingPathname, routePrefix);
  destination.pathname = joinPath(destination.pathname, pathWithoutPrefix);
  destination.search = search;
  return stripRouteSegmentsFromUrl(
    destination.toString(),
    stripRouteSegments,
  );
}

function stripRouteSegmentsFromUrl(
  url: string,
  stripRouteSegments: string[],
): string {
  const queryStart = url.indexOf("?");
  const baseUrl = queryStart >= 0 ? url.slice(0, queryStart) : url;
  const query = queryStart >= 0 ? url.slice(queryStart) : "";

  let updatedUrl = baseUrl;
  for (const routeSegment of stripRouteSegments) {
    const normalizedSegment = normalizeStripRouteSegment(routeSegment);
    if (!normalizedSegment || !updatedUrl.endsWith(normalizedSegment)) {
      continue;
    }

    updatedUrl = updatedUrl.slice(0, -normalizedSegment.length);
  }

  return `${updatedUrl}${query}`;
}

function normalizeStripRouteSegment(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) {
    return "";
  }

  return trimmed.startsWith("/") ? trimmed : `/${trimmed}`;
}

function removePrefix(pathname: string, prefix: string): string {
  if (!pathname.toLowerCase().startsWith(prefix.toLowerCase())) {
    return pathname;
  }

  const trimmed = pathname.slice(prefix.length);
  if (!trimmed) {
    return "";
  }

  return trimmed.startsWith("/") ? trimmed : `/${trimmed}`;
}

function joinPath(basePath: string, suffixPath: string): string {
  if (!suffixPath || suffixPath === "/") {
    return normalizePath(basePath);
  }

  const baseSegments = splitPathSegments(basePath);
  const suffixSegments = splitPathSegments(suffixPath);
  const overlap = findPathOverlap(baseSegments, suffixSegments);
  const combinedSegments = [
    ...baseSegments,
    ...suffixSegments.slice(overlap),
  ];

  return combinedSegments.length > 0
    ? `/${combinedSegments.join("/")}`
    : "/";
}

function normalizePath(value: string): string {
  if (!value) {
    return "/";
  }

  return value.startsWith("/") ? value : `/${value}`;
}

function splitPathSegments(value: string): string[] {
  return value.split("/").filter((segment) => segment.length > 0);
}

function findPathOverlap(baseSegments: string[], suffixSegments: string[]): number {
  const maxOverlap = Math.min(baseSegments.length, suffixSegments.length);

  for (let overlap = maxOverlap; overlap > 0; overlap -= 1) {
    let matches = true;

    for (let index = 0; index < overlap; index += 1) {
      if (
        baseSegments[baseSegments.length - overlap + index] !==
        suffixSegments[index]
      ) {
        matches = false;
        break;
      }
    }

    if (matches) {
      return overlap;
    }
  }

  return 0;
}
