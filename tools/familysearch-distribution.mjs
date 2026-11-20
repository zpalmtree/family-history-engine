// Explains why FamilySearch withheld an exact image distribution. A bare
// "did not return" hides whether the provider denied access (an access gate,
// never negative evidence) or the request failed for some other reason, so
// each candidate's HTTP status and content type is reported by file name only.

export function distributionAttempt(url, response, error) {
  const name = new URL(url).pathname.split("/").pop();
  if (!response) return { name, error: error ? String(error.message || error) : "no response" };
  return { name, status: response.status(), contentType: response.headers()?.["content-type"] || "" };
}

export function distributionAccessDenied(attempts) {
  return attempts.length > 0 && attempts.every((attempt) => attempt.status === 401 || attempt.status === 403);
}

export function distributionFailureMessage(fileName, attempts) {
  const detail = attempts.map((attempt) => attempt.status === undefined
    ? `${attempt.name}: ${attempt.error}`
    : `${attempt.name}: HTTP ${attempt.status}${attempt.contentType ? ` ${attempt.contentType.split(";")[0]}` : ""}`).join("; ");
  const access = distributionAccessDenied(attempts)
    ? " The provider denied access to the image; record an access gate, not negative evidence."
    : "";
  return `FamilySearch did not return the exact full-resolution distribution for ${fileName} (${detail || "no candidates"}).${access}`;
}
