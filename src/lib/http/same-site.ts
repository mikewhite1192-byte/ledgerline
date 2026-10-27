// A state-changing POST from another site is refused. The browser sets Sec-Fetch-Site itself, so
// the check holds behind CloudFront; a request without the header (a script, a test) passes.
export function isCrossSite(request: Request): boolean {
  const site = request.headers.get("sec-fetch-site");
  return site !== null && site !== "same-origin";
}
