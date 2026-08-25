const ROUTES = new Set([
  "POST /setup",
  "POST /operator/recover",
  "POST /enroll/invite",
  "POST /enroll/recover",
  "POST /sync",
  "GET /snapshot",
  "POST /hooks/github",
  "POST /hooks/github/setup",
  "GET /members",
  "POST /members/invite",
  "POST /members/cancel",
  "POST /members/recover",
  "POST /members/upgrade",
  "POST /members/suspend",
  "POST /members/reactivate",
  "POST /members/role",
  "GET /tokens",
  "POST /tokens",
  "POST /tokens/revoke",
  "POST /tokens/upgrade",
  "GET /audit",
]);

export function isRoute(method: string, pathname: string): boolean {
  return ROUTES.has(`${method} ${pathname}`);
}
